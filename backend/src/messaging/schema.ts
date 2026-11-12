import { z } from 'zod';

export const messageResultSchema = z.object({
  status: z.enum(['scheduled', 'sending', 'accepted', 'delivered', 'failed', 'unknown', 'simulated', 'unavailable']),
  operationId: z.string().min(1).max(128).optional(),
  errorCode: z.string().max(128).optional(),
});

export type MessageResult = z.infer<typeof messageResultSchema>;

export const reviewSchema = z.object({
  speechId: z.string().min(1).max(128),
  completedAt: z.number().int().nonnegative(),
  callerSequence: z.number().int().nonnegative(),
}).strict();
export const consentSchema = z.object({
  messageId: z.string().min(1).max(128),
  sequence: z.number().int().positive(),
  version: z.number().int().positive(),
}).strict();
export const draftRecordSchema = z.object({
  draftId: z.string().min(1).max(128), callId: z.string().min(1).max(128),
  purpose: z.enum(['booking', 'maps']), recipient: z.string().regex(/^\+614\d{8}$/),
  recipientHmac: z.string().min(1).max(128), version: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(), status: z.enum(['prepared', 'cancelled', 'submitted']),
  review: reviewSchema.optional(),
  delivery: z.literal('after_call').optional(),
  consent: consentSchema.optional(),
  channel: z.enum(['web', 'phone']).optional(),
}).strict();
export const operationRecordSchema = z.object({
  operationId: z.string().min(1).max(128), draftId: z.string().min(1).max(128), callId: z.string().min(1).max(128),
  purpose: z.enum(['booking', 'maps']), recipient: z.string().regex(/^\+614\d{8}$/),
  recipientHmac: z.string().min(1).max(128), limitKey: z.string().min(1).max(256),
  status: z.enum(['prepared', 'sending', 'accepted', 'delivered', 'failed', 'cancelled', 'unknown', 'simulated']),
  providerMessageId: z.string().min(1).max(128).optional(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  error: z.string().max(256).optional(), consent: consentSchema,
}).strict();
export type ReviewReceipt = z.infer<typeof reviewSchema>;
export type ConsentReference = z.infer<typeof consentSchema>;
export type MessageDraftRecord = z.infer<typeof draftRecordSchema>;
export type MessageOperationRecord = z.infer<typeof operationRecordSchema>;

export async function readMessageResult(response: Response): Promise<MessageResult> {
  try {
    const parsed = messageResultSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : { status: 'unknown' };
  } catch {
    return { status: 'unknown' };
  }
}
