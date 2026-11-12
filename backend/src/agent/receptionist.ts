import { voice } from '@livekit/agents';

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
const GREETING_ATTEMPTS = 3;
const GREETING_RETRY_MS = 4_000;

export type GreetingMode = 'say' | 'generate' | 'none';

export class Receptionist extends voice.Agent<CallUserData> {
  private greetingTimer?: ReturnType<typeof setTimeout>;

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
    if (this.greeting === 'say') this.session.say(GREETING);
    else if (this.greeting === 'generate') this.greet();
  }

  override async onExit(): Promise<void> {
    // A retry timer must not outlive the agent that owns it.
    this.clearGreetingTimer();
  }

  /**
   * A speech-to-speech model treats the request as a suggestion and now and then stays silent
   * (seen with GPT-Live). A caller must never pick up to silence, so ask again until it speaks.
   */
  private greet(attempt = 1): void {
    this.clearGreetingTimer();
    try {
      this.session.generateReply({ instructions: `Greet the caller with: "${GREETING}"` });
    } catch {
      return; // session already closed (caller hung up)
    }
    if (attempt >= GREETING_ATTEMPTS) return;
    this.greetingTimer = setTimeout(() => {
      this.greetingTimer = undefined;
      const started =
        this.session.agentState === 'speaking' ||
        this.session.userState === 'speaking' ||
        this.session.history.items.some((i) => i.type === 'message');
      if (!started) this.greet(attempt + 1);
    }, GREETING_RETRY_MS);
  }

  private clearGreetingTimer(): void {
    if (this.greetingTimer !== undefined) {
      clearTimeout(this.greetingTimer);
      this.greetingTimer = undefined;
    }
  }
}
