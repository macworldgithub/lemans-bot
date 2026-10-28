import { voice } from '@livekit/agents';

import { GREETING } from './prompt.js';
import { endCall, saveLead, transferCall, type CallUserData } from './tools.js';

/**
 * say: fixed greeting through TTS, starts instantly (no LLM round trip).
 * generate: speech-to-speech models have no separate TTS, so the model speaks it.
 * none: text-only tests.
 */
const GREETING_ATTEMPTS = 3;
const GREETING_RETRY_MS = 4_000;

export type GreetingMode = 'say' | 'generate' | 'none';

export class Receptionist extends voice.Agent<CallUserData> {
  constructor(instructions: string, private readonly greeting: GreetingMode = 'say') {
    super({ instructions, tools: [saveLead, transferCall, endCall] });
  }

  override async onEnter(): Promise<void> {
    if (this.greeting === 'say') this.session.say(GREETING);
    else if (this.greeting === 'generate') this.greet();
  }

  /**
   * A speech-to-speech model treats the request as a suggestion and now and then stays silent
   * (seen with GPT-Live). A caller must never pick up to silence, so ask again until it speaks.
   */
  private greet(attempt = 1): void {
    try {
      this.session.generateReply({ instructions: `Greet the caller with: "${GREETING}"` });
    } catch {
      return; // session already closed (caller hung up)
    }
    if (attempt >= GREETING_ATTEMPTS) return;
    setTimeout(() => {
      const started =
        this.session.agentState === 'speaking' ||
        this.session.userState === 'speaking' ||
        this.session.history.items.some((i) => i.type === 'message');
      if (!started) this.greet(attempt + 1);
    }, GREETING_RETRY_MS);
  }
}
