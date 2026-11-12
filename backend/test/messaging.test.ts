import { describe, expect, it } from 'vitest';

import { FakeSmsProvider, type SmsProvider } from '../src/messaging/provider.js';
import {
  MessagingService,
  normalizeAustralianMobile,
  type MessageOperation,
  type MessagingServiceOptions,
} from '../src/messaging/service.js';
import { InMemoryMessageStore, type MessageStore } from '../src/messaging/store.js';

function makeService(options: Partial<MessagingServiceOptions> = {}) {
  const provider = (options.provider as FakeSmsProvider | undefined) ?? new FakeSmsProvider();
  const store = options.store ?? new InMemoryMessageStore();
  const service = new MessagingService({
    provider,
    hmacSecret: 'test-secret',
    smsEnabled: true,
    store,
    ...options,
  });
  return { provider, store, service };
}

async function sendReviewed(service: MessagingService, params: Omit<Parameters<MessagingService['sendDraft']>[0], 'consent'>) {
  const draft = await service.getDraft(params.draftId);
  if (draft?.status === 'prepared') {
    await service.recordReview(draft.draftId, draft.callId, draft.version, { speechId: 'test-speech', completedAt: draft.createdAt, callerSequence: 1 });
  }
  return service.sendDraft({ ...params, consent: { messageId: 'test-consent', sequence: 2, version: params.expectedVersion } });
}

class FailingClaimStore extends InMemoryMessageStore {
  override async reserveSend(): Promise<never> {
    throw new Error('database unavailable');
  }
}

function seededOperation(draftId: string, now: number): MessageOperation {
  return {
    operationId: 'op-crashed',
    draftId,
    callId: 'call-crash',
    purpose: 'booking',
    recipient: '+61412345678',
    recipientHmac: 'test-hmac',
    consent: { messageId: 'test-message', sequence: 2, version: 1 },
    limitKey: 'call-crash:booking',
    status: 'sending',
    createdAt: now,
    updatedAt: now,
  };
}

describe('MessagingService', () => {
  it('lets only one simultaneous call reserve the last daily slot', async () => {
    const { service, provider } = makeService({ dailyLimit: 1 });
    const a = await service.createDraft({ callId: 'concurrent-a', purpose: 'booking', phone: '0412345678', version: 1 });
    const b = await service.createDraft({ callId: 'concurrent-b', purpose: 'booking', phone: '0412345678', version: 1 });
    if (!a.success || !b.success) throw new Error('draft setup failed');
    const result = await Promise.all([
      sendReviewed(service, { draftId: a.draft.draftId, callId: a.draft.callId, expectedVersion: 1 }),
      sendReviewed(service, { draftId: b.draft.draftId, callId: b.draft.callId, expectedVersion: 1 }),
    ]);
    expect(result.filter((item) => item.success)).toHaveLength(1);
    expect(provider.sent).toHaveLength(1);
  });

  it('rejects a cancelled draft and refuses cancellation after reservation', async () => {
    const { service, provider } = makeService();
    const a = await service.createDraft({ callId: 'cancel-first', purpose: 'booking', phone: '0412345678', version: 1 });
    const b = await service.createDraft({ callId: 'send-first', purpose: 'booking', phone: '0412345679', version: 1 });
    if (!a.success || !b.success) throw new Error('draft setup failed');
    expect((await service.cancelDraft(a.draft.draftId, a.draft.callId)).cancelled).toBe(true);
    expect((await sendReviewed(service, { draftId: a.draft.draftId, callId: a.draft.callId, expectedVersion: 1 })).success).toBe(false);
    expect((await sendReviewed(service, { draftId: b.draft.draftId, callId: b.draft.callId, expectedVersion: 1 })).success).toBe(true);
    expect((await service.cancelDraft(b.draft.draftId, b.draft.callId)).alreadySent).toBe(true);
    expect(provider.sent).toHaveLength(1);
  });

  it('keeps a delivery callback received before the send response', async () => {
    let service: MessagingService;
    const provider: SmsProvider = { name: 'fake-early', send: async () => {
      await service.handleProviderCallback({ messageId: 'early-1', status: 'delivered' });
      return { status: 'accepted', providerMessageId: 'early-1' };
    } };
    ({ service } = makeService({ provider }));
    const draft = await service.createDraft({ callId: 'early-call', purpose: 'booking', phone: '0412345678', version: 1 });
    if (!draft.success) throw new Error('draft setup failed');
    const result = await sendReviewed(service, { draftId: draft.draft.draftId, callId: 'early-call', expectedVersion: 1 });
    expect(result.operation?.status).toBe('delivered');
    await service.handleProviderCallback({ messageId: 'early-1', status: 'failed' });
    expect((await service.getOperation(result.operation!.operationId))?.status).toBe('delivered');
  });

  it('requires a later caller reference after a stored review', async () => {
    const { service, provider } = makeService();
    const draft = await service.createDraft({ callId: 'review-call', purpose: 'booking', phone: '0412345678', version: 1 });
    if (!draft.success) throw new Error('draft setup failed');
    const args = { draftId: draft.draft.draftId, callId: 'review-call', expectedVersion: 1, consent: { messageId: 'turn-1', sequence: 1, version: 1 } };
    expect((await service.sendDraft(args)).success).toBe(false);
    expect(await service.recordReview(args.draftId, args.callId, 1, { speechId: 'speech-1', completedAt: draft.draft.createdAt, callerSequence: 1 })).toBe(true);
    expect((await service.sendDraft(args)).success).toBe(false);
    expect(provider.sent).toHaveLength(0);
    expect((await service.sendDraft({ ...args, consent: { messageId: 'turn-2', sequence: 2, version: 1 } })).success).toBe(true);
    expect(provider.sent).toHaveLength(1);
  });
  it('normalizes valid Australian mobile numbers and rejects invalid numbers', () => {
    expect(normalizeAustralianMobile('0412345678')).toBe('+61412345678');
    expect(normalizeAustralianMobile('+61412345678')).toBe('+61412345678');
    expect(normalizeAustralianMobile('61412345678')).toBe('+61412345678');
    expect(normalizeAustralianMobile('0412 345 678')).toBe('+61412345678');
    expect(normalizeAustralianMobile('0412-345-678')).toBe('+61412345678');

    // Invalid numbers
    expect(normalizeAustralianMobile('0387878741')).toBeNull(); // Melbourne landline
    expect(normalizeAustralianMobile('0298765432')).toBeNull(); // Sydney landline
    expect(normalizeAustralianMobile('0412345')).toBeNull(); // Too short
    expect(normalizeAustralianMobile('0512345678')).toBeNull(); // Invalid prefix
    expect(normalizeAustralianMobile('041234567890')).toBeNull(); // Too long
    expect(normalizeAustralianMobile('call me')).toBeNull();
  });

  it('requires a durable store before enabling live sending', () => {
    expect(
      () =>
        new MessagingService({
          provider: new FakeSmsProvider(),
          hmacSecret: 'test-secret',
          smsEnabled: true,
        }),
    ).toThrow('SMS_ENABLED requires a durable MessageStore');
  });

  it('rejects sending a draft with the wrong call ID or wrong draft ID', async () => {
    const { service } = makeService();

    const draftRes = await service.createDraft({
      callId: 'call-owner',
      purpose: 'booking',
      phone: '0412345678',
      version: 1,
    });
    expect(draftRes.success).toBe(true);
    if (!draftRes.success) return;

    // Wrong call ID
    const wrongCall = await sendReviewed(service, {
      draftId: draftRes.draft.draftId,
      callId: 'call-intruder',
      expectedVersion: 1,
    });
    expect(wrongCall.success).toBe(false);
    expect(wrongCall.status).toBe(404);

    // Nonexistent draft
    const wrongDraft = await sendReviewed(service, {
      draftId: 'draft-nonexistent',
      callId: 'call-owner',
      expectedVersion: 1,
    });
    expect(wrongDraft.success).toBe(false);
    expect(wrongDraft.status).toBe(404);
  });

  it('rejects sending when draft is cancelled (refusal) or version is stale (correction)', async () => {
    const { service } = makeService();

    const draftRes = await service.createDraft({
      callId: 'call-cancel',
      purpose: 'maps',
      phone: '0412345678',
      version: 1,
    });
    if (!draftRes.success) return;

    // Wrong call cannot cancel the draft.
    const wrongCallCancel = await service.cancelDraft(draftRes.draft.draftId, 'call-other');
    expect(wrongCallCancel.cancelled).toBe(false);

    // Caller refuses / cancels draft
    const cancel = await service.cancelDraft(draftRes.draft.draftId, 'call-cancel');
    expect(cancel.cancelled).toBe(true);
    const cancelSend = await sendReviewed(service, {
      draftId: draftRes.draft.draftId,
      callId: 'call-cancel',
      expectedVersion: 1,
    });
    expect(cancelSend.success).toBe(false);
    expect(cancelSend.status).toBe(409);
    expect(cancelSend.error).toContain('cancelled');

    // Stale version (request changed before send)
    const draft2 = await service.createDraft({
      callId: 'call-stale',
      purpose: 'booking',
      phone: '0412345678',
      version: 1,
    });
    if (!draft2.success) return;

    const staleSend = await sendReviewed(service, {
      draftId: draft2.draft.draftId,
      callId: 'call-stale',
      expectedVersion: 2, // version mismatch
    });
    expect(staleSend.success).toBe(false);
    expect(staleSend.status).toBe(409);
    expect(staleSend.error).toContain('stale');
  });

  it('handles duplicate tool / HTTP calls idempotently without duplicate SMS', async () => {
    const { provider, service } = makeService();

    const draftRes = await service.createDraft({
      callId: 'call-dup',
      purpose: 'booking',
      phone: '0412345678',
      version: 1,
    });
    if (!draftRes.success) return;

    // First send
    const first = await sendReviewed(service, {
      draftId: draftRes.draft.draftId,
      callId: 'call-dup',
      expectedVersion: 1,
    });
    expect(first.success).toBe(true);
    expect(first.status).toBe(202);
    expect(provider.sent).toHaveLength(1);

    // Duplicate send of same draft
    const second = await sendReviewed(service, {
      draftId: draftRes.draft.draftId,
      callId: 'call-dup',
      expectedVersion: 1,
    });
    expect(second.success).toBe(true);
    expect(second.status).toBe(200); // Replay
    expect(provider.sent).toHaveLength(1); // No second message

    // A submitted draft cannot be cancelled and cannot produce another send.
    const cancel = await service.cancelDraft(draftRes.draft.draftId, 'call-dup');
    expect(cancel.cancelled).toBe(false);
    expect(cancel.alreadySent).toBe(true);
  });

  it('claims one operation when two send requests race', async () => {
    const { provider, service } = makeService();

    const draftRes = await service.createDraft({
      callId: 'call-race',
      purpose: 'booking',
      phone: '0412345678',
      version: 1,
    });
    if (!draftRes.success) return;

    const [first, second] = await Promise.all([
      sendReviewed(service, { draftId: draftRes.draft.draftId, callId: 'call-race', expectedVersion: 1 }),
      sendReviewed(service, { draftId: draftRes.draft.draftId, callId: 'call-race', expectedVersion: 1 }),
    ]);

    expect(provider.sent).toHaveLength(1);
    expect(first.operation?.operationId).toBeDefined();
    expect(second.operation?.operationId).toBe(first.operation?.operationId);
    expect(first.success || second.success).toBe(true);
  });

  it('enforces purpose, recipient, cooldown, and daily limits', async () => {
    let nowMs = 1_000_000;
    const { service } = makeService({
      dailyLimit: 2,
      cooldownSeconds: 60,
      clock: () => nowMs,
    });

    // 1. One send per purpose per call
    const d1 = await service.createDraft({ callId: 'call-limits', purpose: 'booking', phone: '0412345678', version: 1 });
    if (!d1.success) return;
    await sendReviewed(service, { draftId: d1.draft.draftId, callId: 'call-limits', expectedVersion: 1 });

    const d2 = await service.createDraft({ callId: 'call-limits', purpose: 'booking', phone: '0412345679', version: 2 });
    if (!d2.success) return;
    const secondBooking = await sendReviewed(service, { draftId: d2.draft.draftId, callId: 'call-limits', expectedVersion: 2 });
    expect(secondBooking.success).toBe(false);
    expect(secondBooking.status).toBe(429);
    expect(secondBooking.error).toContain('Only one booking SMS is permitted');

    // 2. Recipient cooldown
    nowMs += 30_000; // 30 seconds later (under 60s cooldown)
    const d3 = await service.createDraft({ callId: 'call-other', purpose: 'maps', phone: '0412345678', version: 1 });
    if (!d3.success) return;
    const cooldownSend = await sendReviewed(service, { draftId: d3.draft.draftId, callId: 'call-other', expectedVersion: 1 });
    expect(cooldownSend.success).toBe(false);
    expect(cooldownSend.status).toBe(429);
    expect(cooldownSend.error).toContain('Please wait 60 seconds');

    // Advance past cooldown and reach daily limit
    nowMs += 40_000; // now 70 seconds later
    const cooldownPass = await sendReviewed(service, { draftId: d3.draft.draftId, callId: 'call-other', expectedVersion: 1 });
    expect(cooldownPass.success).toBe(true);

    // 3. Daily limit reached (dailyLimit is 2)
    const d4 = await service.createDraft({ callId: 'call-third', purpose: 'maps', phone: '0412345670', version: 1 });
    if (!d4.success) return;
    const dailySend = await sendReviewed(service, { draftId: d4.draft.draftId, callId: 'call-third', expectedVersion: 1 });
    expect(dailySend.success).toBe(false);
    expect(dailySend.status).toBe(429);
    expect(dailySend.error).toContain('Daily message sending limit reached');
  });

  it('simulates web demo sends and never dispatches real network SMS for web callers', async () => {
    const { provider, service } = makeService();

    const draftRes = await service.createDraft({
      callId: 'web-call-1',
      purpose: 'booking',
      phone: '0412345678',
      version: 1,
    });
    if (!draftRes.success) return;

    const res = await sendReviewed(service, {
      draftId: draftRes.draft.draftId,
      callId: 'web-call-1',
      expectedVersion: 1,
      channel: 'web',
    });
    expect(res.success).toBe(true);
    expect(res.operation?.status).toBe('simulated');
    expect(provider.sent).toHaveLength(0); // No real SMS dispatched
  });

  it('updates operation status on provider delivery callbacks and prevents downgrades', async () => {
    const { service } = makeService();

    const draftRes = await service.createDraft({
      callId: 'call-cb',
      purpose: 'maps',
      phone: '0412345678',
      version: 1,
    });
    if (!draftRes.success) return;

    const sendRes = await sendReviewed(service, {
      draftId: draftRes.draft.draftId,
      callId: 'call-cb',
      expectedVersion: 1,
    });
    expect(sendRes.success).toBe(true);
    const msgId = sendRes.operation?.providerMessageId!;
    expect(msgId).toBeDefined();

    // Provider reports delivery
    const updated = await service.handleProviderCallback({ messageId: msgId, status: 'delivered' });
    expect(updated).toBe(true);
    expect((await service.getOperation(sendRes.operation!.operationId))?.status).toBe('delivered');

    // Out-of-order or late failure callback cannot downgrade delivered status
    await service.handleProviderCallback({ messageId: msgId, status: 'failed' });
    expect((await service.getOperation(sendRes.operation!.operationId))?.status).toBe('delivered');
  });

  it('recovers a crashed sending operation as unknown and never re-sends it', async () => {
    const now = 1_000_000;
    const store = new InMemoryMessageStore();
    const { provider, service } = makeService({
      store,
      clock: () => now,
      providerTimeoutMs: 5_000,
    });

    const draftRes = await service.createDraft({
      callId: 'call-crash',
      purpose: 'booking',
      phone: '0412345678',
      version: 1,
    });
    if (!draftRes.success) return;
    await store.claimOperation(seededOperation(draftRes.draft.draftId, now - 60_000));

    const replay = await sendReviewed(service, {
      draftId: draftRes.draft.draftId,
      callId: 'call-crash',
      expectedVersion: 1,
    });
    expect(replay.success).toBe(false);
    expect(replay.operation?.status).toBe('unknown');
    expect(replay.error).toContain('Do not retry');
    expect(provider.sent).toHaveLength(0);

    const secondReplay = await sendReviewed(service, {
      draftId: draftRes.draft.draftId,
      callId: 'call-crash',
      expectedVersion: 1,
    });
    expect(secondReplay.success).toBe(false);
    expect(secondReplay.operation?.status).toBe('unknown');
    expect(provider.sent).toHaveLength(0);
  });

  it('returns a live in-flight operation without starting a second send', async () => {
    const now = 1_000_000;
    const store = new InMemoryMessageStore();
    const { provider, service } = makeService({
      store,
      clock: () => now,
      providerTimeoutMs: 5_000,
    });

    const draftRes = await service.createDraft({
      callId: 'call-crash',
      purpose: 'booking',
      phone: '0412345678',
      version: 1,
    });
    if (!draftRes.success) return;
    await store.claimOperation(seededOperation(draftRes.draft.draftId, now));

    const replay = await sendReviewed(service, {
      draftId: draftRes.draft.draftId,
      callId: 'call-crash',
      expectedVersion: 1,
    });
    expect(replay.success).toBe(true);
    expect(replay.status).toBe(202);
    expect(replay.operation?.status).toBe('sending');
    expect(provider.sent).toHaveLength(0);
  });

  it('marks a provider timeout as unknown rather than failed', async () => {
    const slowProvider: SmsProvider = {
      name: 'slow',
      send: () => new Promise(() => undefined),
    };
    const { service } = makeService({ provider: slowProvider, providerTimeoutMs: 20 });

    const draftRes = await service.createDraft({
      callId: 'call-timeout',
      purpose: 'booking',
      phone: '0412345678',
      version: 1,
    });
    if (!draftRes.success) return;

    const res = await sendReviewed(service, {
      draftId: draftRes.draft.draftId,
      callId: 'call-timeout',
      expectedVersion: 1,
    });
    expect(res.success).toBe(false);
    expect(res.status).toBe(504);
    expect(res.operation?.status).toBe('unknown');
  });

  it('fails closed without a provider send when durable storage is unavailable', async () => {
    const store: MessageStore = new FailingClaimStore();
    const { provider, service } = makeService({ store });

    const draftRes = await service.createDraft({
      callId: 'call-db-down',
      purpose: 'booking',
      phone: '0412345678',
      version: 1,
    });
    if (!draftRes.success) return;

    await expect(
      sendReviewed(service, { draftId: draftRes.draft.draftId, callId: 'call-db-down', expectedVersion: 1 }),
    ).rejects.toThrow('database unavailable');
    expect(provider.sent).toHaveLength(0);
  });
});
