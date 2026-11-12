import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ResponseGuard, type ResponseGuardOptions } from '../src/agent/response-guard.js';

function makeGuard(overrides: Partial<ResponseGuardOptions> = {}) {
  const recoveries: { turnId: string; elapsedMs: number }[] = [];
  const onError = vi.fn();
  const guard = new ResponseGuard({
    onRecovery: (turnId, elapsedMs) => {
      recoveries.push({ turnId, elapsedMs });
    },
    onError,
    ...overrides,
  });
  return { guard, recoveries, onError };
}

describe('ResponseGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not recover before 3,000 ms and recovers once at 3,000 ms', () => {
    const { guard, recoveries } = makeGuard();
    guard.beginTurn('turn-1');

    vi.advanceTimersByTime(2_999);
    expect(recoveries).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(recoveries).toEqual([{ turnId: 'turn-1', elapsedMs: 3_000 }]);

    vi.advanceTimersByTime(10_000);
    expect(recoveries).toHaveLength(1);
  });

  it('lets an answer win the timer', () => {
    const { guard, recoveries } = makeGuard();
    guard.beginTurn('turn-1');
    vi.advanceTimersByTime(2_999);

    expect(guard.answerStarted('turn-1')).toBe(true);
    vi.advanceTimersByTime(5_000);

    expect(recoveries).toHaveLength(0);
    expect(guard.answerStarted('turn-1')).toBe(false);
  });

  it('makes recovery win a late answer and blocks double speech', () => {
    const { guard, recoveries } = makeGuard();
    guard.beginTurn('turn-1');
    vi.advanceTimersByTime(3_000);

    expect(recoveries).toHaveLength(1);
    expect(guard.answerStarted('turn-1')).toBe(false);
    expect(guard.recovering).toBe(true);

    vi.advanceTimersByTime(10_000);
    expect(recoveries).toHaveLength(1);
  });

  it('cancels the old deadline on a barge-in or a new caller turn', () => {
    const { guard, recoveries } = makeGuard();
    guard.beginTurn('turn-1');
    vi.advanceTimersByTime(1_000);

    guard.cancel(); // barge-in
    guard.beginTurn('turn-2');
    vi.advanceTimersByTime(3_000);

    expect(recoveries).toEqual([{ turnId: 'turn-2', elapsedMs: 3_000 }]);
  });

  it('ignores a stale turn ID', () => {
    const { guard, recoveries } = makeGuard();
    guard.beginTurn('turn-2');

    expect(guard.answerStarted('turn-1')).toBe(false);
    expect(guard.awaitingAnswer).toBe(true);

    vi.advanceTimersByTime(3_000);
    expect(recoveries).toHaveLength(1);
  });

  it('stops all recovery after close', () => {
    const { guard, recoveries } = makeGuard();
    guard.beginTurn('turn-1');
    guard.close();

    vi.advanceTimersByTime(10_000);
    expect(recoveries).toHaveLength(0);
    expect(guard.isClosed).toBe(true);
    expect(guard.beginTurn('turn-2')).toBe(false);
  });

  it('cancels recovery when a transfer starts', () => {
    const { guard, recoveries } = makeGuard();
    guard.beginTurn('turn-1');
    vi.advanceTimersByTime(2_500);
    guard.cancel(); // transfer boundary

    vi.advanceTimersByTime(10_000);
    expect(recoveries).toHaveLength(0);
  });

  it('uses recovery at once for a true unknown result', () => {
    const { guard, recoveries } = makeGuard();
    guard.beginTurn('turn-1');

    expect(guard.failCurrent('turn-1')).toBe(true);
    expect(recoveries).toHaveLength(1);

    vi.advanceTimersByTime(5_000);
    expect(recoveries).toHaveLength(1);
    expect(guard.answerStarted('turn-1')).toBe(false);
  });

  it('does not recover after an answer, even if a provider error follows', () => {
    const { guard, recoveries } = makeGuard();
    guard.beginTurn('turn-1');
    guard.answerStarted('turn-1');

    expect(guard.failCurrent('turn-1')).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(recoveries).toHaveLength(0);
  });

  it('reports a recovery handler failure without speaking twice', () => {
    const onError = vi.fn();
    const guard = new ResponseGuard({
      onRecovery: () => {
        throw new Error('speech unavailable');
      },
      onError,
    });
    guard.beginTurn('turn-1');

    vi.advanceTimersByTime(3_000);
    expect(onError).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(5_000);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('handles an async recovery rejection safely', async () => {
    const onError = vi.fn();
    const guard = new ResponseGuard({
      onRecovery: async () => {
        throw new Error('speech unavailable');
      },
      onError,
    });
    guard.beginTurn('turn-1');

    vi.advanceTimersByTime(3_000);
    await Promise.resolve();
    expect(onError).toHaveBeenCalledOnce();
  });
});
