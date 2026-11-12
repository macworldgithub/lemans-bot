import { describe, expect, it } from 'vitest';

import { evaluatePolicy } from '../src/agent/policy.js';
import { createCallState } from '../src/agent/state.js';

describe('Policy evaluation', () => {
  it('rejects direct transfer and routine callback for casual booking', () => {
    const state = createCallState({ callId: 'call-1' });
    state.requestKind = 'casual_booking';

    const transferDecision = evaluatePolicy(state, {
      type: 'transfer',
      department: 'reservations',
      reason: 'Wants to book 3 go-kart sessions for tonight',
    });
    expect(transferDecision.allowed).toBe(false);
    expect(transferDecision.recommendedAction).toBe('direct_to_website');
    expect(transferDecision.reason).toContain('Casual bookings');

    const leadDecision = evaluatePolicy(state, {
      type: 'save_lead',
      lead: {
        eventType: 'go-karts',
        name: 'John',
        phone: '0412345678',
      },
    });
    expect(leadDecision.allowed).toBe(false);
    expect(leadDecision.recommendedAction).toBe('direct_to_website');
  });

  it('treats a casual group of 50 as casual booking, not an automatic event', () => {
    const state = createCallState({ callId: 'call-2' });
    // Caller mentions 50 people for casual karting / arrive and drive
    const leadDecision = evaluatePolicy(state, {
      type: 'save_lead',
      lead: {
        eventType: 'casual go-karts',
        headcount: 50,
        name: 'Alex',
        phone: '0412345678',
        notes: 'Arrive and drive session for 50 people',
      },
    });

    expect(leadDecision.allowed).toBe(false);
    expect(leadDecision.recommendedAction).toBe('direct_to_website');
  });

  it('takes the approved events branch for explicit parties and corporate events', () => {
    const state = createCallState({ callId: 'call-3' });
    state.requestKind = 'event';

    const partyTransfer = evaluatePolicy(state, {
      type: 'transfer',
      department: 'corporate',
      reason: 'Company team building day for 25 people with catering',
    });
    expect(partyTransfer.allowed).toBe(true);
    expect(partyTransfer.recommendedAction).toBe('approved_events_handoff');

    const kidsPartyLead = evaluatePolicy(state, {
      type: 'save_lead',
      lead: {
        eventType: 'kids party',
        headcount: 12,
        name: 'Sarah',
        phone: '0412345678',
      },
    });
    expect(kidsPartyLead.allowed).toBe(true);
    expect(kidsPartyLead.recommendedAction).toBe('approved_events_handoff');
  });

  it('distinguishes unknown from unavailable and rejects routine staff transfers for unknown requests', () => {
    const state = createCallState({ callId: 'call-4' });
    state.requestKind = 'unknown';

    const unknownTransfer = evaluatePolicy(state, {
      type: 'transfer',
      department: 'reservations',
      reason: 'General inquiry with no specified details',
    });
    expect(unknownTransfer.allowed).toBe(false);
    expect(unknownTransfer.recommendedAction).toBe('unknown_recovery');
  });

  it('keeps support and safety exceptions strictly scoped', () => {
    const supportState = createCallState({ callId: 'call-5' });
    supportState.requestKind = 'existing_booking';

    const supportTransfer = evaluatePolicy(supportState, {
      type: 'transfer',
      department: 'reservations',
      reason: 'Need to change time of existing booking #12345',
    });
    expect(supportTransfer.allowed).toBe(true);
    expect(supportTransfer.recommendedAction).toBe('approved_support_route');

    // Support cannot route to corporate
    const invalidDeptTransfer = evaluatePolicy(supportState, {
      type: 'transfer',
      department: 'corporate',
      reason: 'Need to change time of existing booking #12345',
    });
    expect(invalidDeptTransfer.allowed).toBe(false);

    // Safety state routes to duty manager
    const safetyState = createCallState({ callId: 'call-6' });
    safetyState.requestKind = 'safety';

    const safetyTransfer = evaluatePolicy(safetyState, {
      type: 'transfer',
      department: 'duty_manager',
      reason: 'Minor track injury reported',
    });
    expect(safetyTransfer.allowed).toBe(true);
    expect(safetyTransfer.recommendedAction).toBe('urgent_safety_guidance');

    // Safety cannot route to reservations
    const wrongSafetyDept = evaluatePolicy(safetyState, {
      type: 'transfer',
      department: 'reservations',
      reason: 'Track incident inquiry',
    });
    expect(wrongSafetyDept.allowed).toBe(false);
  });
});
