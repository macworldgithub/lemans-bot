import type { AddressInfo } from 'node:net';

import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { EventReporter } from '../src/agent/reporter.js';
import { createApp } from '../src/api/app.js';
import { Database } from '../src/api/db.js';
import { CallStore } from '../src/api/store.js';
import { config } from '../src/config.js';

function setup() {
  const logger = pino({ level: 'silent' });
  const store = new CallStore();
  const db = new Database(undefined, 'test', logger);
  return { store, app: createApp({ config, store, db, logger }) };
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
    await post({ type: 'transcript', event: { callId: 'web-1', id: 'u0', role: 'user', kind: 'final', text: 'hello', ts: 2 } });
    const res = await request(app).get('/api/calls').expect(200);
    expect(res.body.calls[0]).toMatchObject({ callId: 'web-1', lines: [{ text: 'hello', final: true }] });
  });

  describe('leads', () => {
    const lead = { callId: 'phone-1', name: 'Jake', phone: '0412345678', eventType: 'kids party', createdAt: 5 };

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
      await request(app).post('/internal/leads').set('x-internal-secret', config.INTERNAL_API_SECRET).send({ callId: 'x' }).expect(400);
    });
  });

  it('rejects malformed events', async () => {
    const { app } = setup();
    await request(app).post('/internal/events').set('x-internal-secret', config.INTERNAL_API_SECRET).send({ type: 'nope' }).expect(400);
  });
});
