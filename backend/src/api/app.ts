import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import express, { type NextFunction, type Request, type Response } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import type { Logger } from 'pino';
import { z } from 'zod';

import type { Config } from '../config.js';
import type { ScheduleType } from '../hours/schema.js';
import type { HoursService } from '../hours/service.js';
import { createMessagingRouter } from '../messaging/routes.js';
import type { MessagingService } from '../messaging/service.js';
import type { AgentEvent, MonitorEvent } from '../shared/events.js';
import type { Database } from './db.js';
import type { CallStore } from './store.js';

export interface AppDeps {
  config: Config;
  store: CallStore;
  db: Database;
  logger: Logger;
  hoursService?: HoursService;
  messagingService?: MessagingService;
}

export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('call-started'),
    callId: z.string().min(1).max(128),
    source: z.enum(['web', 'phone']),
    callerNumber: z.string().max(32).optional(),
    startedAt: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('call-ended'),
    callId: z.string().min(1).max(128),
    endedAt: z.number().int().positive(),
    reason: z.string().max(256).optional(),
  }),
  z.object({
    type: z.literal('transcript'),
    event: z.object({
      callId: z.string().min(1).max(128),
      id: z.string().min(1).max(64),
      role: z.enum(['bot', 'user']),
      kind: z.enum(['interim', 'final', 'interrupted']),
      text: z.string().max(2000).optional(),
      ts: z.number().int().positive(),
    }),
  }),
  z.object({
    type: z.literal('transfer'),
    transfer: z.object({
      callId: z.string().min(1).max(128),
      department: z.enum(['reservations', 'corporate', 'duty_manager']),
      reason: z.string().max(500),
      target: z.string().max(64).optional(),
      status: z.enum([
        'transferring',
        'transferred',
        'web-demo',
        'unavailable',
        'failed',
        'requested',
        'simulated',
        'unknown',
      ]),
      ts: z.number().int().positive(),
    }),
  }),
  z.object({
    type: z.literal('metrics'),
    callId: z.string().min(1).max(128),
    metrics: z.object({
      e2eMs: z.number().optional(),
      eouMs: z.number().optional(),
      llmTtftMs: z.number().optional(),
      ttsTtfbMs: z.number().optional(),
      frameworkE2eMs: z.number().optional(),
    }),
    ts: z.number().int().positive(),
  }),
]);

export const leadSchema = z.object({
  callId: z.string().min(1).max(128),
  operationId: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(100),
  phone: z.string().max(32).optional(),
  email: z.string().email().max(100).optional().or(z.literal('')),
  eventType: z.string().min(1).max(100),
  preferredDate: z.string().max(100).optional(),
  headcount: z.number().int().positive().max(10000).optional(),
  notes: z.string().max(1000).optional(),
  createdAt: z.number().int().positive(),
});

function secretMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Generic HMAC check for the provider callback. The selected provider (G3) must replace
 * this with its official signature library and exact header format.
 */
function smsWebhookMatches(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const given = req.header('x-sms-signature')?.replace(/^sha256=/i, '').toLowerCase();
  if (!rawBody || !given) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
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

export function createApp({ config, store, db, logger, hoursService, messagingService }: AppDeps) {
  const deps = { config, store, db, logger, hoursService, messagingService };
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(
    express.json({
      limit: '64kb',
      // Keep the exact bytes for provider signature checks. Never log this buffer.
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );

  if (config.CORS_ORIGIN) {
    app.use((req, res, next) => {
      res.setHeader('access-control-allow-origin', config.CORS_ORIGIN!);
      res.setHeader('access-control-allow-headers', 'content-type, authorization, x-staff-key');
      if (req.method === 'OPTIONS') return void res.sendStatus(204);
      next();
    });
  }

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      mongo: db.connected,
      pipeline: config.AGENT_PIPELINE,
      liveCalls: store.list().filter((c) => !c.endedAt).length,
    });
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

  if (messagingService) {
    app.use(
      createMessagingRouter(messagingService, {
        internalOnly,
        verifyWebhook: (req) => smsWebhookMatches(req, config.SMS_WEBHOOK_SECRET),
      }),
    );
  }

  const staffAuth = (req: Request, res: Response, next: NextFunction) => {
    if (config.STAFF_API_KEY) {
      const header = req.header('x-staff-key') || req.header('authorization')?.replace(/^Bearer\s+/i, '');
      if (!secretMatches(header, config.STAFF_API_KEY)) {
        res.status(401).json({ error: 'Unauthorized: staff access key required' });
        return;
      }
      return next();
    }
    if (config.NODE_ENV === 'production') {
      res.status(403).json({ error: 'Private route disabled in production without staff access configuration' });
      return;
    }
    next();
  };

  app.post('/internal/events', internalOnly, (req, res) => {
    const parsed = agentEventSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid event', issues: parsed.error.issues });
    store.apply(parsed.data as AgentEvent);
    res.sendStatus(204);
  });

  // Leads are confirmed, not best effort: the agent waits for this answer before telling the
  // caller their details are saved, so it only succeeds once the lead is in the database.
  app.post('/internal/leads', internalOnly, async (req, res) => {
    const parsed = leadSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid lead', issues: parsed.error.issues });
    const lead = parsed.data;
    try {
      await db.saveLead(lead);
    } catch (err) {
      logger.error(
        { err: (err as Error).message, callId: lead.callId, eventType: lead.eventType },
        'saving lead failed',
      );
      return void res.status(503).json({ error: 'lead not saved' });
    }
    store.addLead(lead);
    logger.info({ callId: lead.callId, eventType: lead.eventType, operationId: lead.operationId }, 'lead saved');
    res.sendStatus(201);
  });

  app.get('/internal/hours', internalOnly, (req, res) => {
    if (!deps.hoursService) {
      return void res.status(503).json({ error: 'hours service unavailable' });
    }
    const scheduleParam = req.query.schedule as string | undefined;
    const dateParam = req.query.date as string | undefined;
    if (scheduleParam && !['venue', 'bookings', 'large_events'].includes(scheduleParam)) {
      return void res.status(400).json({ error: 'invalid schedule param' });
    }
    const schedule = (scheduleParam ?? 'venue') as ScheduleType;
    const result = deps.hoursService.query({ date: dateParam, schedule });
    res.json(result);
  });

  // Monitor feed: snapshot of recent calls, then every event as it happens.
  app.get('/api/monitor/stream', staffAuth, (req, res) => {
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

  app.get('/api/calls', staffAuth, async (_req, res) => {
    const live = store.list();
    const stored = await db.recentCalls();
    const seen = new Set(live.map((c) => c.callId));
    res.json({ calls: [...live, ...stored.filter((c) => !seen.has(c.callId))] });
  });

  app.get('/api/leads', staffAuth, async (_req, res) => {
    res.json({ leads: db.connected ? await db.recentLeads() : store.list().flatMap((c) => c.leads) });
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof err.status === 'number' ? err.status : typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 500) {
      logger.error({ err: err.message }, 'request failed');
      res.status(status).json({ error: 'Internal error' });
    } else {
      res.status(status).json({ error: err.message || 'Request failed' });
    }
  });

  return app;
}
