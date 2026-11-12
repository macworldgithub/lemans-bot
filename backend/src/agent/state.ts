import type { Department } from '../shared/events.js';

export type RequestKind =
  | 'casual_booking'
  | 'event'
  | 'existing_booking'
  | 'complaint'
  | 'safety'
  | 'factual_question'
  | 'unknown';

export type CallChannel = 'web' | 'phone';

export type TransferStatus =
  | 'idle'
  | 'requested'
  | 'transferring'
  | 'transferred'
  | 'web-demo'
  | 'unavailable'
  | 'failed'
  | 'unknown';

export type CallOwnership = 'ai' | 'human';

export interface PendingLinkDraft {
  id: string;
  purpose: 'booking' | 'maps';
  recipient: string;
  version: number;
  readbackMessageId?: string;
  readbackCompleted: boolean;
  review?: { speechId: string; completedAt: number; callerSequence: number };
  consentMessageId?: string;
  sentOperationId?: string;
  scheduledAfterCall?: boolean;
  submissionState?: 'requesting' | 'unknown' | 'submitted';
}

export interface RequestUpdate {
  requestKind?: RequestKind;
  eventType?: string;
  headcount?: number;
  preferredDate?: string;
  notes?: string;
}

export interface CreateCallStateOptions {
  callId: string;
  channel?: CallChannel;
  callerNumber?: string;
  callerParticipantId?: string;
  now?: () => number;
}

export interface CallState {
  readonly callId: string;
  readonly channel: CallChannel;
  readonly callerNumber?: string;
  readonly callerParticipantId?: string;
  now: () => number;

  turnCount: number;
  committedCallerMessageIds: string[];
  lastCallerMessageId?: string;
  smsToolTurns: Map<string, { messageId: string; version: number }>;

  requestKind: RequestKind;
  eventType?: string;
  headcount?: number;
  preferredDate?: string;
  notes?: string;
  requestVersion: number;

  pendingDraft?: PendingLinkDraft;

  transferStatus: TransferStatus;
  activeTransferDepartment?: Department;
  callOwnership: CallOwnership;

  closingCheckVersion: number;
  activeTurnId?: string;
  pendingSideEffects: string[];
}

export function createCallState(options: CreateCallStateOptions): CallState {
  return {
    callId: options.callId,
    channel: options.channel ?? 'web',
    callerNumber: options.callerNumber,
    callerParticipantId: options.callerParticipantId,
    now: options.now ?? (() => Date.now()),

    turnCount: 0,
    committedCallerMessageIds: [],
    lastCallerMessageId: undefined,
    smsToolTurns: new Map(),

    requestKind: 'unknown',
    eventType: undefined,
    headcount: undefined,
    preferredDate: undefined,
    notes: undefined,
    requestVersion: 1,

    pendingDraft: undefined,

    transferStatus: 'idle',
    activeTransferDepartment: undefined,
    callOwnership: 'ai',

    closingCheckVersion: 1,
    activeTurnId: undefined,
    pendingSideEffects: [],
  };
}

export function recordCallerTurn(state: CallState, messageId: string): void {
  state.turnCount += 1;
  state.committedCallerMessageIds.push(messageId);
  state.lastCallerMessageId = messageId;
  state.closingCheckVersion += 1;
}

export function updateRequest(state: CallState, update: RequestUpdate): void {
  let changed = false;

  if (update.requestKind !== undefined && update.requestKind !== state.requestKind) {
    state.requestKind = update.requestKind;
    changed = true;
  }
  if (update.eventType !== undefined && update.eventType !== state.eventType) {
    state.eventType = update.eventType;
    changed = true;
  }
  if (update.headcount !== undefined && update.headcount !== state.headcount) {
    state.headcount = update.headcount;
    changed = true;
  }
  if (update.preferredDate !== undefined && update.preferredDate !== state.preferredDate) {
    state.preferredDate = update.preferredDate;
    changed = true;
  }
  if (update.notes !== undefined && update.notes !== state.notes) {
    state.notes = update.notes;
    changed = true;
  }

  if (changed) {
    state.requestVersion += 1;
    // Any change to the request invalidates a pending draft that was not submitted.
    // A draft with an operation is kept so its receipt is not lost.
    if (state.pendingDraft && !state.pendingDraft.sentOperationId && !state.pendingDraft.submissionState) {
      state.pendingDraft = undefined;
    }
  }
}

export function createPendingDraft(
  state: CallState,
  draft: { id: string; purpose: 'booking' | 'maps'; recipient: string; version?: number },
): PendingLinkDraft {
  const pending: PendingLinkDraft = {
    id: draft.id,
    purpose: draft.purpose,
    recipient: draft.recipient,
    version: draft.version ?? state.requestVersion,
    readbackMessageId: undefined,
    readbackCompleted: false,
    consentMessageId: undefined,
  };
  state.pendingDraft = pending;
  return pending;
}

export function cancelPendingDraft(state: CallState): boolean {
  if (!state.pendingDraft) return false;
  state.pendingDraft = undefined;
  return true;
}

export function markReadbackCompleted(state: CallState, messageId: string): boolean {
  if (!state.pendingDraft) return false;
  // The marker must be a real committed caller turn, never a model-supplied ID.
  if (!state.committedCallerMessageIds.includes(messageId)) return false;
  state.pendingDraft.readbackMessageId = messageId;
  state.pendingDraft.readbackCompleted = true;
  return true;
}

export function recordConsent(state: CallState, messageId: string): boolean {
  if (!state.pendingDraft) return false;
  if (!state.pendingDraft.readbackCompleted) return false;

  // Consent must be from a committed caller turn that occurred AFTER readback was completed
  const readbackIdx = state.pendingDraft.readbackMessageId
    ? state.committedCallerMessageIds.indexOf(state.pendingDraft.readbackMessageId)
    : -1;
  const consentIdx = state.committedCallerMessageIds.indexOf(messageId);

  if (consentIdx === -1 || consentIdx <= readbackIdx) {
    return false;
  }

  state.pendingDraft.consentMessageId = messageId;
  return true;
}

export function canSendDraft(
  state: CallState,
  draftId: string,
  version: number,
): { allowed: boolean; reason?: string } {
  if (!state.pendingDraft || state.pendingDraft.id !== draftId) {
    return { allowed: false, reason: 'Draft not found or draft mismatch' };
  }
  if (state.pendingDraft.version !== version) {
    return { allowed: false, reason: 'Draft version is stale' };
  }
  if (!state.pendingDraft.readbackCompleted) {
    return { allowed: false, reason: 'Readback was not completed' };
  }
  if (!state.pendingDraft.consentMessageId) {
    return { allowed: false, reason: 'Caller consent was not recorded' };
  }
  return { allowed: true };
}

export function startTransfer(
  state: CallState,
  department: Department,
): { allowed: boolean; reason?: string } {
  if (
    state.transferStatus === 'transferring' ||
    state.transferStatus === 'requested' ||
    state.transferStatus === 'transferred' ||
    state.transferStatus === 'web-demo' ||
    state.transferStatus === 'unknown'
  ) {
    return { allowed: false, reason: 'A transfer was already requested for this call' };
  }
  state.transferStatus = 'requested';
  state.activeTransferDepartment = department;
  return { allowed: true };
}

export function finishTransfer(state: CallState, status: TransferStatus): void {
  state.transferStatus = status;
  if (status !== 'transferring' && status !== 'requested') {
    state.activeTransferDepartment = undefined;
  }
}

export function setCallOwnership(state: CallState, ownership: CallOwnership): void {
  state.callOwnership = ownership;
}

/** After a human takes the call, the AI must not delete the room and cut them off. */
export function aiMayCloseRoom(state: CallState): boolean {
  return state.callOwnership !== 'human';
}
