// Wire format between the agent worker, the API and the browser.
// The frontend keeps a copy of these shapes in frontend/src/lib/transcript.ts.

export type CallSource = 'web' | 'phone';
export type Role = 'bot' | 'user';

export type Department = 'reservations' | 'corporate' | 'duty_manager';

export interface TranscriptEvent {
  callId: string;
  /** Stable id of the line (one per user turn / agent reply). */
  id: string;
  role: Role;
  /** interim replaces the line text, final replaces it and closes the line. */
  kind: 'interim' | 'final' | 'interrupted';
  text?: string;
  ts: number;
}

export interface LeadInfo {
  callId: string;
  name: string;
  phone?: string;
  email?: string;
  eventType: string;
  preferredDate?: string;
  headcount?: number;
  notes?: string;
  createdAt: number;
}

export interface TransferInfo {
  callId: string;
  department: Department;
  reason: string;
  target?: string;
  status: 'transferring' | 'unavailable' | 'failed';
  ts: number;
}

export interface TurnMetrics {
  /** Caller stopped speaking → agent audio started, in ms. */
  e2eMs?: number;
  eouMs?: number;
  llmTtftMs?: number;
  ttsTtfbMs?: number;
  /** LiveKit's own end-to-end figure (cascade only), measured from its end-of-speech estimate. */
  frameworkE2eMs?: number;
}

/** Best-effort call events the agent posts to the API. Leads have their own confirmed endpoint. */
export type AgentEvent =
  | { type: 'call-started'; callId: string; source: CallSource; callerNumber?: string; startedAt: number }
  | { type: 'call-ended'; callId: string; endedAt: number; reason?: string }
  | { type: 'transcript'; event: TranscriptEvent }
  | { type: 'transfer'; transfer: TransferInfo }
  | { type: 'metrics'; callId: string; metrics: TurnMetrics; ts: number };

/** What the monitor feed streams: the agent's events plus stored leads. */
export type MonitorEvent = AgentEvent | { type: 'lead-saved'; lead: LeadInfo };

/** Topic the agent publishes UI notices on (lead saved, transfer) for the web demo. */
export const NOTICE_TOPIC = 'lemans.notice';
