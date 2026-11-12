/**
 * Owns the per-turn recovery deadline.
 *
 * The 3-second value is a response target, not a provider guarantee.
 * The worker measures from the end of caller audio to the start of useful audio.
 * Full-duplex speech only records delays. Other modes can give one waiting cue.
 * The timer never starts a transfer, saves a lead, or sends a message.
 */

import { voice } from '@livekit/agents';

export const DEFAULT_RECOVERY_MS = 3_000;

/** Wire runtime events separately so their ordering can be tested with the SDK emitter. */
export function bindResponseGuard<UserData>(session: voice.AgentSession<UserData>, guard: ResponseGuard): () => void {
  let utterance = 0;
  const onUser = (event: voice.UserStateChangedEvent) => {
    if (event.newState === 'speaking') guard.cancel();
    if (event.oldState === 'speaking' && event.newState === 'listening' && session.agentState !== 'speaking') {
      guard.beginTurn(`audio-${++utterance}`);
    }
  };
  const onAgent = (event: voice.AgentStateChangedEvent) => {
    if (event.newState === 'speaking') guard.answerStarted(guard.activeTurnId);
  };
  const cleanup = () => {
    guard.close();
    session.off(voice.AgentSessionEventTypes.UserStateChanged, onUser);
    session.off(voice.AgentSessionEventTypes.AgentStateChanged, onAgent);
    session.off(voice.AgentSessionEventTypes.Close, cleanup);
  };
  session.on(voice.AgentSessionEventTypes.UserStateChanged, onUser);
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, onAgent);
  session.on(voice.AgentSessionEventTypes.Close, cleanup);
  return cleanup;
}

export type ResponseGuardTurnState = 'waiting' | 'slow' | 'answered' | 'recovering' | 'cancelled';

export interface ResponseGuardOptions {
  /** Full-duplex models own their speech. Observe a delay without injecting a new reply. */
  mode?: 'recover' | 'observe';
  onSlow?: (turnId: string, elapsedMs: number) => void | Promise<void>;
  /** Target time from the end of caller audio to an answer. */
  timeoutMs?: number;
  /** Called at most once per turn, only when no useful answer has started. */
  onRecovery: (turnId: string, elapsedMs: number) => void | Promise<void>;
  /** Safe hook for logging. Must not contain caller text. */
  onError?: (error: unknown) => void;
  now?: () => number;
}

interface ActiveTurn {
  id: string;
  startedAt: number;
  state: ResponseGuardTurnState;
  timer?: ReturnType<typeof setTimeout>;
}

export class ResponseGuard {
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private activeTurn?: ActiveTurn;
  private closed = false;

  constructor(private readonly options: ResponseGuardOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RECOVERY_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Start a deadline for a new caller utterance and cancel the old one. */
  beginTurn(turnId: string): boolean {
    if (this.closed) return false;
    this.cancel();
    const turn: ActiveTurn = {
      id: turnId,
      startedAt: this.now(),
      state: 'waiting',
    };
    turn.timer = setTimeout(() => this.fireRecovery(turn), this.timeoutMs);
    this.activeTurn = turn;
    return true;
  }

  /**
   * Record that an answer or useful recovery audio began.
   * Returns false for a late answer after recovery, a stale turn, or a closed call.
   */
  answerStarted(turnId?: string): boolean {
    const turn = this.activeTurn;
    if (!turn || (turn.state !== 'waiting' && turn.state !== 'slow')) return false;
    if (turnId !== undefined && turn.id !== turnId) return false;
    this.clearTimer(turn);
    turn.state = 'answered';
    return true;
  }

  /** Use the recovery at once for a true unknown result, such as a provider error. */
  failCurrent(turnId?: string): boolean {
    const turn = this.activeTurn;
    if (!turn || turn.state !== 'waiting') return false;
    if (turnId !== undefined && turn.id !== turnId) return false;
    this.fireRecovery(turn);
    return true;
  }

  /** Cancel the current deadline, for example on barge-in, new turn, or transfer. */
  cancel(): void {
    const turn = this.activeTurn;
    if (!turn) return;
    this.clearTimer(turn);
    if (turn.state === 'waiting') turn.state = 'cancelled';
    this.activeTurn = undefined;
  }

  /** Permanently stop the guard when the call ends. */
  close(): void {
    this.closed = true;
    this.cancel();
  }

  get activeTurnId(): string | undefined {
    return this.activeTurn?.id;
  }

  get awaitingAnswer(): boolean {
    return this.activeTurn?.state === 'waiting';
  }

  get recovering(): boolean {
    return this.activeTurn?.state === 'recovering';
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private fireRecovery(turn: ActiveTurn): void {
    if (turn.state !== 'waiting') return;
    const observe = this.options.mode === 'observe';
    turn.state = observe ? 'slow' : 'recovering';
    this.clearTimer(turn);
    const elapsedMs = this.now() - turn.startedAt;
    try {
      const callback = observe ? this.options.onSlow : this.options.onRecovery;
      const result = callback?.(turn.id, elapsedMs);
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch((error) => this.options.onError?.(error));
      }
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private clearTimer(turn: ActiveTurn): void {
    if (turn.timer !== undefined) {
      clearTimeout(turn.timer);
      turn.timer = undefined;
    }
  }
}
