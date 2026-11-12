import { MongoClient, type Collection, type Db } from 'mongodb';
import type { Logger } from 'pino';

import { parseHoursSnapshot, type HoursSnapshot } from '../hours/schema.js';
import type { MessageDraft, MessageOperation } from '../messaging/service.js';
import { checkReservation, type MessageStore, type Reservation, type ReservationResult } from '../messaging/store.js';
import { draftRecordSchema, operationRecordSchema, reviewSchema, type ReviewReceipt, type ConsentReference } from '../messaging/schema.js';
import type { LeadInfo } from '../shared/events.js';
import type { CallRecord } from './store.js';

/** Persists finished calls and leads. Without MONGO_URI it runs in memory-only mode. */
export class Database implements MessageStore {
  private client?: MongoClient;
  private db?: Db;

  constructor(
    private readonly uri: string | undefined,
    private readonly dbName: string,
    private readonly logger: Logger,
  ) {}

  get connected(): boolean {
    return this.db !== undefined;
  }

  async connect(): Promise<void> {
    if (!this.uri) {
      this.logger.warn('MONGO_URI not set: calls and leads are kept in memory only');
      return;
    }
    try {
      this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 8000, appName: 'lemans-voice' });
      await this.client.connect();
      this.db = this.client.db(this.dbName);
      await this.calls().createIndex({ startedAt: -1 });
      await this.leads().createIndex({ createdAt: -1 });
      await this.messageDrafts().createIndex({ callId: 1, createdAt: -1 });
      // One operation per draft and per call/purpose is the atomic duplicate-send guard.
      await this.messageOperations().createIndex({ draftId: 1 }, { unique: true });
      await this.messageOperations().createIndex({ limitKey: 1 }, { unique: true });
      await this.messageOperations().createIndex({ providerMessageId: 1 }, { sparse: true });
      await this.messageOperations().createIndex({ callId: 1, createdAt: -1 });
      await this.messageOperations().createIndex({ createdAt: -1 });
      await this.messageOperations().createIndex({ recipientHmac: 1, createdAt: -1 });
      await this.db.collection('sms_metadata').updateOne({ _id: 'dispatch' as any }, { $setOnInsert: { revision: 0 } }, { upsert: true });
      this.logger.info({ db: this.dbName }, 'MongoDB connected');
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, 'MongoDB unavailable: continuing in memory-only mode');
      this.db = undefined;
    }
  }

  async saveCall(call: CallRecord): Promise<void> {
    if (!this.db) return;
    await this.calls().replaceOne({ _id: call.callId }, { ...call }, { upsert: true });
  }

  /**
   * Stores a lead, or throws so the caller hears it was not saved. Without MONGO_URI (memory-only by
   * choice) it is a no-op in development/test, but throws in production. Keyed by operationId or
   * call and time, so a retried save does not create a duplicate.
   */
  async saveLead(lead: LeadInfo): Promise<void> {
    if (!this.uri) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Durable database storage required in production to save leads');
      }
      return;
    }
    if (!this.db) throw new Error('MongoDB unavailable');
    const id = lead.operationId ? `${lead.callId}:${lead.operationId}` : `${lead.callId}:${lead.createdAt}`;
    await this.leads().replaceOne({ _id: id }, { ...lead }, { upsert: true });
  }

  async recentCalls(limit = 50): Promise<CallRecord[]> {
    if (!this.db) return [];
    return this.calls().find({}, { projection: { _id: 0 } }).sort({ startedAt: -1 }).limit(limit).toArray();
  }

  async recentLeads(limit = 100): Promise<LeadInfo[]> {
    if (!this.db) return [];
    return this.leads().find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(limit).toArray();
  }

  async saveHoursSnapshot(snapshot: HoursSnapshot): Promise<void> {
    if (!this.db) return;
    await this.db.collection('hours_snapshots').replaceOne(
      { _id: 'latest' as any },
      { ...snapshot, _id: 'latest' as any },
      { upsert: true },
    );
  }

  async loadLatestHoursSnapshot(): Promise<HoursSnapshot | undefined> {
    if (!this.db) return undefined;
    const doc = await this.db.collection('hours_snapshots').findOne({ _id: 'latest' as any });
    if (!doc) return undefined;
    const { _id, ...rest } = doc;
    const snapshot = parseHoursSnapshot(rest);
    if (!snapshot) this.logger.warn({ code: 'invalid_hours_snapshot' }, 'Hours snapshot rejected');
    return snapshot;
  }

  // ── SMS drafts and operations ───────────────────────────────
  // These methods throw when the database is absent: live sending must fail closed.

  async saveDraft(draft: MessageDraft): Promise<void> {
    // The filter _id becomes the stored _id on upsert.
    await this.messageDrafts().replaceOne({ _id: draft.draftId }, { ...draft }, { upsert: true });
  }

  async getDraft(draftId: string): Promise<MessageDraft | undefined> {
    const doc = await this.messageDrafts().findOne({ _id: draftId });
    if (!doc) return undefined;
    const { _id, ...draft } = doc;
    const parsed = draftRecordSchema.safeParse(draft);
    if (!parsed.success) throw new Error('Invalid stored SMS draft');
    return parsed.data;
  }

  async approveAfterCall(draftId: string, callId: string, version: number, consent: ConsentReference, channel: 'web' | 'phone'): Promise<boolean> {
    const result = await this.messageDrafts().updateOne({ _id: draftId, callId, version, status: 'prepared', consent: { $exists: false }, 'review.callerSequence': { $lt: consent.sequence } }, { $set: { delivery: 'after_call', consent, channel } });
    if (result.modifiedCount) return true;
    const draft = await this.getDraft(draftId);
    return !!draft && draft.callId === callId && draft.version === version && draft.status === 'prepared' && draft.channel === channel && JSON.stringify(draft.consent) === JSON.stringify(consent);
  }


  async saveReview(draftId: string, callId: string, version: number, review: ReviewReceipt): Promise<boolean> {
    if (!reviewSchema.safeParse(review).success) return false;
    const result = await this.messageDrafts().updateOne(
      { _id: draftId, callId, version, status: 'prepared', createdAt: { $lte: review.completedAt }, review: { $exists: false } }, { $set: { review } },
    );
    if (result.modifiedCount) return true;
    const draft = await this.getDraft(draftId);
    return !!draft && draft.callId === callId && draft.version === version && draft.status === 'prepared' && JSON.stringify(draft.review) === JSON.stringify(review);
  }

  async cancelPrepared(draftId: string, callId: string): Promise<'cancelled' | 'submitted' | 'missing'> {
    const result = await this.messageDrafts().updateOne({ _id: draftId, callId, status: 'prepared' }, { $set: { status: 'cancelled' } });
    if (result.modifiedCount) return 'cancelled';
    const draft = await this.getDraft(draftId);
    if (!draft || draft.callId !== callId) return 'missing';
    return draft.status === 'submitted' ? 'submitted' : 'cancelled';
  }

  async reserveSend(request: Reservation): Promise<ReservationResult> {
    if (!this.client || !this.db) throw new Error('Durable database storage is not connected');
    const session = this.client.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const fence = await this.db!.collection('sms_metadata').updateOne({ _id: 'dispatch' as any }, { $inc: { revision: 1 } }, { session });
        if (!fence.matchedCount) throw new Error('SMS reservation metadata missing');
        const doc = await this.messageDrafts().findOne({ _id: request.operation.draftId }, { session });
        let draft: MessageDraft | undefined;
        if (doc) { const { _id, ...value } = doc; draft = draftRecordSchema.parse(value); }
        const docs = await this.messageOperations().find({ $or: [
          { callId: request.operation.callId },
          { createdAt: { $gte: request.now - Math.max(86_400_000, request.cooldownMs) } },
        ] }, { session }).toArray();
        const operations = docs.map((item) => this.toOperation(item));
        const checked = checkReservation(draft, operations, request);
        if (checked) return checked;
        const changed = await this.messageDrafts().updateOne({ _id: request.operation.draftId, callId: request.operation.callId, version: request.expectedVersion, status: 'prepared' }, { $set: { status: 'submitted' } }, { session });
        if (!changed.modifiedCount) throw new Error('Draft changed during reservation');
        const operation = { ...request.operation, consent: request.consent };
        await this.messageOperations().insertOne({ ...operation, _id: operation.operationId }, { session });
        return { kind: 'reserved' as const, operation };
      });
      if (!result) throw new Error('Reservation result unavailable');
      return result;
    } finally { await session.endSession(); }
  }

  async saveCallback(messageId: string, status: 'delivered' | 'failed'): Promise<void> {
    const collection = this.durableDb().collection('sms_callback_receipts');
    await collection.updateOne({ _id: messageId as any }, { $addToSet: { statuses: status } } as any, { upsert: true });
  }
  async getCallback(messageId: string): Promise<'delivered' | 'failed' | undefined> {
    const doc = await this.durableDb().collection('sms_callback_receipts').findOne({ _id: messageId as any });
    if (!doc) return undefined;
    if (!Array.isArray(doc.statuses) || !doc.statuses.every((s: unknown) => s === 'delivered' || s === 'failed')) throw new Error('Invalid callback receipt');
    return doc.statuses.includes('delivered') ? 'delivered' : 'failed';
  }

  async setDraftStatus(draftId: string, status: MessageDraft['status']): Promise<void> {
    await this.messageDrafts().updateOne({ _id: draftId }, { $set: { status } });
  }

  async claimOperation(
    operation: MessageOperation,
  ): Promise<{ claimed: boolean; operation: MessageOperation }> {
    try {
      await this.messageOperations().insertOne({ ...operation, _id: operation.operationId });
      return { claimed: true, operation };
    } catch (err) {
      // Duplicate _id means a retry of the same operation; a duplicate draftId or
      // limitKey means another process already claimed this draft or purpose.
      if ((err as { code?: number }).code !== 11000) throw err;
      const existing =
        (await this.getOperationByDraft(operation.draftId)) ??
        (await this.getOperationByLimit(operation.limitKey)) ??
        (await this.getOperation(operation.operationId));
      if (!existing) throw err;
      return { claimed: false, operation: existing };
    }
  }

  async getOperation(operationId: string): Promise<MessageOperation | undefined> {
    const doc = await this.messageOperations().findOne({ _id: operationId });
    return doc ? this.toOperation(doc) : undefined;
  }

  async getOperationByDraft(draftId: string): Promise<MessageOperation | undefined> {
    const doc = await this.messageOperations().findOne({ draftId });
    return doc ? this.toOperation(doc) : undefined;
  }

  async getOperationByLimit(limitKey: string): Promise<MessageOperation | undefined> {
    const doc = await this.messageOperations().findOne({ limitKey });
    return doc ? this.toOperation(doc) : undefined;
  }

  async getOperationByProviderMessageId(messageId: string): Promise<MessageOperation | undefined> {
    const doc = await this.messageOperations().findOne({ providerMessageId: messageId });
    return doc ? this.toOperation(doc) : undefined;
  }

  async updateOperation(
    operationId: string,
    patch: Partial<Omit<MessageOperation, 'operationId' | 'draftId' | 'callId'>>,
  ): Promise<void> {
    // The filter stops a late callback from moving delivered back to accepted or failed.
    const { status, ...rest } = patch;
    if (Object.keys(rest).length) await this.messageOperations().updateOne({ _id: operationId }, { $set: rest });
    if (status) await this.messageOperations().updateOne(
      { _id: operationId, status: status === 'delivered' ? { $ne: 'delivered' } : { $nin: ['delivered', 'failed'] } },
      { $set: { status } },
    );
  }

  async listOperationsForCall(callId: string): Promise<MessageOperation[]> {
    const docs = await this.messageOperations().find({ callId }).sort({ createdAt: -1 }).toArray();
    return docs.map((doc) => this.toOperation(doc));
  }

  async listOperationsSince(since: number): Promise<MessageOperation[]> {
    const docs = await this.messageOperations()
      .find({ createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .toArray();
    return docs.map((doc) => this.toOperation(doc));
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  private toOperation(doc: Record<string, unknown>): MessageOperation {
    const { _id, ...operation } = doc;
    return operationRecordSchema.parse(operation);
  }

  private messageDrafts(): Collection<MessageDraft & { _id: string }> {
    return this.durableDb().collection('message_drafts');
  }

  private messageOperations(): Collection<MessageOperation & { _id: string }> {
    return this.durableDb().collection('message_operations');
  }

  private durableDb(): Db {
    if (!this.db) throw new Error('Durable database storage is not connected');
    return this.db;
  }

  private calls(): Collection<CallRecord & { _id: string }> {
    return this.db!.collection('calls');
  }

  // Leads saved before keyed saves have ObjectId _ids; reads project _id away.
  private leads(): Collection<LeadInfo & { _id: string }> {
    return this.db!.collection('leads');
  }
}
