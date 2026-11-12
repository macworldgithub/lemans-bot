import type { MessageDraft, MessageOperation } from './service.js';
import type { ConsentReference, ReviewReceipt } from './schema.js';

export interface Reservation {
  operation: MessageOperation;
  expectedVersion: number;
  consent: ConsentReference;
  now: number;
  draftMaxAgeMs: number;
  cooldownMs: number;
  dailyLimit: number;
}
export type ReservationResult =
  | { kind: 'reserved' | 'replay'; operation: MessageOperation }
  | { kind: 'rejected'; status: number; error: string };

export function checkReservation(draft: MessageDraft | undefined, operations: MessageOperation[], request: Reservation): ReservationResult | undefined {
  const op = request.operation;
  if (!draft || draft.callId !== op.callId) return { kind: 'rejected', status: 404, error: 'Draft not found' };
  if (op.recipient !== draft.recipient || op.recipientHmac !== draft.recipientHmac || op.purpose !== draft.purpose) return { kind: 'rejected', status: 409, error: 'Draft changed' };
  const existing = operations.find((item) => item.draftId === draft.draftId);
  if (existing) return { kind: 'replay', operation: existing };
  if (draft.status !== 'prepared' || draft.version !== request.expectedVersion || request.now - draft.createdAt > request.draftMaxAgeMs) {
    return { kind: 'rejected', status: 409, error: 'Draft is cancelled, submitted, expired or stale' };
  }
  if (!draft.review || draft.review.completedAt < draft.createdAt || draft.review.completedAt > request.now || request.consent.version !== draft.version || request.consent.sequence <= draft.review.callerSequence) {
    return { kind: 'rejected', status: 409, error: 'Review or consent is missing or stale' };
  }
  const callOps = operations.filter((item) => item.callId === op.callId);
  if (callOps.some((item) => item.purpose === op.purpose)) return { kind: 'rejected', status: 429, error: `Only one ${op.purpose} SMS is permitted per call.` };
  const recipients = new Set(callOps.map((item) => item.recipientHmac));
  if (!recipients.has(draft.recipientHmac) && recipients.size >= 2) return { kind: 'rejected', status: 429, error: 'Recipient limit reached' };
  if (op.status !== 'simulated') {
    const real = operations.filter((item) => item.status !== 'simulated');
    if (real.some((item) => item.recipientHmac === draft.recipientHmac && item.createdAt >= request.now - request.cooldownMs)) {
      return { kind: 'rejected', status: 429, error: `Please wait ${request.cooldownMs / 1000} seconds before sending another message to this number.` };
    }
    if (real.filter((item) => item.createdAt >= request.now - 86_400_000).length >= request.dailyLimit) {
      return { kind: 'rejected', status: 429, error: 'Daily message sending limit reached.' };
    }
  }
  return undefined;
}

/**
 * Storage contract for SMS drafts and send operations.
 *
 * A live sender needs a durable implementation. The in-memory store is only for
 * tests and for the disabled/web-demo path.
 */
export interface MessageStore {
  saveDraft(draft: MessageDraft): Promise<void>;
  approveAfterCall(draftId: string, callId: string, version: number, consent: ConsentReference, channel: 'web' | 'phone'): Promise<boolean>;
  getDraft(draftId: string): Promise<MessageDraft | undefined>;
  setDraftStatus(draftId: string, status: MessageDraft['status']): Promise<void>;
  saveReview(draftId: string, callId: string, version: number, review: ReviewReceipt): Promise<boolean>;
  cancelPrepared(draftId: string, callId: string): Promise<'cancelled' | 'submitted' | 'missing'>;
  reserveSend(request: Reservation): Promise<ReservationResult>;
  saveCallback(messageId: string, status: 'delivered' | 'failed'): Promise<void>;
  getCallback(messageId: string): Promise<'delivered' | 'failed' | undefined>;

  /**
   * Atomically reserves the single send slot for a draft.
   * A repeated claim returns the first stored operation instead of creating a second send.
   */
  claimOperation(operation: MessageOperation): Promise<{ claimed: boolean; operation: MessageOperation }>;
  getOperation(operationId: string): Promise<MessageOperation | undefined>;
  getOperationByDraft(draftId: string): Promise<MessageOperation | undefined>;
  getOperationByLimit(limitKey: string): Promise<MessageOperation | undefined>;
  getOperationByProviderMessageId(messageId: string): Promise<MessageOperation | undefined>;
  updateOperation(
    operationId: string,
    patch: Partial<Omit<MessageOperation, 'operationId' | 'draftId' | 'callId'>>,
  ): Promise<void>;

  listOperationsForCall(callId: string): Promise<MessageOperation[]>;
  listOperationsSince(since: number): Promise<MessageOperation[]>;
}

export class InMemoryMessageStore implements MessageStore {
  async approveAfterCall(id: string, callId: string, version: number, consent: ConsentReference, channel: 'web' | 'phone'): Promise<boolean> {
    const draft = this.drafts.get(id);
    if (!draft || draft.callId !== callId || draft.version !== version || draft.status !== 'prepared' || !draft.review || consent.version !== version || consent.sequence <= draft.review.callerSequence) return false;
    if (draft.consent) return JSON.stringify(draft.consent) === JSON.stringify(consent) && draft.channel === channel;
    Object.assign(draft, { delivery: 'after_call', consent: { ...consent }, channel });
    return true;
  }

  private readonly drafts = new Map<string, MessageDraft>();
  private readonly operations = new Map<string, MessageOperation>();
  private readonly operationByDraft = new Map<string, MessageOperation>();
  private readonly operationByLimit = new Map<string, MessageOperation>();
  private readonly callbacks = new Map<string, 'delivered' | 'failed'>();

  async saveReview(id: string, callId: string, version: number, review: ReviewReceipt): Promise<boolean> {
    const draft = this.drafts.get(id);
    if (!draft || draft.callId !== callId || draft.version !== version || draft.status !== 'prepared' || review.completedAt < draft.createdAt) return false;
    if (draft.review) return JSON.stringify(draft.review) === JSON.stringify(review);
    draft.review = { ...review };
    return true;
  }

  async cancelPrepared(id: string, callId: string): Promise<'cancelled' | 'submitted' | 'missing'> {
    const draft = this.drafts.get(id);
    if (!draft || draft.callId !== callId) return 'missing';
    if (draft.status === 'submitted') return 'submitted';
    draft.status = 'cancelled';
    return 'cancelled';
  }

  async reserveSend(request: Reservation): Promise<ReservationResult> {
    const draft = this.drafts.get(request.operation.draftId);
    const result = checkReservation(draft, [...this.operations.values()], request);
    if (result) return result;
    draft!.status = 'submitted';
    const op = { ...request.operation, consent: request.consent };
    this.operations.set(op.operationId, op);
    this.operationByDraft.set(op.draftId, op);
    this.operationByLimit.set(op.limitKey, op);
    return { kind: 'reserved', operation: { ...op } };
  }

  async saveCallback(messageId: string, status: 'delivered' | 'failed'): Promise<void> {
    if (this.callbacks.get(messageId) !== 'delivered') this.callbacks.set(messageId, status);
  }
  async getCallback(messageId: string): Promise<'delivered' | 'failed' | undefined> { return this.callbacks.get(messageId); }

  async saveDraft(draft: MessageDraft): Promise<void> {
    this.drafts.set(draft.draftId, { ...draft });
  }

  async getDraft(draftId: string): Promise<MessageDraft | undefined> {
    const draft = this.drafts.get(draftId);
    return draft ? { ...draft } : undefined;
  }

  async setDraftStatus(draftId: string, status: MessageDraft['status']): Promise<void> {
    const draft = this.drafts.get(draftId);
    if (draft) {
      draft.status = status;
    }
  }

  async claimOperation(
    operation: MessageOperation,
  ): Promise<{ claimed: boolean; operation: MessageOperation }> {
    const sameDraft = this.operationByDraft.get(operation.draftId);
    if (sameDraft) {
      return { claimed: false, operation: { ...sameDraft } };
    }
    const sameLimit = this.operationByLimit.get(operation.limitKey);
    if (sameLimit) {
      return { claimed: false, operation: { ...sameLimit } };
    }
    this.operations.set(operation.operationId, { ...operation });
    this.operationByDraft.set(operation.draftId, { ...operation });
    this.operationByLimit.set(operation.limitKey, { ...operation });
    return { claimed: true, operation: { ...operation } };
  }

  async getOperation(operationId: string): Promise<MessageOperation | undefined> {
    const op = this.operations.get(operationId);
    return op ? { ...op } : undefined;
  }

  async getOperationByDraft(draftId: string): Promise<MessageOperation | undefined> {
    const op = this.operationByDraft.get(draftId);
    return op ? { ...op } : undefined;
  }

  async getOperationByLimit(limitKey: string): Promise<MessageOperation | undefined> {
    const op = this.operationByLimit.get(limitKey);
    return op ? { ...op } : undefined;
  }

  async getOperationByProviderMessageId(messageId: string): Promise<MessageOperation | undefined> {
    for (const op of this.operations.values()) {
      if (op.providerMessageId === messageId) return { ...op };
    }
    return undefined;
  }

  async updateOperation(
    operationId: string,
    patch: Partial<Omit<MessageOperation, 'operationId' | 'draftId' | 'callId'>>,
  ): Promise<void> {
    const op = this.operations.get(operationId);
    if (!op) return;
    // A late callback must never move a delivered message backwards.
    if ((op.status === 'delivered' || op.status === 'failed') && patch.status && patch.status !== 'delivered') {
      const { status: _status, ...rest } = patch;
      Object.assign(op, rest);
    } else Object.assign(op, patch);
    this.operationByDraft.set(op.draftId, { ...op });
    this.operationByLimit.set(op.limitKey, { ...op });
  }

  async listOperationsForCall(callId: string): Promise<MessageOperation[]> {
    return [...this.operations.values()].filter((op) => op.callId === callId).map((op) => ({ ...op }));
  }

  async listOperationsSince(since: number): Promise<MessageOperation[]> {
    return [...this.operations.values()].filter((op) => op.createdAt >= since).map((op) => ({ ...op }));
  }
}
