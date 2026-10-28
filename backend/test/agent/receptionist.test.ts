/**
 * Behaviour tests against the real OpenAI model (text only, no audio, no LiveKit server).
 * Each test starts a fresh session; an LLM judge checks the meaning of replies.
 * Run with: npm run test:agent   (costs a few cents)
 */
import { initializeLogger, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { afterEach, describe, expect, it } from 'vitest';

import { buildInstructions } from '../../src/agent/prompt.js';
import { Receptionist } from '../../src/agent/receptionist.js';
import type { CallServices, CallUserData, TransferOutcome } from '../../src/agent/tools.js';
import { config, KNOWLEDGE_DIR } from '../../src/config.js';
import { loadKnowledge } from '../../src/knowledge/loader.js';
import type { Department } from '../../src/shared/events.js';

initializeLogger({ pretty: false, level: 'warn' });

const knowledge = loadKnowledge(KNOWLEDGE_DIR);
// Saturday 11:00 in Melbourne (open) and Tuesday 23:00 (closed).
const OPEN = new Date('2026-10-24T00:00:00Z');
const CLOSED = new Date('2026-10-27T12:00:00Z');

const judge = new openai.LLM({ apiKey: config.OPENAI_API_KEY, model: 'gpt-4.1', temperature: 0 });

class FakeServices implements CallServices {
  callId = 'test-call';
  leads: Parameters<CallServices['saveLead']>[0][] = [];
  transfers: { department: Department; reason: string }[] = [];
  goodbye: string | undefined;
  constructor(private readonly outcome: TransferOutcome = { status: 'web-demo' }) {}
  async saveLead(lead: Parameters<CallServices['saveLead']>[0]) {
    this.leads.push(lead);
  }
  async transfer(department: Department, reason: string) {
    this.transfers.push({ department, reason });
    return this.outcome;
  }
  async endCall(goodbye: string) {
    this.goodbye = goodbye;
  }
}

let session: voice.AgentSession<CallUserData> | undefined;

async function start(now = OPEN, services = new FakeServices()) {
  session = new voice.AgentSession<CallUserData>({
    llm: new openai.LLM({ apiKey: config.OPENAI_API_KEY, model: config.OPENAI_LLM_MODEL, temperature: 0.4 }),
    userData: { services },
  });
  const instructions = buildInstructions(knowledge, { source: 'web', now, timezone: config.TIMEZONE });
  await session.start({ agent: new Receptionist(instructions, 'none') });
  return { session, services };
}

afterEach(async () => {
  await session?.close();
  session = undefined;
});

describe('LeMans receptionist', { timeout: 120_000 }, () => {
  it('gives the opening hours from the knowledge base', async () => {
    const { session } = await start();
    const result = await session.run({ userInput: 'What time are you open on Saturday?' }).wait();
    await result.expect.nextEvent().isMessage({ role: 'assistant' }).judge(judge, {
      intent: 'Says Saturday hours are 9:15am to 11pm (any natural wording). Short spoken reply, no markdown or lists.',
    });
  });

  it('quotes the published kids party price as a guide only', async () => {
    const { session } = await start();
    const result = await session.run({ userInput: 'How much is a go-kart party for my 8 year old?' }).wait();
    await result.expect.nextEvent().isMessage({ role: 'assistant' }).judge(judge, {
      intent:
        'Mentions roughly $39 off-peak / $49 peak per child (or one of those) and does not invent other prices. ' +
        'May ask a follow-up question about headcount, date or booking.',
    });
  });

  it('never quotes a corporate rate', async () => {
    const { session } = await start();
    const result = await session.run({ userInput: "What's your price for a team building day for 40 staff?" }).wait();
    await result.expect.nextEvent().isMessage({ role: 'assistant' }).judge(judge, {
      intent:
        'Does NOT give any dollar price. Says corporate packages are tailored, and asks for details (company, date) ' +
        'or offers to put them through to the corporate team.',
    });
  });

  it('does not medically clear a pregnant caller', async () => {
    const { session } = await start();
    const result = await session.run({ userInput: "I'm pregnant, can I still do the go-karts?" }).wait();
    await result.expect.nextEvent().isMessage({ role: 'assistant' }).judge(judge, {
      intent: 'Explains pregnant guests cannot do the activity / it is restricted for safety. Does not say it is fine.',
    });
  });

  it('transfers to reservations once the caller agrees', async () => {
    const services = new FakeServices();
    const { session } = await start(OPEN, services);
    await session.run({ userInput: "I'd like to book a kids party for 10 kids next Saturday." }).wait();
    const result = await session.run({ userInput: 'Yes please, put me through.' }).wait();
    result.expect.containsFunctionCall({ name: 'transfer_call' });
    expect(services.transfers[0]?.department).toBe('reservations');
  });

  it('takes a callback lead after hours instead of promising a human', async () => {
    const services = new FakeServices();
    const { session } = await start(CLOSED, services);
    const first = await session.run({ userInput: 'Hi, I want to book a bucks party for 12 people.' }).wait();
    await first.expect.nextEvent().isMessage({ role: 'assistant' }).judge(judge, {
      intent: 'Does not claim a person can take the call right now. Moves toward taking details for a callback or answers about bucks packages.',
    });
    await session.run({ userInput: "My name's Jake, mobile is 0412 345 678, and we want Saturday the 14th of November." }).wait();
    const confirm = await session.run({ userInput: "Yes that's right." }).wait();
    confirm.expect.containsFunctionCall({ name: 'save_lead' });
    expect(services.leads[0]).toMatchObject({ name: expect.stringMatching(/jake/i), headcount: 12 });
    expect(services.leads[0].phone?.replace(/\D/g, '')).toBe('0412345678');
  });

  it('hangs up after saying goodbye', async () => {
    const services = new FakeServices();
    const { session } = await start(OPEN, services);
    const result = await session.run({ userInput: "That's all I needed, thanks. Bye!" }).wait();
    result.expect.containsFunctionCall({ name: 'end_call' });
    expect(services.goodbye?.trim().length).toBeGreaterThan(3);
  });
});
