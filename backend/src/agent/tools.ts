import { llm } from '@livekit/agents';
import { z } from 'zod';

import type { Department, LeadInfo } from '../shared/events.js';
import { normalizeAustralianMobile } from '../messaging/service.js';
import type { ConsentReference, ReviewReceipt } from '../messaging/schema.js';
import { evaluatePolicy } from './policy.js';
import {
  canSendDraft,
  cancelPendingDraft,
  createCallState,
  createPendingDraft,
  finishTransfer,
  startTransfer,
  updateRequest,
  type CallState,
} from './state.js';

export type TransferOutcome =
  | { status: 'transferred' }
  | { status: 'web-demo' }
  | { status: 'unavailable' }
  | { status: 'failed'; error: string }
  | { status: 'unknown'; error: string };

/** Side effects the tools need. The worker wires real ones; tests pass fakes. */
export interface CallServices {
  callId: string;
  saveLead(lead: Omit<LeadInfo, 'callId' | 'createdAt'> & { operationId?: string }): Promise<void>;
  transfer(department: Department, reason: string): Promise<TransferOutcome>;
  /** Speaks the goodbye (always, so the caller never hears a silent hang-up), then hangs up. */
  endCall(goodbye: string): Promise<void>;
  lookupHours?(query: { date?: string; schedule: 'venue' | 'bookings' | 'large_events' }): Promise<{
    status: 'current' | 'stale' | 'unknown';
    date: string;
    schedule: string;
    closed?: boolean;
    opens?: string;
    closes?: string;
    closesNextDay?: boolean;
    isOpenNow?: boolean;
  }>;
  prepareLinkSms?(params: { purpose: 'booking' | 'maps'; phone: string; version: number }): Promise<{
    draftId: string;
    recipient: string;
    version: number;
  }>;
  reviewLinkSms?(params: { draftId: string; version: number; purpose: 'booking' | 'maps'; recipient: string }): Promise<ReviewReceipt | undefined>;
  /** Resolve the generation's captured caller message, never the latest turn. */
  getSmsConsent?(context: unknown): ConsentReference | undefined;
  sendLinkSms?(params: { draftId: string; version: number; consent: ConsentReference }): Promise<{
    status: 'scheduled' | 'accepted' | 'simulated' | 'failed' | 'delivered' | 'sending' | 'unknown' | 'unavailable';
    operationId?: string;
    error?: string;
  }>;
  cancelLinkSms?(params: { draftId: string; version: number }): Promise<void>;
}

export interface CallUserData {
  services: CallServices;
  state?: CallState;
}

function getState(userData: CallUserData): CallState {
  if (!userData.state) {
    userData.state = createCallState({ callId: userData.services.callId, channel: 'web' });
  }
  return userData.state;
}

const DEPARTMENT_LABEL: Record<Department, string> = {
  reservations: 'the reservations team',
  corporate: 'the corporate events team',
  duty_manager: 'the duty manager',
};

export const recordRequest = llm.tool({
  name: 'record_request',
  description:
    'Record the type of inquiry the caller is making and any details they volunteered. ' +
    'Call this when the caller clarifies what they need (e.g. casual booking, event, existing booking, complaint).',
  parameters: z.object({
    requestKind: z
      .enum([
        'casual_booking',
        'event',
        'existing_booking',
        'complaint',
        'safety',
        'factual_question',
        'unknown',
      ])
      .describe('The kind of request'),
    eventType: z
      .string()
      .optional()
      .describe('Specific event or activity (e.g., kids party, corporate, casual karts)'),
    headcount: z.number().int().positive().optional().describe('Number of people if stated'),
    preferredDate: z.string().optional().describe('Preferred date if stated'),
    notes: z.string().optional().describe('Additional volunteered notes'),
  }),
  execute: async (args, { ctx }) => {
    const userData = ctx.userData as CallUserData;
    const state = getState(userData);
    const previousDraft = state.pendingDraft;
    updateRequest(state, args);
    // A request change makes an unsent draft stale. Cancel it at the API too.
    if (
      previousDraft &&
      previousDraft !== state.pendingDraft &&
      !previousDraft.sentOperationId &&
      !previousDraft.submissionState &&
      userData.services.cancelLinkSms
    ) {
      await userData.services
        .cancelLinkSms({ draftId: previousDraft.id, version: previousDraft.version })
        .catch(() => undefined);
    }
    return `Recorded request as ${args.requestKind}. Version ${state.requestVersion}.`;
  },
});

export const saveLead = llm.tool({
  name: 'save_lead',
  description:
    'Save caller contact details for events, corporate inquiries, existing booking issues, or manager complaints ' +
    'when the team is unavailable or the caller prefers a callback. Collect details first and read back the phone number. ' +
    'DO NOT use for casual bookings (karts, laser tag, VR, mini golf) - casual bookings must book online.',
  parameters: z.object({
    name: z.string().describe("Caller's name"),
    phone: z.string().optional().describe('Mobile number, digits only, as confirmed by the caller'),
    email: z.string().optional().describe('Email, if the caller offered one'),
    eventType: z
      .string()
      .describe('What they want: kids party, teen party, bucks/hens, corporate, booking change, complaint, other'),
    preferredDate: z.string().optional().describe('Date or day they want, as the caller said it'),
    headcount: z.number().int().positive().optional().describe('Number of people'),
    notes: z.string().optional().describe('Anything else staff should know (ages, catering, questions)'),
  }),
  execute: async (args, { ctx }) => {
    const userData = ctx.userData as CallUserData;
    const { services } = userData;
    const state = getState(userData);

    const decision = evaluatePolicy(state, { type: 'save_lead', lead: args });
    if (!decision.allowed) {
      return `Policy notice: Callback lead not permitted: ${decision.reason}. Direct the caller to online booking at lemansgokarts.com.au or the website.`;
    }

    // Stable per request version, so an HTTP retry replaces the same record instead of duplicating it.
    const operationId = `lead-v${state.requestVersion}`;
    try {
      await services.saveLead({ ...args, operationId });
      return 'Lead saved. Tell the caller the team will call them back.';
    } catch (_err) {
      throw new llm.ToolError(
        'Could not save the details. Apologise and give them the email info@lemansgokarts.com.au.',
      );
    }
  },
});

export const transferCall = llm.tool({
  name: 'transfer_call',
  description:
    'Put the caller through to a human team for eligible events, existing booking problems, or manager complaints. ' +
    'Only call after the caller agreed to be transferred. ' +
    'corporate: company and team events. reservations: events handoff and existing booking problems. duty_manager: complaints, incidents, injuries. ' +
    'DO NOT transfer casual bookings (go-karts, VR, laser tag, mini golf) - direct them to book online.',
  parameters: z.object({
    department: z.enum(['reservations', 'corporate', 'duty_manager']),
    reason: z.string().describe('One sentence summary of what the caller needs, for the staff member'),
  }),
  execute: async ({ department, reason }, { ctx }) => {
    const userData = ctx.userData as CallUserData;
    const { services } = userData;
    const state = getState(userData);

    const decision = evaluatePolicy(state, { type: 'transfer', department, reason });
    if (!decision.allowed) {
      return `Policy notice: Transfer not permitted: ${decision.reason}. Direct the caller to book online at lemansgokarts.com.au.`;
    }

    const transferCheck = startTransfer(state, department);
    if (!transferCheck.allowed) {
      return `Transfer not permitted: ${transferCheck.reason}.`;
    }

    const who = DEPARTMENT_LABEL[department];
    try {
      const outcome = await services.transfer(department, reason);
      finishTransfer(state, outcome.status);
      switch (outcome.status) {
        case 'transferred':
          return `The call is being transferred to ${who}. Do not say anything else.`;
        case 'web-demo':
          return (
            `This is a web demo, so a live transfer is not possible. Tell the caller that on a real call you would now ` +
            `put them through to ${who}, and offer to take their details for a callback instead.`
          );
        case 'unavailable':
          return `There is no line for ${who} available right now. Apologise and offer to take their details for a callback.`;
        case 'failed':
          return `The transfer to ${who} did not connect. Apologise and offer to take their details for a callback.`;
        case 'unknown':
          return (
            `The transfer request to ${who} was sent, but the result is unknown. ` +
            `Do not redial or say a person answered. Apologise and offer to take their details for a callback.`
          );
      }
    } catch (err) {
      finishTransfer(state, 'failed');
      throw err;
    }
  },
});

export const endCall = llm.tool({
  name: 'end_call',
  description:
    'Say goodbye and hang up. Call it whenever the caller says bye or has nothing else to ask. ' +
    'The tool speaks the goodbye itself, so do not also say goodbye in your reply.',
  parameters: z.object({
    goodbye: z.string().describe('One short, warm goodbye sentence to say before hanging up'),
  }),
  execute: async ({ goodbye }, { ctx }) => {
    const { services } = ctx.userData as CallUserData;
    // Anything already said this turn finishes first, then the goodbye, then the line drops.
    await ctx.waitForPlayout();
    await services.endCall(goodbye);
    return 'Call ended.';
  },
});

export const lookupHours = llm.tool({
  name: 'lookup_hours',
  description:
    'Check official opening and closing hours for a specific date or schedule. ' +
    'schedule can be venue, bookings, or large_events.',
  parameters: z.object({
    date: z.string().optional().describe('Date in YYYY-MM-DD format (leave empty for today)'),
    schedule: z
      .enum(['venue', 'bookings', 'large_events'])
      .optional()
      .describe('Which schedule to check: venue, bookings, or large_events (default: venue)'),
  }),
  execute: async ({ date, schedule = 'venue' }, { ctx }) => {
    const userData = ctx.userData as CallUserData;
    if (!userData.services.lookupHours) {
      return 'Hours are unconfirmed. Please check the website.';
    }
    const result = await userData.services.lookupHours({ date, schedule });
    if (result.status !== 'current') {
      return `Hours for ${schedule} on ${result.date} are unconfirmed. Direct the caller to check lemansentertainment.com.au.`;
    }
    if (result.closed) {
      return `On ${result.date}, the ${schedule} is closed.`;
    }
    const nextDay = result.closesNextDay ? ' (closing early the following morning)' : '';
    return `On ${result.date}, the ${schedule} opens at ${result.opens} and closes at ${result.closes}${nextDay}.`;
  },
});

export const prepareLinkSms = llm.tool({
  name: 'prepare_link_sms',
  description:
    'Validate the caller mobile number and prepare an SMS with a link (booking or maps). ' +
    'This sends NOTHING. Call confirm_sms_readback to speak the number and purpose.',
  parameters: z.object({
    purpose: z.enum(['booking', 'maps']).describe('The link purpose: booking or maps'),
    phone: z.string().describe('Australian mobile number starting with 04'),
  }),
  execute: async ({ purpose, phone }, { ctx }) => {
    const userData = ctx.userData as CallUserData;
    const state = getState(userData);
    const normalized = normalizeAustralianMobile(phone);
    if (!normalized) {
      return 'That number does not look like a valid Australian mobile number. Please ask the caller for their 04 mobile number.';
    }
    if (!userData.services.prepareLinkSms) {
      return 'SMS is not available on this call. Direct the caller to the website instead.';
    }

    // A correction or replacement makes the old draft stale. Cancel it at the API.
    const previousDraft = state.pendingDraft;
    if (previousDraft?.submissionState) return 'The previous text result is pending or uncertain. Do not create another text.';
    if (
      previousDraft &&
      !previousDraft.sentOperationId &&
      userData.services.cancelLinkSms
    ) {
      await userData.services
        .cancelLinkSms({ draftId: previousDraft.id, version: previousDraft.version })
        .catch(() => undefined);
    }

    // Create the next version. A correction must make the old draft stale.
    const nextVersion = state.requestVersion + 1;
    let remote: { draftId: string; recipient: string; version: number };
    try {
      remote = await userData.services.prepareLinkSms({ purpose, phone: normalized, version: nextVersion });
    } catch {
      return 'The SMS service is unavailable right now. Direct the caller to the website instead.';
    }
    if (!remote?.draftId || remote.version !== nextVersion || remote.recipient !== normalized) {
      return 'The SMS service returned an invalid draft. Do not promise a text; direct the caller to the website.';
    }

    state.requestVersion = nextVersion;
    const draft = createPendingDraft(state, {
      id: remote.draftId,
      purpose,
      recipient: normalized,
      version: remote.version,
    });

    return (
      `Draft ${draft.id} prepared for a ${purpose} link to ${normalized}. ` +
      `Call confirm_sms_readback with this draft ID to speak the number and purpose.`
    );
  },
});

export const confirmSmsReadback = llm.tool({
  name: 'confirm_sms_readback',
  description:
    'Read back the SMS number and purpose to the caller. This does NOT send the message.',
  parameters: z.object({
    draftId: z.string().describe('The draft ID returned by prepare_link_sms'),
  }),
  execute: async ({ draftId }, { ctx }) => {
    const userData = ctx.userData as CallUserData;
    const state = getState(userData);
    const draft = state.pendingDraft;
    if (!draft || draft.id !== draftId) {
      return 'No matching SMS draft. Prepare the link again before asking for confirmation.';
    }

    if (!userData.services.reviewLinkSms) return 'Text messages are unavailable. Please use the website.';
    const receipt = await userData.services.reviewLinkSms({ draftId, version: draft.version, purpose: draft.purpose, recipient: draft.recipient });
    if (!receipt || ctx.speechHandle.interrupted || state.pendingDraft !== draft || state.requestVersion !== draft.version || state.turnCount !== receipt.callerSequence) {
      return 'The readback could not be confirmed. Do not send a text.';
    }
    draft.review = receipt;
    draft.readbackCompleted = true;

    return 'Readback completed. Wait for a later caller response. Only after clear approval, call schedule_link_sms. It sends after the call ends.';
  },
});

export const cancelLinkSms = llm.tool({
  name: 'cancel_link_sms',
  description: 'Cancel a prepared link SMS when the caller refuses or changes their mind. This sends nothing.',
  parameters: z.object({
    draftId: z.string().describe('The draft ID returned by prepare_link_sms'),
  }),
  execute: async ({ draftId }, { ctx }) => {
    const userData = ctx.userData as CallUserData;
    const state = getState(userData);
    const draft = state.pendingDraft;
    if (!draft || draft.id !== draftId) {
      return 'No matching SMS draft to cancel.';
    }
    if (draft.sentOperationId || draft.submissionState) {
      return 'That text was already submitted and cannot be cancelled. Do not say it was cancelled.';
    }
    cancelPendingDraft(state);
    if (userData.services.cancelLinkSms) {
      await userData.services
        .cancelLinkSms({ draftId, version: draft.version })
        .catch(() => undefined);
    }
    return 'The text is cancelled. Do not send it.';
  },
});

export const sendLinkSms = llm.tool({
  name: 'schedule_link_sms',
  description:
    'Save approval for a link SMS to send AFTER the call ends. This sends nothing during the call. ' +
    'Only call when the current caller response clearly approves the completed readback. Never call for refusal, a correction, a question, quoted approval or unclear consent.',
  parameters: z.object({
    draftId: z.string().describe('The draft ID returned by prepare_link_sms'),
    version: z.number().int().positive().describe('The request version for the draft'),
  }),
  execute: async ({ draftId, version }, { ctx }) => {
    const userData = ctx.userData as CallUserData;
    const state = getState(userData);
    const draft = state.pendingDraft;

    if (!draft || draft.id !== draftId || draft.version !== version) {
      return 'That SMS draft is missing or stale. Prepare the link again and repeat the readback.';
    }
    if (!draft.readbackCompleted) {
      return 'The readback is not complete. Read the number back and call confirm_sms_readback first.';
    }
    if (draft.scheduledAfterCall) return 'The text is already scheduled for after this call. It has not been sent.';

    const consent = userData.services.getSmsConsent?.(ctx);
    if (!consent || !draft.review || consent.version !== draft.version || consent.sequence <= draft.review.callerSequence || consent.sequence !== state.turnCount || state.committedCallerMessageIds[consent.sequence - 1] !== consent.messageId) {
      return 'Text messages are unavailable. Please use the website.';
    }
    draft.consentMessageId = consent.messageId;

    const check = canSendDraft(state, draftId, version);
    if (!check.allowed) {
      return `Cannot send message: ${check.reason}.`;
    }

    if (!userData.services.sendLinkSms) {
      return 'SMS is not available on this call. Do not say a text was sent.';
    }

    if (draft.submissionState) return 'The previous text result is pending or uncertain. Do not send it again.';
    draft.submissionState = 'requesting';
    const res = await userData.services.sendLinkSms({ draftId, version, consent }).catch(() => ({ status: 'unknown' as const, operationId: undefined, error: undefined }));
    if (res.status === 'scheduled') {
      draft.submissionState = undefined;
      draft.scheduledAfterCall = true;
      return state.channel === 'web' ? 'Saved for a simulation after this demo call ends. No real text will be sent.' : 'The text is scheduled for after this call ends. It has not been sent. The caller can still cancel it.';
    }
    draft.submissionState = res.status === 'unavailable' ? undefined : res.status === 'unknown' ? 'unknown' : 'submitted';
    draft.sentOperationId = res.operationId;
    if (res.status === 'simulated') {
      return `SMS simulated on the web demo for ${draft.recipient}. Tell the caller it is a demo and no real text was sent.`;
    }
    if (res.status === 'accepted' || res.status === 'delivered') {
      return `SMS has been submitted to ${draft.recipient}. Tell the caller it was submitted, not delivered yet.`;
    }
    if (res.status === 'sending') {
      return 'The text is still being submitted. Do not send it again and do not say it was sent yet.';
    }
    if (res.status === 'unknown') {
      return 'The send result could not be confirmed. Do not retry and do not say the text was sent.';
    }
    if (res.status === 'unavailable') return 'The text service is unavailable. No text was sent.';
    return `Could not send the message: ${res.error ?? 'carrier error'}. Do not claim it was sent.`;
  },
});
