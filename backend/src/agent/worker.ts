import { fileURLToPath } from 'node:url';

import { cli, defineAgent, log, ServerOptions, voice, type JobContext, type JobProcess, type VAD } from '@livekit/agents';
import type * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { ParticipantKind, type RemoteParticipant } from '@livekit/rtc-node';
import { RoomServiceClient, SipClient } from 'livekit-server-sdk';

import { config, KNOWLEDGE_DIR } from '../config.js';
import { loadKnowledge } from '../knowledge/loader.js';
import { NOTICE_TOPIC, type CallSource, type TranscriptEvent } from '../shared/events.js';
import { createClosingJudge } from './closing.js';
import { buildSessionOptions } from './pipeline.js';
import { buildInstructions, buildLiveInstructions } from './prompt.js';
import { Receptionist } from './receptionist.js';
import { EventReporter } from './reporter.js';
import { toTelUri, transferTarget } from './transfer.js';
import type { CallServices, CallUserData } from './tools.js';

const httpUrl = config.LIVEKIT_URL.replace(/^ws/, 'http');
const rooms = new RoomServiceClient(httpUrl, config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);
const sip = new SipClient(httpUrl, config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);

/** Rejects if `promise` takes longer than `ms`, so a stuck job fails fast instead of lingering. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function callerInfo(p: RemoteParticipant): { source: CallSource; callerNumber?: string } {
  if (p.kind === ParticipantKind.SIP) {
    return { source: 'phone', callerNumber: p.attributes['sip.phoneNumber'] || undefined };
  }
  return { source: 'web' };
}

/** Fields of a GPT-Live backend output item worth logging. */
interface BackendItem {
  type?: string;
  name?: string;
  content?: { text?: string }[];
}

const callIsOver = createClosingJudge(config.OPENAI_API_KEY, config.OPENAI_LLM_MODEL);

export default defineAgent({
  // Only GPT-Live needs a VAD in the session (for barge-in); load it once per process.
  prewarm: async (proc: JobProcess) => {
    if (config.AGENT_PIPELINE === 'live') proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const logger = log().child({ room: ctx.room.name });
    const reporter = new EventReporter(config.API_URL, config.INTERNAL_API_SECRET);
    // Read per call so knowledge base edits apply to the next call without a restart.
    const knowledge = loadKnowledge(KNOWLEDGE_DIR);

    await withTimeout(ctx.connect(), 20_000, 'room connect');
    const caller = await withTimeout(ctx.waitForParticipant(), 20_000, 'waiting for caller');
    const { source, callerNumber } = callerInfo(caller);
    const callId = ctx.room.name!;
    const startedAt = Date.now();
    reporter.send({ type: 'call-started', callId, source, callerNumber, startedAt });
    logger.info({ source, callerNumber }, 'call started');

    const notify = (payload: object) =>
      ctx.room.localParticipant
        ?.publishData(new TextEncoder().encode(JSON.stringify(payload)), { reliable: true, topic: NOTICE_TOPIC })
        .catch((err: Error) => logger.warn({ err: err.message }, 'notice publish failed'));

    let session: voice.AgentSession<CallUserData>;
    const live = config.AGENT_PIPELINE === 'live';

    // Fixed lines go through TTS; the speech-to-speech models have none, so they say them themselves.
    const speak = (text: string, allowInterruptions = true) =>
      config.AGENT_PIPELINE === 'cascade'
        ? session.say(text, { allowInterruptions })
        : session.generateReply({ instructions: `Say exactly: "${text}"`, allowInterruptions });

    // Says the goodbye (when given), waits for it to play, then closes the call.
    let hungUp = false;
    const hangup = async (goodbye?: string) => {
      if (hungUp) return;
      hungUp = true;
      if (goodbye) {
        // GPT-Live may decline a spoken request; hang up anyway rather than leave the line open.
        await speak(goodbye, false)
          .waitForPlayout()
          .catch((err: Error) => logger.warn({ err: err.message }, 'goodbye not spoken'));
      }
      // Tell the browser this is a deliberate hang-up (not a dropped call), then close the room.
      await notify({ type: 'hangup' });
      session.shutdown({ drain: true });
      await rooms.deleteRoom(callId).catch(() => undefined);
    };

    const services: CallServices = {
      callId,
      async saveLead(lead) {
        const full = { ...lead, callId, createdAt: Date.now() };
        try {
          await reporter.saveLead(full);
        } catch (err) {
          // The full lead goes in the log so staff can still call the person back.
          logger.error({ err: (err as Error).message, lead: full }, 'lead NOT saved');
          throw err; // the tool tells Chloe to apologise and give the email address
        }
        await notify({ type: 'lead-saved', lead: full });
        logger.info({ eventType: lead.eventType }, 'lead saved');
      },
      async transfer(department, reason) {
        const ts = Date.now();
        if (source === 'web') {
          const transfer = { callId, department, reason, status: 'transferring' as const, ts };
          reporter.send({ type: 'transfer', transfer });
          await notify({ type: 'transfer', transfer });
          return { status: 'web-demo' };
        }
        const target = transferTarget(config, department);
        if (!target) {
          reporter.send({ type: 'transfer', transfer: { callId, department, reason, status: 'unavailable', ts } });
          return { status: 'unavailable' };
        }
        try {
          await sip.transferSipParticipant(callId, caller.identity, toTelUri(target), { playDialtone: true });
          reporter.send({ type: 'transfer', transfer: { callId, department, reason, target, status: 'transferring', ts } });
          return { status: 'transferred' };
        } catch (err) {
          const error = (err as Error).message;
          logger.error({ err: error, department }, 'SIP transfer failed');
          reporter.send({ type: 'transfer', transfer: { callId, department, reason, target, status: 'failed', ts } });
          return { status: 'failed', error };
        }
      },
      async endCall(goodbye) {
        // GPT-Live's voice model says the goodbye itself before delegating the hang-up.
        await hangup(live ? undefined : goodbye);
      },
    };

    const instructionArgs = { source, callerNumber, now: new Date(), timezone: config.TIMEZONE };
    const liveInstructions = live ? buildLiveInstructions(knowledge, instructionArgs) : undefined;
    const instructions = liveInstructions?.voice ?? buildInstructions(knowledge, instructionArgs);

    session = new voice.AgentSession<CallUserData>(
      buildSessionOptions(
        config,
        { services },
        liveInstructions && { backendInstructions: liveInstructions.backend, vad: ctx.proc.userData.vad as VAD },
      ),
    );

    // ── live transcript ──────────────────────────────────────────────
    // User lines stream as interim text, then the committed conversation item closes them.
    // Everything the caller says until Chloe replies is one line (GPT-Live commits a
    // sentence in pieces when the caller pauses mid-sentence).
    let userTurn = 0;
    let userFinals = '';
    let userTurnText = '';
    // Response latency, pipeline-agnostic: caller stops speaking → Chloe starts speaking.
    let callerStoppedAt: number | undefined;
    let responseMs: number | undefined;
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.oldState === 'speaking' && ev.newState === 'listening') callerStoppedAt = ev.createdAt;
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (ev.newState !== 'speaking' || callerStoppedAt === undefined) return;
      responseMs = Math.round(ev.createdAt - callerStoppedAt);
      callerStoppedAt = undefined;
    });
    const send = (e: Omit<TranscriptEvent, 'callId' | 'ts'>, ts = Date.now()) =>
      reporter.send({ type: 'transcript', event: { ...e, callId, ts } });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      const text = `${userTurnText} ${userFinals} ${ev.transcript}`.replace(/\s+/g, ' ').trim();
      if (ev.isFinal) userFinals = text.slice(userTurnText.length).trim();
      send({ id: `u${userTurn}`, role: 'user', kind: 'interim', text });
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item;
      if (item.type !== 'message') return;
      const text = item.textContent ?? '';
      if (text.trim()) logger.info({ who: item.role === 'user' ? 'caller' : 'chloe', text }, 'said');
      if (item.role === 'user') {
        userTurnText = `${userTurnText} ${text}`.trim();
        lastCallerLine = userTurnText;
        userFinals = '';
        send({ id: `u${userTurn}`, role: 'user', kind: 'final', text: userTurnText });
      } else if (item.role === 'assistant') {
        if (userTurnText) {
          userTurn += 1;
          userTurnText = '';
        }
        const m = item.metrics;
        // Bot lines arrive after playout; date them from when Chloe started speaking.
        const spokeAt = m?.startedSpeakingAt ? Math.round(m.startedSpeakingAt * 1000) : item.createdAt;
        send({ id: item.id, role: 'bot', kind: 'final', text }, spokeAt);
        if (item.interrupted) send({ id: item.id, role: 'bot', kind: 'interrupted' }, spokeAt);
        if (live && text.trim()) void checkClosing(lastCallerLine, text);
        if (userTurn === 0 || responseMs === undefined) return; // greeting: no caller turn to measure from
        // Item metrics are in seconds and only filled by the cascade pipeline.
        const ms = (s?: number) => (s === undefined ? undefined : Math.round(s * 1000));
        const metrics = { e2eMs: responseMs, llmTtftMs: ms(m?.llmNodeTtft), ttsTtfbMs: ms(m?.ttsNodeTtfb), frameworkE2eMs: ms(m?.e2eLatency) };
        responseMs = undefined;
        logger.info(metrics, 'turn latency');
        reporter.send({ type: 'metrics', callId, ts: Date.now(), metrics });
      }
    });

    // GPT-Live's voice model often wraps up a call without delegating the hang-up. When the last
    // exchange reads as a finished call and nobody speaks for a few seconds, close it ourselves.
    const GOODBYE_NET_MS = 5_000;
    let lastCallerLine = '';
    let goodbyeTimer: NodeJS.Timeout | undefined;
    let callConcluded = false;
    const armGoodbyeNet = () => {
      clearTimeout(goodbyeTimer);
      goodbyeTimer = setTimeout(() => {
        logger.info('call wrapped up without end_call, hanging up');
        void hangup();
      }, GOODBYE_NET_MS);
    };
    const checkClosing = async (caller: string, chloe: string) => {
      clearTimeout(goodbyeTimer);
      callConcluded = await callIsOver(caller, chloe);
      logger.debug({ caller, chloe, callConcluded }, 'closing check');
      if (callConcluded) armGoodbyeNet();
    };
    // The caller talking pauses the timer; a "bye" back from them re-arms it.
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === 'speaking') clearTimeout(goodbyeTimer);
      else if (ev.newState === 'listening' && callConcluded) armGoodbyeNet();
    });

    // Dead air: after the session's away timeout (15 s of silence on both sides) check in once;
    // if the caller still says nothing, say goodbye and hang up.
    const HANGUP_AFTER_CHECK_IN_MS = 12_000;
    let checkedIn = false;
    let hangupTimer: NodeJS.Timeout | undefined;
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === 'speaking') {
        clearTimeout(hangupTimer);
        checkedIn = false;
      } else if (ev.newState === 'away' && !checkedIn) {
        checkedIn = true;
        void speak('Are you still there?')
          .waitForPlayout()
          .then(() => {
            hangupTimer = setTimeout(() => {
              logger.info('caller silent, hanging up');
              void hangup("I'll let you go. Thanks for calling LeMans, bye!");
            }, HANGUP_AFTER_CHECK_IN_MS);
          });
      }
    });

    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev) => {
      for (const [i, call] of ev.functionCalls.entries()) {
        logger.info({ tool: call.name, args: call.args, result: ev.functionCallOutputs[i]?.output }, 'tool ran');
      }
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      logger.error({ err: String(ev.error) }, 'session error');
    });

    let ended = false;
    const finish = async (reason: string) => {
      if (ended) return;
      ended = true;
      clearTimeout(hangupTimer);
      clearTimeout(goodbyeTimer);
      reporter.send({ type: 'call-ended', callId, endedAt: Date.now(), reason });
      await reporter.flush();
      logger.info({ reason, usage: session.usage }, 'call ended');
    };
    session.on(voice.AgentSessionEventTypes.Close, (ev) => void finish(ev.reason));
    ctx.addShutdownCallback(() => finish('job_shutdown'));

    const agent = new Receptionist(instructions, config.AGENT_PIPELINE === 'cascade' ? 'say' : 'generate');
    await session.start({ agent, room: ctx.room, inputOptions: { closeOnDisconnect: true } });

    if (live) {
      // What the voice model hands to the backend, and what the backend does with it.
      const duplex = agent.duplexSession as openai.realtime.GPTLiveSession;
      duplex.on('openai_server_event_received', (ev) => {
        if (ev.type === 'session.delegation.created') logger.info({ delegation: ev.delegation?.id }, 'GPT-Live delegated');
        if (ev.type !== 'response.event' || ev.event?.type !== 'response.output_item.done') return;
        const item = (ev.event as { item?: BackendItem }).item;
        const said = item?.content?.map((c) => c.text ?? '').join(' ');
        logger.info({ delegation: ev.delegation_id, kind: item?.type, tool: item?.name, said }, 'GPT-Live backend output');
      });
    }
  },
});

// Explicit dispatch: the agent only joins rooms that ask for it by name
// (web tokens and the SIP dispatch rule), never every room on the server.
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: config.AGENT_NAME,
    loadThreshold: config.AGENT_LOAD_THRESHOLD,
    // A dev laptop's CPU spikes (browser, bundler) make LiveKit skip the worker; only
    // servers should shed calls on load.
    loadFunc: config.NODE_ENV === 'production' ? undefined : async () => 0,
  }),
);
