import type { Department } from '../shared/events.js';
import type { CallState, RequestKind } from './state.js';

export type ProposedAction =
  | {
      type: 'transfer';
      department: Department;
      reason: string;
    }
  | {
      type: 'save_lead';
      lead: {
        eventType: string;
        headcount?: number;
        name?: string;
        phone?: string;
        notes?: string;
      };
    };

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  recommendedAction?:
    | 'direct_to_website'
    | 'offer_sms'
    | 'approved_events_handoff'
    | 'approved_support_route'
    | 'approved_manager_route'
    | 'urgent_safety_guidance'
    | 'unknown_recovery';
}

const CASUAL_PATTERNS = /\b(casual|go-?kart|laser|vr|virtual reality|mini-?golf|general visit|arrive and drive|practice)\b/i;
const EVENT_PATTERNS = /\b(kids party|teen party|birthday|party|corporate|bucks|hens|function|team-?building|event)\b/i;
const EXISTING_BOOKING_PATTERNS = /\b(change|cancel|existing|reschedule|already booked|confirmation)\b/i;
const COMPLAINT_PATTERNS = /\b(complaint|refund|manager|dispute|issue|unhappy)\b/i;
const SAFETY_PATTERNS = /\b(injury|incident|safety|accident|pregnant|first aid|emergency)\b/i;

export function isCasualBooking(
  requestKind: RequestKind,
  text?: string,
  eventType?: string,
): boolean {
  if (requestKind === 'casual_booking') return true;
  if (requestKind === 'event') return false;

  const combined = `${text ?? ''} ${eventType ?? ''}`.trim();
  if (!combined) return false;

  // Even if headcount is 50, if it's casual karting/visit without event keywords, it's casual
  if (EVENT_PATTERNS.test(combined)) return false;
  return CASUAL_PATTERNS.test(combined);
}

export function evaluatePolicy(state: CallState, action: ProposedAction): PolicyDecision {
  // 1. Casual bookings (karts, VR, laser tag, mini golf, general visits)
  if (
    state.requestKind === 'casual_booking' ||
    (action.type === 'save_lead' && isCasualBooking(state.requestKind, action.lead.notes, action.lead.eventType)) ||
    (action.type === 'transfer' && isCasualBooking(state.requestKind, action.reason))
  ) {
    return {
      allowed: false,
      reason:
        'Casual bookings (go-karts, laser tag, VR, mini golf, and general visits) must be made online at lemansgokarts.com.au. Routine transfers and callback leads are not permitted.',
      recommendedAction: 'direct_to_website',
    };
  }

  // 2. Explicit events (parties, corporate, functions)
  const isExplicitEvent =
    state.requestKind === 'event' ||
    (action.type === 'save_lead' && EVENT_PATTERNS.test(action.lead.eventType)) ||
    (action.type === 'transfer' && EVENT_PATTERNS.test(action.reason));

  if (isExplicitEvent) {
    if (action.type === 'transfer') {
      if (action.department === 'corporate' || action.department === 'reservations') {
        return {
          allowed: true,
          reason: 'Eligible event request permitted for events handoff.',
          recommendedAction: 'approved_events_handoff',
        };
      }
      return {
        allowed: false,
        reason: `Events handoff cannot be routed to ${action.department}.`,
      };
    }

    if (action.type === 'save_lead') {
      return {
        allowed: true,
        reason: 'Event callback lead permitted when transfer is unavailable or requested.',
        recommendedAction: 'approved_events_handoff',
      };
    }
  }

  // 3. Existing booking issues / changes
  const isExistingBooking =
    state.requestKind === 'existing_booking' ||
    (action.type === 'save_lead' && EXISTING_BOOKING_PATTERNS.test(action.lead.eventType)) ||
    (action.type === 'transfer' && EXISTING_BOOKING_PATTERNS.test(action.reason));

  if (isExistingBooking) {
    if (action.type === 'transfer') {
      if (action.department === 'reservations') {
        return {
          allowed: true,
          reason: 'Existing booking problem permitted for support route.',
          recommendedAction: 'approved_support_route',
        };
      }
      return {
        allowed: false,
        reason: `Existing booking support cannot route to ${action.department}.`,
      };
    }
    return {
      allowed: true,
      reason: 'Existing booking callback permitted.',
      recommendedAction: 'approved_support_route',
    };
  }

  // 4. Complaints
  const isComplaint =
    state.requestKind === 'complaint' ||
    (action.type === 'save_lead' && COMPLAINT_PATTERNS.test(action.lead.eventType)) ||
    (action.type === 'transfer' && COMPLAINT_PATTERNS.test(action.reason));

  if (isComplaint) {
    if (action.type === 'transfer') {
      if (action.department === 'duty_manager') {
        return {
          allowed: true,
          reason: 'Complaint routed to duty manager.',
          recommendedAction: 'approved_manager_route',
        };
      }
      return {
        allowed: false,
        reason: `Complaints must route to duty_manager, not ${action.department}.`,
      };
    }
    return {
      allowed: true,
      reason: 'Complaint callback lead permitted for duty manager.',
      recommendedAction: 'approved_manager_route',
    };
  }

  // 5. Safety or emergency
  const isSafety =
    state.requestKind === 'safety' ||
    (action.type === 'save_lead' && SAFETY_PATTERNS.test(action.lead.eventType)) ||
    (action.type === 'transfer' && SAFETY_PATTERNS.test(action.reason));

  if (isSafety) {
    if (action.type === 'transfer' && action.department === 'duty_manager') {
      return {
        allowed: true,
        reason: 'Safety matter routed to duty manager.',
        recommendedAction: 'urgent_safety_guidance',
      };
    }
    return {
      allowed: false,
      reason: 'Urgent safety matters must follow on-site/000 guidance.',
      recommendedAction: 'urgent_safety_guidance',
    };
  }

  // 6. Factual questions
  if (state.requestKind === 'factual_question') {
    return {
      allowed: false,
      reason: 'Factual questions cannot be transferred to staff or converted to routine callbacks.',
      recommendedAction: 'direct_to_website',
    };
  }

  // 7. Unknown request or general unclassified action
  return {
    allowed: false,
    reason: 'Routine transfers and callback leads are not permitted without an approved event, existing booking, complaint, or safety matter.',
    recommendedAction: 'unknown_recovery',
  };
}
