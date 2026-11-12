import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { Database } from '../src/api/db.js';
import { FakeSmsProvider } from '../src/messaging/provider.js';
import { MessagingService } from '../src/messaging/service.js';
import type { Reservation } from '../src/messaging/store.js';

const uri = process.env.TEST_MONGO_URI;
const isolated = process.env.TEST_MONGO_ISOLATED === 'true';

describe.skipIf(!uri || !isolated)('SMS MongoDB transaction', () => {
  it('enforces shared limits and cancellation across two database clients', async () => {
    const name = `chloe_review_fix_test_${randomUUID().replaceAll('-', '')}`;
    const owner = randomUUID();
    const client = new MongoClient(uri!);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    class TestDatabase extends Database {
      override async reserveSend(value: Reservation) {
        if (arrivals < 2) {
          arrivals += 1;
          if (arrivals === 2) release();
          await barrier;
        }
        return super.reserveSend(value);
      }
    }
    const first = new TestDatabase(uri, name, pino({ level: 'silent' }));
    const second = new TestDatabase(uri, name, pino({ level: 'silent' }));
    await client.connect();
    const db = client.db(name);
    try {
      expect(await db.listCollections().toArray()).toHaveLength(0);
      await db.collection('test_owner').insertOne({ owner });
      await first.connect();
      await second.connect();
      expect(first.connected && second.connected).toBe(true);
      const provider = new FakeSmsProvider();
      const one = new MessagingService({ provider, store: first, smsEnabled: true, hmacSecret: 'test', dailyLimit: 1 });
      const two = new MessagingService({ provider, store: second, smsEnabled: true, hmacSecret: 'test', dailyLimit: 1 });
      const prepare = async (service: MessagingService, callId: string, phone: string) => {
        const result = await service.createDraft({ callId, phone, purpose: 'booking', version: 1 });
        if (!result.success) throw new Error('Test draft failed');
        expect(await service.recordReview(result.draft.draftId, callId, 1, { speechId: 'test-speech', completedAt: Date.now(), callerSequence: 1 })).toBe(true);
        return { draftId: result.draft.draftId, callId, expectedVersion: 1, consent: { messageId: 'test-turn', sequence: 2, version: 1 } };
      };
      const a = await prepare(one, 'db-a', '0412345678');
      const b = await prepare(two, 'db-b', '0412345678');
      const results = await Promise.all([one.sendDraft(a), two.sendDraft(b)]);
      expect(results.filter((result) => result.success)).toHaveLength(1);
      expect(provider.sent).toHaveLength(1);
      const cancelled = await prepare(one, 'db-cancel', '0412345679');
      expect((await two.cancelDraft(cancelled.draftId, cancelled.callId)).cancelled).toBe(true);
      expect((await one.sendDraft(cancelled)).success).toBe(false);
      const submitted = results.find((result) => result.success)!;
      expect((await two.cancelDraft(submitted.operation!.draftId, submitted.operation!.callId)).alreadySent).toBe(true);
      expect(provider.sent).toHaveLength(1);

      const earlyProvider = { name: 'fake', send: async () => {
        await two.handleProviderCallback({ messageId: 'early-db-message', status: 'delivered' });
        return { status: 'accepted' as const, providerMessageId: 'early-db-message' };
      } };
      const early = new MessagingService({ provider: earlyProvider, store: first, smsEnabled: true, hmacSecret: 'test', dailyLimit: 20 });
      const request = await prepare(early, 'db-early', '0412345670');
      const outcome = await early.sendDraft(request);
      expect(outcome.operation?.status).toBe('delivered');
      await two.handleProviderCallback({ messageId: 'early-db-message', status: 'failed' });
      expect((await two.getOperation(outcome.operation!.operationId))?.status).toBe('delivered');

      // Approval survives changing service instances. Completion through two
      // database connections must still make only one provider request.
      const deferredOne = new MessagingService({ provider, store: first, smsEnabled: true, hmacSecret: 'test', dailyLimit: 20 });
      const deferredTwo = new MessagingService({ provider, store: second, smsEnabled: true, hmacSecret: 'test', dailyLimit: 20 });
      const deferred = await prepare(deferredOne, 'db-after-call', '0412345671');
      expect(await deferredOne.approveAfterCall({ ...deferred, channel: 'phone' })).toBe(true);
      expect((await second.getDraft(deferred.draftId))?.consent).toEqual(deferred.consent);
      expect(provider.sent).toHaveLength(1);
      expect((await deferredTwo.sendDraft({ ...deferred, channel: 'phone' })).status).toBe(409);
      await Promise.all([
        deferredOne.completeCall(deferred.callId, deferred.draftId),
        deferredTwo.completeCall(deferred.callId, deferred.draftId),
      ]);
      expect(provider.sent).toHaveLength(2);
      expect((await second.getOperationByDraft(deferred.draftId))?.status).toBe('accepted');

      const withdrawn = await prepare(deferredOne, 'db-withdrawn', '0412345672');
      expect(await deferredOne.approveAfterCall({ ...withdrawn, channel: 'phone' })).toBe(true);
      expect((await deferredTwo.cancelDraft(withdrawn.draftId, withdrawn.callId)).cancelled).toBe(true);
      await deferredOne.completeCall(withdrawn.callId, withdrawn.draftId);
      expect(provider.sent).toHaveLength(2);
    } finally {
      await first.close();
      await second.close();
      if (name.startsWith('chloe_review_fix_test_') && await db.collection('test_owner').findOne({ owner })) await db.dropDatabase();
      await client.close();
    }
  }, 30_000);
});
