import { MongoClient, type Collection, type Db } from 'mongodb';
import type { Logger } from 'pino';

import type { LeadInfo } from '../shared/events.js';
import type { CallRecord } from './store.js';

/** Persists finished calls and leads. Without MONGO_URI it runs in memory-only mode. */
export class Database {
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
   * choice) it is a no-op. Keyed by call and time, so a retried save does not create a duplicate.
   */
  async saveLead(lead: LeadInfo): Promise<void> {
    if (!this.uri) return;
    if (!this.db) throw new Error('MongoDB unavailable');
    await this.leads().replaceOne({ _id: `${lead.callId}:${lead.createdAt}` }, { ...lead }, { upsert: true });
  }

  async recentCalls(limit = 50): Promise<CallRecord[]> {
    if (!this.db) return [];
    return this.calls().find({}, { projection: { _id: 0 } }).sort({ startedAt: -1 }).limit(limit).toArray();
  }

  async recentLeads(limit = 100): Promise<LeadInfo[]> {
    if (!this.db) return [];
    return this.leads().find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(limit).toArray();
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  private calls(): Collection<CallRecord & { _id: string }> {
    return this.db!.collection('calls');
  }

  // Leads saved before keyed saves have ObjectId _ids; reads project _id away.
  private leads(): Collection<LeadInfo & { _id: string }> {
    return this.db!.collection('leads');
  }
}
