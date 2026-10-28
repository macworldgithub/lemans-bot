import { randomUUID, timingSafeEqual } from 'node:crypto';

import express, { type NextFunction, type Request, type Response } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import type { Logger } from 'pino';
import { z } from 'zod';

import type { Config } from '../config.js';
import type { AgentEvent, MonitorEvent } from '../shared/events.js';
import type { Database } from './db.js';
import type { CallStore } from './store.js';

export interface AppDeps {
  config: Config;
  store: CallStore;
  db: Database;
  logger: Logger;
}

const agentEventSchema = z.object({ type: z.enum(['call-started', 'call-ended', 'transcript', 'transfer', 'metrics']) }).passthrough();

const leadSchema = z.object({
  callId: z.string().min(1),
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().optional(),
  eventType: z.string().min(1),
  preferredDate: z.string().optional(),
  headcount: z.number().int().positive().optional(),
  notes: z.string().optional(),
  createdAt: z.number(),
});

function secretMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Fixed-window limiter per IP; enough to stop a script minting tokens (each one starts a paid call). */
function rateLimit(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt < now) hits.set(key, { count: 1, resetAt: now + windowMs });
    else if (++entry.count > limit) {
      res.status(429).json({ error: 'Too many calls started, try again in a minute.' });
      return;
    }
    next();
  };
}

export function createApp({ config, store, db, logger }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '256kb' }));

  if (config.CORS_ORIGIN) {
    app.use((req, res, next) => {
      res.setHeader('access-control-allow-origin', config.CORS_ORIGIN!);
      res.setHeader('access-control-allow-headers', 'content-type');
      if (req.method === 'OPTIONS') return void res.sendStatus(204);
      next();
    });
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, mongo: db.connected, pipeline: config.AGENT_PIPELINE, liveCalls: store.list().filter((c) => !c.endedAt).length });
  });

  // Browser demo: one room per call, agent dispatched by name through the token.
  app.post('/api/token', rateLimit(10, 60_000), async (_req, res) => {
    const roomName = `web-${randomUUID().slice(0, 8)}`;
    const identity = `web-caller-${randomUUID().slice(0, 6)}`;
    const at = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, { identity, ttl: '15m' });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: false });
    at.roomConfig = new RoomConfiguration({
      agents: [new RoomAgentDispatch({ agentName: config.AGENT_NAME })],
      emptyTimeout: 30,
      departureTimeout: 5,
    });
    res.json({ serverUrl: config.LIVEKIT_URL, roomName, participantToken: await at.toJwt() });
  });

  const internalOnly = (req: Request, res: Response, next: NextFunction) =>
    secretMatches(req.header('x-internal-secret'), config.INTERNAL_API_SECRET) ? next() : void res.sendStatus(401);

  app.post('/internal/events', internalOnly, (req, res) => {
    const parsed = agentEventSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid event' });
    store.apply(parsed.data as unknown as AgentEvent);
    res.sendStatus(204);
  });

  // Leads are confirmed, not best effort: the agent waits for this answer before telling the
  // caller their details are saved, so it only succeeds once the lead is in the database.
  app.post('/internal/leads', internalOnly, async (req, res) => {
    const parsed = leadSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid lead' });
    const lead = parsed.data;
    try {
      await db.saveLead(lead);
    } catch (err) {
      logger.error({ err: (err as Error).message, lead }, 'saving lead failed');
      return void res.status(503).json({ error: 'lead not saved' });
    }
    store.addLead(lead);
    logger.info({ callId: lead.callId, eventType: lead.eventType }, 'lead saved');
    res.sendStatus(201);
  });

  // Monitor feed: snapshot of recent calls, then every event as it happens.
  app.get('/api/monitor/stream', (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    write('snapshot', { calls: store.list() });
    const onEvent = (e: MonitorEvent) => write('agent', e);
    store.on('event', onEvent);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      store.off('event', onEvent);
    });
  });

  app.get('/api/calls', async (_req, res) => {
    const live = store.list();
    const stored = await db.recentCalls();
    const seen = new Set(live.map((c) => c.callId));
    res.json({ calls: [...live, ...stored.filter((c) => !seen.has(c.callId))] });
  });

  app.get('/api/leads', async (_req, res) => {
    res.json({ leads: db.connected ? await db.recentLeads() : store.list().flatMap((c) => c.leads) });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: err.message }, 'request failed');
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}
