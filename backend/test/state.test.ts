import { describe, expect, it } from 'vitest';

import {
  canSendDraft,
  createCallState,
  createPendingDraft,
  finishTransfer,
  markReadbackCompleted,
  recordCallerTurn,
  recordConsent,
  startTransfer,
  updateRequest,
} from '../src/agent/state.js';

describe('Call state', () => {
  it('keeps two calls completely separate without shared state', () => {
    const call1 = createCallState({ callId: 'call-a', channel: 'phone', callerNumber: '0411111111' });
    const call2 = createCallState({ callId: 'call-b', channel: 'web' });

    updateRequest(call1, { requestKind: 'event', headcount: 20 });
    recordCallerTurn(call1, 'msg-1');

    expect(call1.requestKind).toBe('event');
    expect(call1.headcount).toBe(20);
    expect(call1.turnCount).toBe(1);

    expect(call2.requestKind).toBe('unknown');
    expect(call2.headcount).toBeUndefined();
    expect(call2.turnCount).toBe(0);
  });

  it('updates only the corrected field and increments the request version', () => {
    const state = createCallState({ callId: 'call-test' });
    expect(state.requestVersion).toBe(1);

    updateRequest(state, { requestKind: 'event', headcount: 10, preferredDate: 'Saturday' });
    expect(state.requestVersion).toBe(2);
    expect(state.requestKind).toBe('event');
    expect(state.headcount).toBe(10);
    expect(state.preferredDate).toBe('Saturday');

    // Correction to headcount only
    updateRequest(state, { headcount: 15 });
    expect(state.requestVersion).toBe(3);
    expect(state.headcount).toBe(15);
    expect(state.requestKind).toBe('event');
    expect(state.preferredDate).toBe('Saturday');
  });

  it('fails confirmation if readback was interrupted or never completed', () => {
    const state = createCallState({ callId: 'call-draft-test' });
    recordCallerTurn(state, 'msg-caller-1');

    const draft = createPendingDraft(state, {
      id: 'draft-101',
      purpose: 'booking',
      recipient: '+61412345678',
    });

    // Caller says yes before readback completes
    recordCallerTurn(state, 'msg-caller-2');
    const consentRecorded = recordConsent(state, 'msg-caller-2');
    expect(consentRecorded).toBe(false);

    const check = canSendDraft(state, draft.id, draft.version);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('Readback was not completed');
  });

  it('fails if caller consent reference is older than or equal to readback message', () => {
    const state = createCallState({ callId: 'call-seq' });
    recordCallerTurn(state, 'turn-1');
    recordCallerTurn(state, 'turn-2');

    const draft = createPendingDraft(state, {
      id: 'draft-102',
      purpose: 'maps',
      recipient: '+61412345678',
    });

    // Readback occurs on turn-2
    markReadbackCompleted(state, 'turn-2');

    // Attempting consent from turn-1 or turn-2 (not after readback)
    const oldConsent = recordConsent(state, 'turn-1');
    expect(oldConsent).toBe(false);

    const sameTurnConsent = recordConsent(state, 'turn-2');
    expect(sameTurnConsent).toBe(false);

    // Consent on turn-3 succeeds
    recordCallerTurn(state, 'turn-3');
    const validConsent = recordConsent(state, 'turn-3');
    expect(validConsent).toBe(true);

    const sendCheck = canSendDraft(state, draft.id, draft.version);
    expect(sendCheck.allowed).toBe(true);
  });

  it('cancels pending draft and increments version when a request change occurs', () => {
    const state = createCallState({ callId: 'call-cancel' });
    updateRequest(state, { requestKind: 'casual_booking' });

    createPendingDraft(state, {
      id: 'draft-103',
      purpose: 'booking',
      recipient: '+61412345678',
    });
    expect(state.pendingDraft).toBeDefined();

    // Caller corrects their request to an event before consent is finished
    updateRequest(state, { requestKind: 'event', headcount: 25 });
    expect(state.pendingDraft).toBeUndefined();
    expect(state.requestVersion).toBe(3);
  });

  it('prevents concurrent transfers on the same call', () => {
    const state = createCallState({ callId: 'call-transfer' });
    const firstTransfer = startTransfer(state, 'corporate');
    expect(firstTransfer.allowed).toBe(true);
    expect(state.transferStatus).toBe('requested');

    const secondTransfer = startTransfer(state, 'reservations');
    expect(secondTransfer.allowed).toBe(false);
    expect(secondTransfer.reason).toContain('already requested');

    // Once the provider reports completion, a duplicate tool call must not dial again.
    finishTransfer(state, 'transferred');
    expect(startTransfer(state, 'reservations').allowed).toBe(false);

    // An uncertain transfer result must never be retried.
    const uncertain = createCallState({ callId: 'call-uncertain' });
    startTransfer(uncertain, 'corporate');
    finishTransfer(uncertain, 'unknown');
    expect(startTransfer(uncertain, 'corporate').allowed).toBe(false);
  });
});
