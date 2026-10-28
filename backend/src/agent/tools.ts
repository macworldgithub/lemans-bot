import { llm } from '@livekit/agents';
import { z } from 'zod';

import type { Department, LeadInfo } from '../shared/events.js';

export type TransferOutcome =
  | { status: 'transferred' }
  | { status: 'web-demo' }
  | { status: 'unavailable' }
  | { status: 'failed'; error: string };

/** Side effects the tools need. The worker wires real ones; tests pass fakes. */
export interface CallServices {
  callId: string;
  saveLead(lead: Omit<LeadInfo, 'callId' | 'createdAt'>): Promise<void>;
  transfer(department: Department, reason: string): Promise<TransferOutcome>;
  /** Speaks the goodbye (always, so the caller never hears a silent hang-up), then hangs up. */
  endCall(goodbye: string): Promise<void>;
}

export interface CallUserData {
  services: CallServices;
}

const DEPARTMENT_LABEL: Record<Department, string> = {
  reservations: 'the reservations team',
  corporate: 'the corporate events team',
  duty_manager: 'the duty manager',
};

export const saveLead = llm.tool({
  name: 'save_lead',
  description:
    'Save the caller as a lead so the reservations team calls them back. Use when the bookings office is closed, ' +
    'a transfer is unavailable or failed, or the caller prefers a callback. Collect the details first, and read the ' +
    'mobile number back to the caller before calling this.',
  parameters: z.object({
    name: z.string().describe("Caller's name"),
    phone: z.string().optional().describe('Mobile number, digits only, as confirmed by the caller'),
    email: z.string().optional().describe('Email, if the caller offered one'),
    eventType: z
      .string()
      .describe('What they want: kids party, teen party, bucks/hens, corporate, go-karts, VR, booking change, complaint, other'),
    preferredDate: z.string().optional().describe('Date or day they want, as the caller said it'),
    headcount: z.number().int().positive().optional().describe('Number of people'),
    notes: z.string().optional().describe('Anything else staff should know (ages, catering, questions)'),
  }),
  execute: async (args, { ctx }) => {
    const { services } = ctx.userData as CallUserData;
    try {
      await services.saveLead(args);
      return 'Lead saved. Tell the caller the reservations team will call them back (from 9am if the office is closed).';
    } catch (err) {
      throw new llm.ToolError(`Could not save the details: ${(err as Error).message}. Apologise and give them the email info@lemansgokarts.com.au.`);
    }
  },
});

export const transferCall = llm.tool({
  name: 'transfer_call',
  description:
    'Put the caller through to a human team. Only call after the caller agreed to be transferred. ' +
    'reservations: bookings, changes, catering, prices to lock in, anything you cannot answer. ' +
    'corporate: company, team-building and work events. duty_manager: complaints, refunds, injuries or incidents.',
  parameters: z.object({
    department: z.enum(['reservations', 'corporate', 'duty_manager']),
    reason: z.string().describe('One sentence summary of what the caller needs, for the staff member'),
  }),
  execute: async ({ department, reason }, { ctx }) => {
    const { services } = ctx.userData as CallUserData;
    const who = DEPARTMENT_LABEL[department];
    const outcome = await services.transfer(department, reason);
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
