import { initializeLogger, llm, voice } from '@livekit/agents';
import { pino } from 'pino';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/api/app.js';
import { Database } from '../src/api/db.js';
import { CallStore } from '../src/api/store.js';
import { config } from '../src/config.js';
import { Receptionist, takeSmsConsent } from '../src/agent/receptionist.js';
import { buildInstructions } from '../src/agent/prompt.js';
import { createCallState, createPendingDraft, recordCallerTurn } from '../src/agent/state.js';
import { confirmSmsReadback, sendLinkSms, type CallUserData } from '../src/agent/tools.js';
import { FakeSmsProvider } from '../src/messaging/provider.js';
import { MessagingService } from '../src/messaging/service.js';
import { InMemoryMessageStore } from '../src/messaging/store.js';

afterEach(() => vi.restoreAllMocks());
initializeLogger({ pretty: false, level: 'warn' });

function setup() {
  const provider = new FakeSmsProvider();
  const store = new InMemoryMessageStore();
  const service = new MessagingService({ provider, store, smsEnabled: true, hmacSecret: 'test-only' });
  const logger = pino({ level: 'silent' });
  const app = createApp({ config, logger, store: new CallStore(), db: new Database(undefined, 'test', logger), messagingService: service });
  const post = (path: string, body: object) => request(app).post(path).set('x-internal-secret', config.INTERNAL_API_SECRET).send(body);
  return { provider, store, service, app, post };
}

async function prepare(s: ReturnType<typeof setup>, callId = 'call-1', channel = 'phone') {
  const result = await s.post('/internal/messages/drafts', { callId, phone: '0412345678', purpose: 'booking', version: 1, delivery: 'after_call' }).expect(201);
  const draftId = result.body.draftId as string;
  const consent = { messageId: 'caller-yes', sequence: 2, version: 1 };
  await s.post(`/internal/messages/${draftId}/review`, { callId, expectedVersion: 1, review: { speechId: 'review-1', completedAt: Date.now(), callerSequence: 1 } }).expect(204);
  const approval = { callId, expectedVersion: 1, consent, channel };
  return { draftId, approval };
}

describe('after-call SMS through HTTP', () => {
  it('stores approval without sending, then sends once despite repeated call completion', async () => {
    const s = setup();
    const { draftId, approval } = await prepare(s);
    await s.post(`/internal/messages/${draftId}/approve-after-call`, approval).expect(202);
    expect(s.provider.sent).toHaveLength(0);
    await s.post(`/internal/messages/${draftId}/send`, approval).expect(409);
    await Promise.all([1, 2].map(() => s.post('/internal/messages/calls/call-1/complete', { reason: 'caller_disconnected', draftId }).expect(204)));
    expect(s.provider.sent).toHaveLength(1);
    expect(s.provider.sent[0]?.body).toContain('Book your casual visit');
    expect((await s.service.getOperationByDraft(draftId))?.status).toBe('accepted');
  });

  it('does not send unapproved, cancelled, cross-call or unselected drafts', async () => {
    const s = setup();
    const { draftId, approval } = await prepare(s);
    const complete = (callId = 'call-1', selected: string | undefined = draftId) => s.post(`/internal/messages/calls/${callId}/complete`, { reason: 'caller_disconnected', draftId: selected }).expect(204);
    await complete();
    await s.post(`/internal/messages/${draftId}/approve-after-call`, approval).expect(202);
    await complete('other-call');
    await s.post('/internal/messages/calls/call-1/complete', { reason: 'caller_disconnected' }).expect(204);
    await s.post(`/internal/messages/${draftId}/cancel`, { callId: 'call-1' }).expect(200);
    await complete();
    expect(s.provider.sent).toHaveLength(0);
  });

  it('rejects same-turn approval, missing auth and a worker shutdown as a call end', async () => {
    const s = setup();
    const { draftId, approval } = await prepare(s);
    await s.post(`/internal/messages/${draftId}/approve-after-call`, { ...approval, consent: { ...approval.consent, sequence: 1 } }).expect(409);
    await request(s.app).post('/internal/messages/calls/call-1/complete').send({ reason: 'caller_disconnected', draftId }).expect(401);
    await s.post('/internal/messages/calls/call-1/complete', { reason: 'job_shutdown', draftId }).expect(400);
    expect(s.provider.sent).toHaveLength(0);
  });

  it('keeps the web demo simulated and never retries an uncertain provider attempt', async () => {
    const s = setup();
    const web = await prepare(s, 'web-call', 'web');
    await s.post(`/internal/messages/${web.draftId}/approve-after-call`, web.approval).expect(202);
    await s.post('/internal/messages/calls/web-call/complete', { reason: 'caller_disconnected', draftId: web.draftId }).expect(204);
    expect((await s.service.getOperationByDraft(web.draftId))?.status).toBe('simulated');
    expect(s.provider.sent).toHaveLength(0);
    const phone = await prepare(s);
    await s.post(`/internal/messages/${phone.draftId}/approve-after-call`, phone.approval).expect(202);
    const send = vi.spyOn(s.provider, 'send').mockRejectedValue(new Error('uncertain result'));
    for (let i = 0; i < 2; i++) await s.post('/internal/messages/calls/call-1/complete', { reason: 'caller_disconnected', draftId: phone.draftId }).expect(204);
    expect(send).toHaveBeenCalledOnce();
    expect((await s.service.getOperationByDraft(phone.draftId))?.status).toBe('unknown');
  });
});

describe('SDK generation consent binding', () => {
  it('does not mark an interrupted or failed readback as complete', async () => {
    const state = createCallState({ callId: 'test' });
    const draft = createPendingDraft(state, { id: 'draft-test', recipient: '+61412345678', purpose: 'booking' });
    const review = vi.fn(async () => ({ speechId: 'speech', completedAt: 1, callerSequence: 0 } as { speechId: string; completedAt: number; callerSequence: number } | undefined));
    const execute = (confirmSmsReadback as unknown as { execute: (args: object, opts: object) => Promise<string> }).execute;
    const ctx = { userData: { state, services: { reviewLinkSms: review } }, speechHandle: { interrupted: true } };
    expect(await execute({ draftId: draft.id }, { ctx })).toMatch(/could not be confirmed/i);
    expect(draft.readbackCompleted).toBe(false);
    ctx.speechHandle.interrupted = false;
    review.mockResolvedValue(undefined);
    await execute({ draftId: draft.id }, { ctx });
    expect(draft.readbackCompleted).toBe(false);
  });

  it('binds the generated tool to its input message and refuses a delayed older turn', async () => {
    const state = createCallState({ callId: 'test', channel: 'web' });
    const draft = createPendingDraft(state, { id: 'draft-test', recipient: '+61412345678', purpose: 'booking' });
    recordCallerTurn(state, 'review-turn');
    draft.review = { speechId: 'speech', completedAt: 1, callerSequence: 1 };
    draft.readbackCompleted = true;
    const message = llm.ChatMessage.create({ id: 'approval-turn', role: 'user', content: 'Yes, send it after the call.' });
    recordCallerTurn(state, message.id);
    const schedule = vi.fn(async () => ({ status: 'scheduled' as const }));
    const userData: CallUserData = { state, services: { callId: 'test', saveLead: async () => {}, transfer: async () => ({ status: 'unavailable' }), endCall: async () => {}, sendLinkSms: schedule, getSmsConsent: (ctx: unknown) => takeSmsConsent(state, ctx as voice.RunContext<CallUserData>) } };
    const session = new voice.AgentSession<CallUserData>({ userData });
    const agent = new Receptionist('test', 'none', true);
    vi.spyOn(agent, 'session', 'get').mockReturnValue(session);
    const call = llm.FunctionCall.create({ callId: 'tool-1', name: 'schedule_link_sms', args: '{}' });
    vi.spyOn(voice.Agent.default, 'llmNode').mockImplementation(async () => new ReadableStream({ start(c) { c.enqueue({ id: 'chunk', delta: { role: 'assistant', toolCalls: [call] } }); c.close(); } }));
    const stream = await agent.llmNode(new llm.ChatContext([message]), agent.toolCtx, {});
    await stream!.getReader().read();
    const run = new voice.RunContext(session, voice.SpeechHandle.create(), call);
    const execute = (sendLinkSms as unknown as { execute: (args: object, opts: object) => Promise<string> }).execute;
    recordCallerTurn(state, 'newer-unrelated-turn');
    expect(await execute({ draftId: draft.id, version: draft.version }, { ctx: run })).toMatch(/unavailable/i);
    expect(schedule).not.toHaveBeenCalled();
    // A fresh generation for the actual current caller response can save approval.
    const current = llm.ChatMessage.create({ id: 'newer-unrelated-turn', role: 'user', content: 'Yes, I want that text.' });
    const next = await agent.llmNode(new llm.ChatContext([current]), agent.toolCtx, {});
    await next!.getReader().read();
    expect(await execute({ draftId: draft.id, version: draft.version }, { ctx: run })).toMatch(/simulation after/i);
    expect(schedule).toHaveBeenCalledOnce();
    expect(draft.scheduledAfterCall).toBe(true);
  });

  it('offers after-call SMS only when the worker explicitly enables it', () => {
    const ctx = { source: 'web' as const, now: new Date(), timezone: 'Australia/Melbourne' };
    expect(buildInstructions('', ctx)).toContain('SMS is unavailable');
    expect(buildInstructions('', ctx, true)).toContain('schedule_link_sms');
    expect(new Receptionist('test', 'none').toolCtx.functionTools).not.toHaveProperty('schedule_link_sms');
    expect(new Receptionist('test', 'none', true).toolCtx.functionTools).toHaveProperty('schedule_link_sms');
  });
});
