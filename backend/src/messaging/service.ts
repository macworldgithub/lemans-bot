import { createHmac, randomUUID } from 'node:crypto';

import type { SmsProvider } from './provider.js';
import { InMemoryMessageStore, type MessageStore } from './store.js';
import { consentSchema, type ConsentReference, type ReviewReceipt, type MessageDraftRecord, type MessageOperationRecord } from './schema.js';

export type MessagePurpose = 'booking' | 'maps';

export type MessageOperationStatus =
  | 'prepared'
  | 'sending'
  | 'accepted'
  | 'delivered'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'simulated';

export type MessageDraft = MessageDraftRecord;
export type MessageOperation = MessageOperationRecord;

export interface MessagingServiceOptions {
  provider: SmsProvider;
  hmacSecret: string;
  bookingUrl?: string;
  mapsUrl?: string;
  dailyLimit?: number;
  cooldownSeconds?: number;
  smsEnabled?: boolean;
  /** Required when smsEnabled is true. Use InMemoryMessageStore only in tests. */
  store?: MessageStore;
  clock?: () => number;
  draftMaxAgeMs?: number;
  /** A provider request may take this long. Timeout means the send result is unknown. */
  providerTimeoutMs?: number;
}

export function normalizeAustralianMobile(input: string): string | null {
  if (!input) return null;
  const cleaned = input.replace(/[\s\-().]/g, '');
  if (/^04\d{8}$/.test(cleaned)) {
    return `+61${cleaned.slice(1)}`;
  }
  if (/^\+614\d{8}$/.test(cleaned)) {
    return cleaned;
  }
  if (/^614\d{8}$/.test(cleaned)) {
    return `+${cleaned}`;
  }
  return null;
}

export class MessagingService {
  readonly provider: SmsProvider;
  private readonly hmacSecret: string;
  readonly bookingUrl: string;
  readonly mapsUrl: string;
  readonly dailyLimit: number;
  readonly cooldownSeconds: number;
  readonly smsEnabled: boolean;
  private readonly store: MessageStore;
  private readonly draftMaxAgeMs: number;
  private readonly providerTimeoutMs: number;
  private clock: () => number;

  constructor(options: MessagingServiceOptions) {
    this.provider = options.provider;
    this.hmacSecret = options.hmacSecret;
    this.bookingUrl = options.bookingUrl ?? 'https://www.lemansgokarts.com.au';
    this.mapsUrl =
      options.mapsUrl ??
      'https://maps.google.com/?q=11-55+Waterview+Close+Dandenong+South+VIC+3175';
    this.dailyLimit = options.dailyLimit ?? 50;
    this.cooldownSeconds = options.cooldownSeconds ?? 60;
    this.smsEnabled = options.smsEnabled ?? false;
    this.store = options.store ?? new InMemoryMessageStore();
    this.draftMaxAgeMs = options.draftMaxAgeMs ?? 15 * 60 * 1000;
    this.providerTimeoutMs = options.providerTimeoutMs ?? 5000;
    this.clock = options.clock ?? (() => Date.now());

    if (this.smsEnabled && !options.store) {
      throw new Error('SMS_ENABLED requires a durable MessageStore');
    }
  }

  setClock(clock: () => number): void {
    this.clock = clock;
  }

  hashRecipient(phone: string): string {
    return createHmac('sha256', this.hmacSecret).update(phone).digest('hex').slice(0, 32);
  }

  async createDraft(params: {
    callId: string;
    purpose: MessagePurpose;
    phone: string;
    version: number;
    delivery?: 'after_call';
  }): Promise<{ success: true; draft: MessageDraft } | { success: false; error: string }> {
    const normalized = normalizeAustralianMobile(params.phone);
    if (!normalized) {
      return {
        success: false,
        error: 'Invalid Australian mobile number. Must be an Australian mobile starting with 04.',
      };
    }

    if (params.purpose !== 'booking' && params.purpose !== 'maps') {
      return { success: false, error: 'Invalid purpose. Must be booking or maps.' };
    }

    const draft: MessageDraft = {
      draftId: `draft-${randomUUID()}`,
      callId: params.callId,
      purpose: params.purpose,
      recipient: normalized,
      recipientHmac: this.hashRecipient(normalized),
      version: params.version,
      createdAt: this.clock(),
      status: 'prepared',
      ...(params.delivery ? { delivery: params.delivery } : {}),
    };

    await this.store.saveDraft(draft);
    return { success: true, draft };
  }

  async getDraft(draftId: string): Promise<MessageDraft | undefined> {
    return this.store.getDraft(draftId);
  }

  async cancelDraft(
    draftId: string,
    callId?: string,
  ): Promise<{ cancelled: boolean; alreadySent?: boolean; error?: string }> {
    if (!callId) return { cancelled: false, error: 'Call ID required' };
    const result = await this.store.cancelPrepared(draftId, callId);
    if (result === 'missing') return { cancelled: false, error: 'Draft not found' };
    if (result === 'submitted') return { cancelled: false, alreadySent: true, error: 'Draft was already submitted' };
    return { cancelled: true };
  }

  async recordReview(draftId: string, callId: string, version: number, review: ReviewReceipt): Promise<boolean> {
    if (review.completedAt > this.clock()) return false;
    return this.store.saveReview(draftId, callId, version, review);
  }

  async getOperation(operationId: string): Promise<MessageOperation | undefined> {
    return this.store.getOperation(operationId);
  }

  async getOperationByDraft(draftId: string): Promise<MessageOperation | undefined> {
    return this.store.getOperationByDraft(draftId);
  }

  async approveAfterCall(params: { draftId: string; callId: string; expectedVersion: number; consent: ConsentReference; channel: 'web' | 'phone' }): Promise<boolean> {
    if (!consentSchema.safeParse(params.consent).success || params.consent.version !== params.expectedVersion) return false;
    const draft = await this.store.getDraft(params.draftId);
    if (!draft || !draft.review || draft.review.completedAt > this.clock() || this.clock() - draft.createdAt > this.draftMaxAgeMs) return false;
    return this.store.approveAfterCall(params.draftId, params.callId, params.expectedVersion, params.consent, params.channel);
  }

  /** Called only by the authenticated worker after a confirmed caller disconnect or room deletion. */
  async completeCall(callId: string, draftId?: string): Promise<void> {
    // The worker supplies only the final approved draft. Old or uncertain approvals stay unsent.
    if (!draftId) return;
    const draft = await this.store.getDraft(draftId);
    if (!draft || draft.callId !== callId || draft.delivery !== 'after_call' || !draft.consent || !draft.channel) return;
    await this.sendDraft({ draftId: draft.draftId, callId, expectedVersion: draft.version, consent: draft.consent, channel: draft.channel }, true);
  }

  async sendDraft(params: {
    draftId: string;
    callId: string;
    expectedVersion: number;
    channel?: 'web' | 'phone';
    consent: ConsentReference;
  }, afterCall = false): Promise<{ success: boolean; operation?: MessageOperation; error?: string; status?: number }> {
    if (!consentSchema.safeParse(params.consent).success) return { success: false, error: 'Consent required', status: 409 };
    const draft = await this.store.getDraft(params.draftId);
    if (!draft) {
      return { success: false, error: 'Draft not found', status: 404 };
    }
    if (draft.callId !== params.callId) {
      return { success: false, error: 'Draft call ID mismatch', status: 404 };
    }
    if (draft.delivery === 'after_call' && (!afterCall || JSON.stringify(draft.consent) !== JSON.stringify(params.consent) || draft.channel !== params.channel)) {
      return { success: false, error: 'Message must wait for the call to end', status: 409 };
    }
    if (draft.status === 'cancelled') {
      return { success: false, error: 'Draft has been cancelled', status: 409 };
    }
    if (draft.version !== params.expectedVersion) {
      return { success: false, error: 'Draft version is stale', status: 409 };
    }

    const now = this.clock();
    // The web demo never sends a real message.
    const isWeb = params.channel === 'web';
    const operation: MessageOperation = {
      operationId: `op-${randomUUID()}`,
      draftId: draft.draftId,
      callId: draft.callId,
      purpose: draft.purpose,
      recipient: draft.recipient,
      recipientHmac: draft.recipientHmac,
      limitKey: `${draft.callId}:${draft.purpose}`,
      status: !this.smsEnabled || isWeb ? 'simulated' : 'sending',
      createdAt: now,
      updatedAt: now,
      consent: params.consent,
    };

    // One atomic claim per draft and per call/purpose. A concurrent request gets the
    // stored result instead of starting a second send.
    const claim = await this.store.reserveSend({ operation, expectedVersion: params.expectedVersion, consent: params.consent, now, draftMaxAgeMs: this.draftMaxAgeMs, cooldownMs: this.cooldownSeconds * 1000, dailyLimit: this.dailyLimit });
    if (claim.kind === 'rejected') return { success: false, error: claim.error, status: claim.status };
    if (claim.kind === 'replay') return this.replayOperation(claim.operation, now);
    if (operation.status === 'simulated') {
      return { success: true, operation: claim.operation, status: 202 };
    }

    const body =
      draft.purpose === 'booking'
        ? `Le Mans Entertainment: Book your casual visit, go-karts, VR or laser tag online here: ${this.bookingUrl}`
        : `Le Mans Entertainment: We are at 11-55 Waterview Close, Dandenong South VIC 3175: ${this.mapsUrl}`;

    try {
      const sendResult = await this.providerRequest({
        to: draft.recipient,
        body,
        operationId: operation.operationId,
      });

      if (sendResult.status === 'accepted') {
        if (!sendResult.providerMessageId) throw new Error('Provider receipt missing');
        await this.store.updateOperation(operation.operationId, {
          status: 'accepted',
          providerMessageId: sendResult.providerMessageId,
          updatedAt: this.clock(),
        });
        const early = await this.store.getCallback(`${this.provider.name}:${sendResult.providerMessageId}`);
        if (early) await this.store.updateOperation(operation.operationId, { status: early, updatedAt: this.clock() });
        const stored = await this.store.getOperation(operation.operationId);
        return { success: true, operation: stored ?? claim.operation, status: 202 };
      }

      await this.store.updateOperation(operation.operationId, {
        status: 'failed',
        error: sendResult.error,
        updatedAt: this.clock(),
      });
      const stored = await this.store.getOperation(operation.operationId);
      return {
        success: false,
        operation: stored ?? claim.operation,
        error: sendResult.error,
        status: 502,
      };
    } catch {
      // A timeout is not proof that no message was sent. Mark it unknown and never
      // retry it automatically.
      await this.store.updateOperation(operation.operationId, {
        status: 'unknown',
        error: 'Carrier request timed out or uncertain',
        updatedAt: this.clock(),
      });
      const stored = await this.store.getOperation(operation.operationId);
      return {
        success: false,
        operation: stored ?? claim.operation,
        error: 'Carrier request timed out or uncertain',
        status: 504,
      };
    }
  }

  private async replayOperation(
    operation: MessageOperation,
    now: number,
  ): Promise<{ success: boolean; operation: MessageOperation; error?: string; status: number }> {
    switch (operation.status) {
      case 'accepted':
      case 'delivered':
      case 'simulated':
        return { success: true, operation, status: 200 };
      case 'failed':
        return { success: false, operation, error: operation.error ?? 'Send failed', status: 200 };
      case 'cancelled':
        return { success: false, operation, error: 'Draft has been cancelled', status: 409 };
      case 'sending': {
        // A live request stays pending. A crashed worker leaves a stale 'sending'
        // operation; it becomes unknown, not a fresh send.
        if (now - operation.updatedAt <= this.providerTimeoutMs) {
          return { success: true, operation, status: 202 };
        }
        const error = 'Previous send result is unknown after a restart. Do not retry automatically.';
        await this.store.updateOperation(operation.operationId, {
          status: 'unknown',
          error,
          updatedAt: now,
        });
        return {
          success: false,
          operation: { ...operation, status: 'unknown', error, updatedAt: now },
          error,
          status: 200,
        };
      }
      case 'prepared':
      case 'unknown': {
        const error = operation.error ?? 'The previous send result is unknown. Do not retry automatically.';
        return { success: false, operation, error, status: 200 };
      }
    }
  }

  /** Bounds the provider attempt. A timeout rejects and is handled as an unknown result. */
  private async providerRequest(request: {
    to: string;
    body: string;
    operationId: string;
  }): Promise<Awaited<ReturnType<SmsProvider['send']>>> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.provider.send(request),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('SMS provider request timed out')),
            this.providerTimeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async handleProviderCallback(event: {
    messageId: string;
    status: 'delivered' | 'failed' | 'undelivered';
  }): Promise<boolean> {
    await this.store.saveCallback(`${this.provider.name}:${event.messageId}`, event.status === 'delivered' ? 'delivered' : 'failed');
    const op = await this.store.getOperationByProviderMessageId(event.messageId);
    if (!op) return false;
    if (op.status === 'delivered') return true; // Cannot downgrade delivered status.

    if (event.status === 'delivered') {
      await this.store.updateOperation(op.operationId, { status: 'delivered', updatedAt: this.clock() });
    } else if (event.status === 'failed' || event.status === 'undelivered') {
      await this.store.updateOperation(op.operationId, { status: 'failed', updatedAt: this.clock() });
    }
    return true;
  }
}
