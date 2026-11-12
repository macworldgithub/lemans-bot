import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';

import type { MessagingService } from './service.js';
import { consentSchema, reviewSchema } from './schema.js';

export interface MessagingRouterOptions {
  /** Shared-secret gate for worker-facing routes. The webhook has its own signature check. */
  internalOnly: RequestHandler;
  /** Returns true only when the provider callback signature is valid for this request. */
  verifyWebhook: (req: Request) => boolean;
}

const draftSchema = z.object({
  callId: z.string().min(1).max(128),
  purpose: z.enum(['booking', 'maps']),
  phone: z.string().min(5).max(32),
  version: z.number().int().positive(),
  delivery: z.literal('after_call').optional(),
});

const sendSchema = z.object({
  callId: z.string().min(1).max(128),
  expectedVersion: z.number().int().positive(),
  channel: z.enum(['web', 'phone']).optional(),
  consent: consentSchema,
}).strict();

const reviewRequestSchema = z.object({ callId: z.string().min(1).max(128), expectedVersion: z.number().int().positive(), review: reviewSchema }).strict();

const cancelSchema = z.object({
  callId: z.string().min(1).max(128),
});

const callbackSchema = z.object({
  MessageSid: z.string().min(1).max(128).optional(),
  messageId: z.string().min(1).max(128).optional(),
  MessageStatus: z.string().max(128).optional(),
  status: z.string().max(128).optional(),
});

/** Express 5 types params as string | string[]. Only a single non-empty string is valid here. */
function readParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function createMessagingRouter(service: MessagingService, options: MessagingRouterOptions): Router {
  const router = Router();

  router.post('/internal/messages/:draftId/approve-after-call', options.internalOnly, async (req, res) => {
    const draftId = readParam(req.params.draftId);
    const parsed = sendSchema.safeParse(req.body);
    if (!draftId || !parsed.success || !parsed.data.channel) return void res.sendStatus(400);
    const approved = await service.approveAfterCall({ draftId, ...parsed.data, channel: parsed.data.channel });
    res.status(approved ? 202 : 409).json({ status: approved ? 'scheduled' : 'unavailable' });
  });

  router.post('/internal/messages/calls/:callId/complete', options.internalOnly, async (req, res) => {
    const callId = readParam(req.params.callId);
    const parsed = z.object({ reason: z.enum(['caller_disconnected', 'room_deleted']), draftId: z.string().min(1).max(128).optional() }).strict().safeParse(req.body);
    if (!callId || callId.length > 128 || !parsed.success) return void res.sendStatus(400);
    await service.completeCall(callId, parsed.data.draftId);
    res.sendStatus(204);
  });

  router.post('/internal/messages/drafts', options.internalOnly, async (req: Request, res: Response) => {
    const parsed = draftSchema.safeParse(req.body);
    if (!parsed.success) {
      return void res.status(400).json({ error: 'invalid draft request', issues: parsed.error.issues });
    }

    const result = await service.createDraft(parsed.data);
    if (!result.success) {
      return void res.status(400).json({ error: result.error });
    }

    res.status(201).json({
      draftId: result.draft.draftId,
      purpose: result.draft.purpose,
      recipient: result.draft.recipient,
      version: result.draft.version,
    });
  });

  router.post('/internal/messages/:draftId/send', options.internalOnly, async (req: Request, res: Response) => {
    const draftId = readParam(req.params.draftId);
    if (!draftId) {
      return void res.status(400).json({ error: 'invalid draft ID' });
    }
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      return void res.status(400).json({ error: 'invalid send request', issues: parsed.error.issues });
    }

    const outcome = await service.sendDraft({
      draftId,
      callId: parsed.data.callId,
      expectedVersion: parsed.data.expectedVersion,
      channel: parsed.data.channel,
      consent: parsed.data.consent,
    });

    if (!outcome.success && outcome.status && outcome.status >= 400) {
      return void res.status(outcome.status).json({
        status: outcome.operation?.status ?? 'unavailable',
        operationId: outcome.operation?.operationId,
        errorCode: outcome.operation ? 'provider_result' : 'request_rejected',
      });
    }

    res.status(outcome.status ?? 202).json({
      operationId: outcome.operation?.operationId,
      status: outcome.operation?.status,
      recipient: outcome.operation?.recipient,
      purpose: outcome.operation?.purpose,
    });
  });

  router.post('/internal/messages/:draftId/review', options.internalOnly, async (req: Request, res: Response) => {
    const draftId = readParam(req.params.draftId);
    const parsed = reviewRequestSchema.safeParse(req.body);
    if (!draftId || !parsed.success) return void res.status(400).json({ error: 'invalid review' });
    const valid = await service.recordReview(draftId, parsed.data.callId, parsed.data.expectedVersion, parsed.data.review);
    if (!valid) return void res.status(409).json({ error: 'review rejected' });
    res.sendStatus(204);
  });

  router.post('/internal/messages/:draftId/cancel', options.internalOnly, async (req: Request, res: Response) => {
    const draftId = readParam(req.params.draftId);
    if (!draftId) {
      return void res.status(400).json({ error: 'invalid draft ID' });
    }
    const parsed = cancelSchema.safeParse(req.body);
    if (!parsed.success) {
      return void res.status(400).json({ error: 'invalid cancel request', issues: parsed.error.issues });
    }

    const outcome = await service.cancelDraft(draftId, parsed.data.callId);
    if (!outcome.cancelled && outcome.alreadySent) {
      return void res.status(409).json({ error: outcome.error });
    }
    if (!outcome.cancelled) {
      return void res.status(404).json({ error: outcome.error ?? 'Draft not found' });
    }
    res.status(200).json({ status: 'cancelled' });
  });

  router.get('/internal/messages/:operationId', options.internalOnly, async (req: Request, res: Response) => {
    const callId = req.query.callId;
    if (typeof callId !== 'string' || callId.length === 0 || callId.length > 128) {
      return void res.status(400).json({ error: 'valid callId query parameter required' });
    }

    const operationId = readParam(req.params.operationId);
    if (!operationId) {
      return void res.status(400).json({ error: 'invalid operation ID' });
    }

    const op = await service.getOperation(operationId);
    if (!op || op.callId !== callId) {
      return void res.status(404).json({ error: 'Operation not found for this call' });
    }

    res.json({
      operationId: op.operationId,
      status: op.status,
      purpose: op.purpose,
      createdAt: op.createdAt,
      updatedAt: op.updatedAt,
    });
  });

  router.post('/webhooks/sms/status', async (req: Request, res: Response) => {
    if (!options.verifyWebhook(req)) {
      return void res.status(401).json({ error: 'invalid callback signature' });
    }

    const parsed = callbackSchema.safeParse(req.body);
    if (!parsed.success) {
      return void res.status(400).json({ error: 'invalid callback payload' });
    }

    const messageId = parsed.data.messageId || parsed.data.MessageSid;
    const rawStatus = (parsed.data.status || parsed.data.MessageStatus || '').toLowerCase();

    if (!messageId || !rawStatus) {
      return void res.status(400).json({ error: 'missing message identifier or status' });
    }

    let status: 'delivered' | 'failed' | 'undelivered';
    if (rawStatus === 'delivered') status = 'delivered';
    else if (rawStatus === 'undelivered') status = 'undelivered';
    else if (rawStatus === 'failed') status = 'failed';
    else {
      // queued/sent and other interim states do not change our stored terminal state.
      return void res.status(200).send('<Response/>');
    }

    await service.handleProviderCallback({ messageId, status });
    res.status(200).send('<Response/>');
  });

  return router;
}
