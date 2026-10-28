import { log } from '@livekit/agents';

import type { AgentEvent, LeadInfo } from '../shared/events.js';

/**
 * Sends call events to the API in order. Delivery is best effort: a down API must never
 * break a live call, so failures are logged and dropped.
 */
export class EventReporter {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly apiUrl: string,
    private readonly secret: string,
  ) {}

  send(event: AgentEvent): void {
    this.chain = this.chain.then(() => this.post(event));
  }

  /**
   * Saves a lead and resolves only once the API has stored it (one retry on a timeout or server
   * error). Unlike call events, a lost lead is a lost customer, so failure throws.
   */
  async saveLead(lead: LeadInfo): Promise<void> {
    let error = new Error('lead not saved');
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(`${this.apiUrl}/internal/leads`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-internal-secret': this.secret },
          body: JSON.stringify(lead),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) return;
        error = new Error(`API answered ${res.status}`);
        if (res.status < 500) break; // rejected, retrying will not help
      } catch (err) {
        error = err as Error;
      }
    }
    throw error;
  }

  /** Resolves once everything queued so far has been attempted. */
  flush(): Promise<void> {
    return this.chain;
  }

  private async post(event: AgentEvent): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/internal/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': this.secret },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) log().warn({ status: res.status, type: event.type }, 'API rejected agent event');
    } catch (err) {
      log().warn({ err: (err as Error).message, type: event.type }, 'could not deliver agent event');
    }
  }
}
