import { initializeLogger, llm, voice } from '@livekit/agents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Receptionist } from '../src/agent/receptionist.js';
import { bindResponseGuard, ResponseGuard } from '../src/agent/response-guard.js';
import type { CallUserData } from '../src/agent/tools.js';

initializeLogger({ pretty: false, level: 'warn' });
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function timing(mode: 'recover' | 'observe' = 'recover') {
  const session = new voice.AgentSession();
  const recover = vi.fn();
  const slow = vi.fn();
  const guard = new ResponseGuard({ mode, onRecovery: recover, onSlow: slow });
  const agentState = vi.spyOn(session, 'agentState', 'get').mockReturnValue('listening');
  bindResponseGuard(session, guard);
  const user = (oldState: voice.UserState, newState: voice.UserState) => session.emit(voice.AgentSessionEventTypes.UserStateChanged, { type: 'user_state_changed', oldState, newState, createdAt: Date.now() });
  const fragment = (id: string) => session.emit(voice.AgentSessionEventTypes.ConversationItemAdded, { type: 'conversation_item_added', item: llm.ChatMessage.create({ id, role: 'user', content: 'A test question' }), createdAt: Date.now() });
  return { session, guard, recover, slow, agentState, user, fragment };
}

describe('live speech event ordering', () => {
  it('observes a slow GPT-Live answer without injecting fallback speech', () => {
    const t = timing('observe');
    t.user('speaking', 'listening');
    vi.advanceTimersByTime(1000); t.fragment('first-fragment');
    vi.advanceTimersByTime(2000);
    expect(t.slow).toHaveBeenCalledOnce();
    expect(t.recover).not.toHaveBeenCalled();
    t.fragment('later-fragment');
    vi.advanceTimersByTime(10000);
    expect(t.slow).toHaveBeenCalledOnce();
    expect(t.recover).not.toHaveBeenCalled();
    expect(t.guard.answerStarted(t.guard.activeTurnId)).toBe(true);
  });
  it('starts one deadline when caller audio stops, not on delayed transcript fragments', () => {
    const t = timing();
    t.user('listening', 'speaking');
    t.user('speaking', 'listening');
    vi.advanceTimersByTime(1000); t.fragment('fragment-1');
    vi.advanceTimersByTime(1000); t.fragment('fragment-2');
    vi.advanceTimersByTime(1000);
    expect(t.recover).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10000);
    expect(t.recover).toHaveBeenCalledOnce();
  });

  it('does not start a deadline while Chloe is already speaking', () => {
    const t = timing();
    t.agentState.mockReturnValue('speaking');
    t.user('speaking', 'listening');
    t.fragment('late-fragment');
    vi.advanceTimersByTime(10000);
    expect(t.recover).not.toHaveBeenCalled();
  });

  it('does not restart recovery when a transcript arrives after the answer started', () => {
    const t = timing();
    t.user('speaking', 'listening');
    vi.advanceTimersByTime(1000);
    t.session.emit(voice.AgentSessionEventTypes.AgentStateChanged, { type: 'agent_state_changed', oldState: 'thinking', newState: 'speaking', createdAt: Date.now() });
    t.fragment('late-fragment');
    vi.advanceTimersByTime(10000);
    expect(t.recover).not.toHaveBeenCalled();
  });

  it('cancels the pending deadline when the caller resumes speaking', () => {
    const t = timing();
    t.user('speaking', 'listening');
    vi.advanceTimersByTime(2000); t.user('listening', 'speaking');
    vi.advanceTimersByTime(10000);
    expect(t.recover).not.toHaveBeenCalled();
  });

  it('cleans up the listeners and deadline when the session closes', () => {
    const t = timing();
    t.user('speaking', 'listening');
    t.session.emit(voice.AgentSessionEventTypes.Close, { type: 'close', reason: voice.CloseReason.USER_INITIATED, error: null, createdAt: Date.now() });
    t.user('speaking', 'listening');
    vi.advanceTimersByTime(10000);
    expect(t.guard.isClosed).toBe(true);
    expect(t.recover).not.toHaveBeenCalled();
  });
});

describe('greeting lifecycle', () => {
  function greeting() {
    const session = new voice.AgentSession<CallUserData>();
    const agent = new Receptionist('Test instructions', 'generate');
    vi.spyOn(agent, 'session', 'get').mockReturnValue(session);
    const handle = voice.SpeechHandle.create();
    let finish!: () => void;
    const played = new Promise<void>(resolve => { finish = resolve; });
    vi.spyOn(handle, 'waitForPlayout').mockReturnValue(played);
    vi.spyOn(handle, 'exception').mockReturnValue(undefined);
    const generate = vi.spyOn(session, 'generateReply').mockReturnValue(handle);
    return { session, agent, handle, finish, generate };
  }

  it('does not queue another greeting while the first is still pending', async () => {
    const g = greeting();
    await g.agent.onEnter();
    await vi.advanceTimersByTimeAsync(15000);
    expect(g.generate).toHaveBeenCalledOnce();
    await g.agent.onExit();g.finish();
  });

  it('retries only after a confirmed failure without speaking over a caller', async () => {
    const g = greeting();
    vi.spyOn(g.handle, 'exception').mockReturnValue(new Error('refused'));
    await g.agent.onEnter();
    g.session.emit(voice.AgentSessionEventTypes.UserStateChanged, { type: 'user_state_changed', oldState: 'listening', newState: 'speaking', createdAt: Date.now() });
    g.finish();await vi.advanceTimersByTimeAsync(0);
    expect(g.generate).toHaveBeenCalledOnce();
    await g.agent.onExit();
  });

  it('never retries after agent exit', async () => {
    const g = greeting();
    vi.spyOn(g.handle, 'exception').mockReturnValue(new Error('refused'));
    await g.agent.onEnter();await g.agent.onExit();
    g.finish();await vi.advanceTimersByTimeAsync(15000);
    expect(g.generate).toHaveBeenCalledOnce();
  });

  it('allows one retry after a failed greeting if nobody has spoken', async () => {
    const g = greeting();
    const retry = voice.SpeechHandle.create();
    vi.spyOn(retry, 'waitForPlayout').mockResolvedValue(undefined);
    vi.spyOn(retry, 'exception').mockReturnValue(undefined);
    vi.spyOn(g.handle, 'exception').mockReturnValue(new Error('refused'));
    g.generate.mockReturnValueOnce(g.handle).mockReturnValueOnce(retry);
    await g.agent.onEnter();
    g.finish(); await vi.advanceTimersByTimeAsync(0);
    expect(g.generate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15000);
    expect(g.generate).toHaveBeenCalledTimes(2);
    await g.agent.onExit();
  });

  it('does not retry after Chloe has started speaking, even if the handle later fails', async () => {
    const g = greeting();
    vi.spyOn(g.handle, 'exception').mockReturnValue(new Error('interrupted'));
    await g.agent.onEnter();
    g.session.emit(voice.AgentSessionEventTypes.AgentStateChanged, { type: 'agent_state_changed', oldState: 'thinking', newState: 'speaking', createdAt: Date.now() });
    g.finish(); await vi.advanceTimersByTimeAsync(0);
    expect(g.generate).toHaveBeenCalledOnce();
    await g.agent.onExit();
  });
});
