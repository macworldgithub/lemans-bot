import { describe, expect, it, vi } from 'vitest';
import { lookupHours, sendLinkSms } from '../src/agent/tools.js';
import { createCallState, createPendingDraft, recordCallerTurn } from '../src/agent/state.js';
import { readMessageResult } from '../src/messaging/schema.js';

describe('tool boundaries', () => {
  const runHours = (lookupHours as unknown as { execute: (args: object, options: object) => Promise<string> }).execute;
  it('does not present stale or missing hours as current', async () => {
    const stale = { status: 'stale', date: '2026-11-12', schedule: 'venue', opens: '09:00', closes: '18:00' };
    const result = await runHours({ schedule: 'venue' }, { ctx: { userData: { services: { lookupHours: async () => stale } } } });
    expect(result).toMatch(/unconfirmed/i);
    expect(result).not.toContain('09:00');
    const unavailable = await runHours({}, { ctx: { userData: { services: {} } } });
    expect(unavailable).toMatch(/unconfirmed/i);
  });

  it('keeps an unknown operation ID even on an error HTTP response', async () => {
    const response = new Response(JSON.stringify({ status: 'unknown', operationId: 'op-1', errorCode: 'provider_result' }), { status: 504 });
    expect(await readMessageResult(response)).toMatchObject({ status: 'unknown', operationId: 'op-1' });
    expect(await readMessageResult(new Response('not-json', { status: 500 }))).toEqual({ status: 'unknown' });
  });

  it('refuses a missing or stale caller binding before calling the SMS service', async () => {
    const state = createCallState({ callId: 'call-test' });
    recordCallerTurn(state, 'turn-1');
    const draft = createPendingDraft(state, { id: 'draft-1', purpose: 'booking', recipient: '+61412345678' });
    draft.review = { speechId: 'speech-1', completedAt: 1, callerSequence: 1 };
    draft.readbackCompleted = true;
    recordCallerTurn(state, 'turn-2');
    const send = vi.fn(async () => ({ status: 'simulated' as const, operationId: 'operation-1' }));
    const services = { callId: 'call-test', sendLinkSms: send, getSmsConsent: () => undefined as { messageId: string; sequence: number; version: number } | undefined };
    const execute = (sendLinkSms as unknown as { execute: (args: object, options: object) => Promise<string> }).execute;
    const run = () => execute({ draftId: draft.id, version: draft.version }, { ctx: { userData: { state, services } } });
    expect(await run()).toMatch(/unavailable/i);
    recordCallerTurn(state, 'turn-3');
    services.getSmsConsent = () => ({ messageId: 'turn-2', sequence: 2, version: draft.version });
    expect(await run()).toMatch(/unavailable/i);
    expect(send).not.toHaveBeenCalled();
    services.getSmsConsent = () => ({ messageId: 'turn-3', sequence: 3, version: draft.version });
    expect(await run()).toMatch(/simulated/i);
    expect(send).toHaveBeenCalledOnce();
  });
});
