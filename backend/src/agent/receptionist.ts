import { log, voice } from '@livekit/agents';

import { GREETING } from './prompt.js';
import type { CallState } from './state.js';

import {
  endCall,
  lookupHours,
  recordRequest,
  saveLead,
  transferCall,
  prepareLinkSms, confirmSmsReadback, cancelLinkSms, sendLinkSms,
  type CallUserData,
} from './tools.js';

export function takeSmsConsent(state: CallState, run: voice.RunContext<CallUserData>) {
  const bound = state.smsToolTurns.get(run.functionCall.callId);
  state.smsToolTurns.delete(run.functionCall.callId);
  if (!bound || run.speechHandle.interrupted) return undefined;
  const sequence = state.committedCallerMessageIds.indexOf(bound.messageId) + 1;
  return sequence > 0 ? { messageId: bound.messageId, sequence, version: bound.version } : undefined;
}

/**
 * say: fixed greeting through TTS, starts instantly (no LLM round trip).
 * generate: speech-to-speech models have no separate TTS, so the model speaks it.
 * none: text-only tests.
 */
const GREETING_ATTEMPTS = 2;

export type GreetingMode = 'say' | 'generate' | 'none';

export class Receptionist extends voice.Agent<CallUserData> {
  private greetingRequested = false;
  private greetingExited = false;
  private stopGreetingWatch?: () => void;

  constructor(instructions: string, private readonly greeting: GreetingMode = 'say', private readonly afterCallSms = false) {
    super({
      instructions,
      tools: [
        recordRequest,
        lookupHours,
        saveLead,
        transferCall,
        endCall,
        ...(afterCallSms ? [prepareLinkSms, confirmSmsReadback, cancelLinkSms, sendLinkSms] : []),
      ],
    });
  }

  override async llmNode(...args: Parameters<voice.Agent<CallUserData>['llmNode']>): ReturnType<voice.Agent<CallUserData>['llmNode']> {
    // Capture the input of this generation, never the latest user message at tool execution.
    const state = this.session.userData.state;
    const message = [...args[0].items].reverse().find(item => item.type === 'message' && item.role === 'user');
    const version = state?.pendingDraft?.version;
    const stream = await super.llmNode(...args);
    if (!stream || !this.afterCallSms || !state || !message || version === undefined) return stream;
    return stream.pipeThrough(new TransformStream({ transform(chunk, controller) {
      if (typeof chunk === 'object' && chunk && 'delta' in chunk) {
        for (const call of chunk.delta?.toolCalls ?? []) {
          if (call.name === 'schedule_link_sms') state.smsToolTurns.set(call.callId, { messageId: message.id, version });
        }
      }
      controller.enqueue(chunk);
    } }));
  }

  override async onEnter(): Promise<void> {
    if (this.greetingRequested) return;
    this.greetingRequested = true;
    if (this.greeting === 'say') this.session.say(GREETING);
    else if (this.greeting === 'generate') void this.greet().catch(() => {
      log().warn({ code: 'greeting_failed' }, 'Greeting could not be completed');
    });
  }

  override async onExit(): Promise<void> {
    this.greetingExited = true;
    this.stopGreetingWatch?.();
  }

  /**
   * A full-duplex model may take several seconds to accept a greeting request.
   * Wait for that request to finish before considering a retry. Never queue a
   * second greeting once the caller or agent has started the conversation.
   */
  private async greet(): Promise<void> {
    const session = this.session;
    let conversationStarted = session.agentState === 'speaking' || session.userState === 'speaking' ||
      session.history.items.some(item => item.type === 'message' && (item.role === 'user' || item.role === 'assistant'));
    const onUser = (event: voice.UserStateChangedEvent) => {
      if (event.newState === 'speaking') conversationStarted = true;
    };
    const onAgent = (event: voice.AgentStateChangedEvent) => {
      if (event.newState === 'speaking') conversationStarted = true;
    };
    const cleanup = () => {
      session.off(voice.AgentSessionEventTypes.UserStateChanged, onUser);
      session.off(voice.AgentSessionEventTypes.AgentStateChanged, onAgent);
      this.stopGreetingWatch = undefined;
    };
    this.stopGreetingWatch = cleanup;
    session.on(voice.AgentSessionEventTypes.UserStateChanged, onUser);
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, onAgent);
    try {
      for (let attempt = 0; attempt < GREETING_ATTEMPTS; attempt++) {
        if (this.greetingExited || conversationStarted) return;
        const speech = session.generateReply({ instructions: `Greet the caller once with: "${GREETING}" Do not repeat a greeting already spoken.` });
        try { await speech.waitForPlayout(); } catch { /* Check the handle's actual result below. */ }
        if (!speech.exception() || speech.interrupted) return;
      }
    } finally { cleanup(); }
  }
}
