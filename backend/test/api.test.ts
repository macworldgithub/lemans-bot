import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { EventReporter } from '../src/agent/reporter.js';
import { readMessageResult } from '../src/messaging/schema.js';
import { InMemoryMessageStore } from '../src/messaging/store.js';
import { createApp } from '../src/api/app.js';
import { Database } from '../src/api/db.js';
import { CallStore } from '../src/api/store.js';
import { config, type Config } from '../src/config.js';
import { FakeSmsProvider } from '../src/messaging/provider.js';
import { MessagingService } from '../src/messaging/service.js';

function setup(overrides?: Partial<Config>, messagingService?: MessagingService) {
  const logger = pino({ level: 'silent' });
  const store = new CallStore();
  const db = new Database(undefined, 'test', logger);
  const cfg = { ...config, ...overrides };
  return { store, db, app: createApp({ config: cfg, store, db, logger, messagingService }) };
}

const decode = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

describe('API', () => {
  it('issues a room token that dispatches the receptionist agent', async () => {
    const { app } = setup();
    const res = await request(app).post('/api/token').expect(200);
    expect(res.body.serverUrl).toBe(config.LIVEKIT_URL);
    const claims = decode(res.body.participantToken);
    expect(claims.video.room).toBe(res.body.roomName);
    expect(claims.video.canPublishData).toBe(false);
    expect(claims.roomConfig.agents[0].agentName).toBe(config.AGENT_NAME);
  });

  it('rate limits token minting per IP', async () => {
    const { app } = setup();
    for (let i = 0; i < 10; i++) await request(app).post('/api/token').expect(200);
    await request(app).post('/api/token').expect(429);
  });

  it('rejects agent events without the shared secret', async () => {
    const { app } = setup();
    await request(app).post('/internal/events').send({ type: 'call-started' }).expect(401);
    await request(app).post('/internal/events').set('x-internal-secret', 'wrong-secret-value').send({}).expect(401);
  });

  it('applies agent events and exposes them on /api/calls', async () => {
    const { app } = setup();
    const post = (body: object) =>
      request(app).post('/internal/events').set('x-internal-secret', config.INTERNAL_API_SECRET).send(body).expect(204);
    await post({ type: 'call-started', callId: 'web-1', source: 'web', startedAt: 1 });
    await post({
      type: 'transcript',
      event: { callId: 'web-1', id: 'u0', role: 'user', kind: 'final', text: 'hello', ts: 2 },
    });
    const res = await request(app).get('/api/calls').expect(200);
    expect(res.body.calls[0]).toMatchObject({ callId: 'web-1', lines: [{ text: 'hello', final: true }] });
  });

  it('protects private read routes when staff access key is configured', async () => {
    const { app } = setup({ STAFF_API_KEY: 'staff-secret-key-123' });
    await request(app).get('/api/calls').expect(401);
    await request(app).get('/api/leads').expect(401);
    await request(app).get('/api/monitor/stream').expect(401);

    await request(app).get('/api/calls').set('x-staff-key', 'staff-secret-key-123').expect(200);
    await request(app).get('/api/leads').set('authorization', 'Bearer staff-secret-key-123').expect(200);
  });

  it('disables private read routes in production when no staff access key is configured', async () => {
    const { app } = setup({ NODE_ENV: 'production', STAFF_API_KEY: undefined });
    const res = await request(app).get('/api/calls').expect(403);
    expect(res.body.error).toContain('Private route disabled in production');
  });

  it('rejects oversized payload bodies exceeding the 64kb limit', async () => {
    const { app } = setup();
    const largeText = 'a'.repeat(70 * 1024);
    await request(app)
      .post('/internal/events')
      .set('x-internal-secret', config.INTERNAL_API_SECRET)
      .send({ type: 'call-started', callId: largeText, source: 'web', startedAt: 1 })
      .expect(413);
  });

  describe('leads', () => {
    const lead = {
      callId: 'phone-1',
      operationId: 'op-001',
      name: 'Jake',
      phone: '0412345678',
      eventType: 'kids party',
      createdAt: 5,
    };

    /** Runs the API on a free port so the agent's real EventReporter can talk to it. */
    async function serve(db: Database) {
      const logger = pino({ level: 'silent' });
      const store = new CallStore();
      const server = createApp({ config, store, db, logger }).listen(0);
      await new Promise((resolve) => server.once('listening', resolve));
      const { port } = server.address() as AddressInfo;
      return { store, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
    }

    it('confirms a saved lead even when the API never saw the call start', async () => {
      const api = await serve(new Database(undefined, 'test', pino({ level: 'silent' })));
      const events: unknown[] = [];
      api.store.on('event', (e) => events.push(e));
      await new EventReporter(api.url, config.INTERNAL_API_SECRET).saveLead(lead);
      expect(events).toEqual([{ type: 'lead-saved', lead }]);
      await api.close();
    });

    it('fails loudly when the database is down, so Chloe does not claim it was saved', async () => {
      // A URI with no connection: the API is meant to store leads but cannot.
      const api = await serve(new Database('mongodb://127.0.0.1:1', 'test', pino({ level: 'silent' })));
      await expect(new EventReporter(api.url, config.INTERNAL_API_SECRET).saveLead(lead)).rejects.toThrow('503');
      await api.close();
    });

    it('fails when the API is not reachable', async () => {
      await expect(new EventReporter('http://127.0.0.1:1', config.INTERNAL_API_SECRET).saveLead(lead)).rejects.toThrow();
    });

    it('rejects leads without the secret or with missing fields', async () => {
      const { app } = setup();
      await request(app).post('/internal/leads').send(lead).expect(401);
      await request(app)
        .post('/internal/leads')
        .set('x-internal-secret', config.INTERNAL_API_SECRET)
        .send({ callId: 'x' })
        .expect(400);
    });

    it('enforces durable database in production', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const db = new Database(undefined, 'prod-test', pino({ level: 'silent' }));
        await expect(db.saveLead(lead)).rejects.toThrow('Durable database storage required in production');
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });
  });

  it('rejects malformed events with strict validation', async () => {
    const { app } = setup();
    await request(app)
      .post('/internal/events')
      .set('x-internal-secret', config.INTERNAL_API_SECRET)
      .send({ type: 'nope' })
      .expect(400);

    // Missing required field in known type
    await request(app)
      .post('/internal/events')
      .set('x-internal-secret', config.INTERNAL_API_SECRET)
      .send({ type: 'call-started', source: 'web' })
      .expect(400);
  });

  describe('messaging', () => {
    const draft = {
      callId: 'phone-sms-1',
      purpose: 'booking',
      phone: '0412345678',
      version: 2,
    };

    function messaging() {
      return new MessagingService({
        provider: new FakeSmsProvider(),
        hmacSecret: 'test-hmac-secret',
        smsEnabled: false,
      });
    }

    it('requires the internal secret for draft and send routes', async () => {
      const { app } = setup({}, messaging());
      await request(app).post('/internal/messages/drafts').send(draft).expect(401);
      await request(app)
        .post('/internal/messages/drafts')
        .set('x-internal-secret', config.INTERNAL_API_SECRET)
        .send(draft)
        .expect(201);
    });

    it('requires a stored readback and later consent for a send', async () => {
      const { app } = setup({}, messaging());
      const auth = { 'x-internal-secret': config.INTERNAL_API_SECRET };
      const created = await request(app).post('/internal/messages/drafts').set(auth).send(draft).expect(201);
      const url = `/internal/messages/${created.body.draftId}`;
      const review = { callId: draft.callId, expectedVersion: draft.version, review: { speechId: 'speech-1', completedAt: Date.now(), callerSequence: 1 } };
      const send = { callId: draft.callId, expectedVersion: draft.version, channel: 'web', consent: { messageId: 'turn-2', sequence: 2, version: draft.version } };
      await request(app).post(`${url}/send`).set(auth).send(send).expect(409);
      await request(app).post(`${url}/review`).send(review).expect(401);
      await request(app).post(`${url}/review`).set(auth).send({ ...review, callId: 'wrong-call' }).expect(409);
      await request(app).post(`${url}/review`).set(auth).send(review).expect(204);
      await request(app).post(`${url}/review`).set(auth).send(review).expect(204);
      await request(app).post(`${url}/send`).set(auth).send({ ...send, consent: { ...send.consent, sequence: 1 } }).expect(409);
      const result = await request(app).post(`${url}/send`).set(auth).send(send).expect(202);
      expect(result.body.status).toBe('simulated');
    });

    it('preserves an uncertain send result through the HTTP response', async () => {
      const provider = { name: 'timeout-test', send: async () => new Promise<never>(() => undefined) };
      const service = new MessagingService({ provider, hmacSecret: 'test', smsEnabled: true, store: new InMemoryMessageStore(), providerTimeoutMs: 10 });
      const { app } = setup({}, service);
      const auth = { 'x-internal-secret': config.INTERNAL_API_SECRET };
      const created = await request(app).post('/internal/messages/drafts').set(auth).send(draft).expect(201);
      const url = `/internal/messages/${created.body.draftId}`;
      await request(app).post(`${url}/review`).set(auth).send({ callId: draft.callId, expectedVersion: draft.version, review: { speechId: 'speech-1', completedAt: Date.now(), callerSequence: 1 } }).expect(204);
      const sent = await request(app).post(`${url}/send`).set(auth).send({ callId: draft.callId, expectedVersion: draft.version, channel: 'phone', consent: { messageId: 'turn-2', sequence: 2, version: draft.version } }).expect(504);
      expect(await readMessageResult(new Response(sent.text, { status: sent.status }))).toMatchObject({ status: 'unknown', operationId: expect.any(String) });
      expect((await service.getOperationByDraft(created.body.draftId))?.status).toBe('unknown');
    });

    it('cancels a draft only for its owning call', async () => {
      const { app } = setup({}, messaging());
      const auth = { 'x-internal-secret': config.INTERNAL_API_SECRET };
      const created = await request(app).post('/internal/messages/drafts').set(auth).send(draft).expect(201);

      await request(app)
        .post(`/internal/messages/${created.body.draftId}/cancel`)
        .send({ callId: draft.callId })
        .expect(401);

      await request(app)
        .post(`/internal/messages/${created.body.draftId}/cancel`)
        .set(auth)
        .send({ callId: 'another-call' })
        .expect(404);

      await request(app)
        .post(`/internal/messages/${created.body.draftId}/cancel`)
        .set(auth)
        .send({ callId: draft.callId })
        .expect(200);

      await request(app)
        .post(`/internal/messages/${created.body.draftId}/send`)
        .set(auth)
        .send({ callId: draft.callId, expectedVersion: draft.version, consent: { messageId: 'caller-2', sequence: 2, version: draft.version } })
        .expect(409);
    });

    it('rejects an unsigned provider callback and accepts a valid HMAC', async () => {
      const secret = 'sms-webhook-test-secret';
      const { app } = setup({ SMS_WEBHOOK_SECRET: secret }, messaging());
      await request(app).post('/webhooks/sms/status').send({ messageId: 'm1', status: 'delivered' }).expect(401);

      const body = JSON.stringify({ messageId: 'm1', status: 'delivered' });
      const signature = createHmac('sha256', secret).update(body).digest('hex');
      await request(app)
        .post('/webhooks/sms/status')
        .set('content-type', 'application/json')
        .set('x-sms-signature', signature)
        .send(body)
        .expect(200);
    });

    it('rejects every provider callback when no webhook secret is configured', async () => {
      const { app } = setup({ SMS_WEBHOOK_SECRET: undefined }, messaging());
      await request(app)
        .post('/webhooks/sms/status')
        .set('x-sms-signature', 'anything')
        .send({ messageId: 'm1', status: 'delivered' })
        .expect(401);
    });

    it('does not acknowledge a callback when its receipt cannot be stored', async () => {
      class FailingStore extends InMemoryMessageStore {
        override async saveCallback(): Promise<void> { throw new Error('storage unavailable'); }
      }
      const secret = 'sms-webhook-test-secret';
      const service = new MessagingService({ provider: new FakeSmsProvider(), hmacSecret: 'test', store: new FailingStore() });
      const { app } = setup({ SMS_WEBHOOK_SECRET: secret }, service);
      const body = JSON.stringify({ messageId: 'm1', status: 'delivered' });
      const signature = createHmac('sha256', secret).update(body).digest('hex');
      await request(app).post('/webhooks/sms/status').set('content-type', 'application/json').set('x-sms-signature', signature).send(body).expect(500);
    });
  });
});
