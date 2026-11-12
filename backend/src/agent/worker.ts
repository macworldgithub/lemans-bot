import { fileURLToPath } from 'node:url';

import { cli, defineAgent, log, ServerOptions, voice, type JobContext, type JobProcess, type VAD } from '@livekit/agents';
import type * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { ParticipantKind, type RemoteParticipant } from '@livekit/rtc-node';
import { RoomServiceClient, SipClient } from 'livekit-server-sdk';

import { config, KNOWLEDGE_DIR } from '../config.js';
import { loadKnowledge } from '../knowledge/loader.js';
import { hoursQueryResultSchema } from '../hours/schema.js';
import { readMessageResult } from '../messaging/schema.js';
import { NOTICE_TOPIC, type CallSource, type TranscriptEvent } from '../shared/events.js';
import { createClosingJudge } from './closing.js';
import { buildSessionOptions } from './pipeline.js';
import { buildInstructions, buildLiveInstructions } from './prompt.js';
import { Receptionist, takeSmsConsent } from './receptionist.js';
import { EventReporter } from './reporter.js';
import { bindResponseGuard, ResponseGuard } from './response-guard.js';
import { aiMayCloseRoom, createCallState, recordCallerTurn, setCallOwnership } from './state.js';
import { resolveTransferTarget, toTelUri } from './transfer.js';
import type { CallServices, CallUserData } from './tools.js';

/** A slow answer is not evidence that information is unknown. */
const WAITING_TEXT = 'One moment while I check that.';

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

/** Fields of a GPT-Live backend output item worth logging (never its text). */
interface BackendItem {
  type?: string;
  name?: string;
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
    const afterCallSms = config.AGENT_PIPELINE === 'cascade' && (source === 'web' || config.SMS_ENABLED);
    const callId = ctx.room.name!;
    const startedAt = Date.now();
    reporter.send({ type: 'call-started', callId, source, callerNumber, startedAt });
    const maskedCaller = callerNumber ? `${callerNumber.slice(0, 4)}***` : undefined;
    logger.info({ source, caller: maskedCaller }, 'call started');

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

    const state = createCallState({
      callId,
      channel: source,
      callerNumber,
      callerParticipantId: caller.identity,
    });

    // GPT-Live owns its speech turns. Observe slow replies without interrupting
    // or injecting another reply. Other pipelines can give one waiting cue.
    const responseGuard = new ResponseGuard({
      mode: live ? 'observe' : 'recover',
      onSlow: (_turnId, elapsedMs) => {
        logger.warn({ thresholdMs: 3000, elapsedMs }, 'response target exceeded');
      },
      onRecovery: async () => {
        if (session.agentState === 'speaking' || session.userState === 'speaking') return;
        logger.info({ thresholdMs: 3000 }, 'waiting cue requested');
        await speak(WAITING_TEXT)
          .waitForPlayout()
          .catch((err: Error) => logger.warn({ err: err.message }, 'recovery not spoken'));
      },
      onError: (err) => logger.warn({ err: String(err) }, 'recovery handler failed'),
    });

    // Says the goodbye (when given), waits for it to play, then closes the call.
    let hungUp = false;
    let roomDeletion: Promise<boolean> | undefined;
    const hangup = async (goodbye?: string) => {
      if (hungUp) return;
      hungUp = true;
      responseGuard.close();
      if (goodbye) {
        // GPT-Live may decline a spoken request; hang up anyway rather than leave the line open.
        await speak(goodbye, false)
          .waitForPlayout()
          .catch((err: Error) => logger.warn({ err: err.message }, 'goodbye not spoken'));
      }
      // A human-owned call must survive AI departure. Do not remove the room.
      if (!aiMayCloseRoom(state)) {
        logger.info('human-owned call: AI will not delete the room');
        session.shutdown({ drain: true });
        return;
      }
      // Tell the browser this is a deliberate hang-up (not a dropped call), then close the room.
      await notify({ type: 'hangup' });
      roomDeletion = rooms.deleteRoom(callId).then(() => true, () => false);
      session.shutdown({ drain: true });
      await roomDeletion;
    };

    const services: CallServices = {
      callId,
      getSmsConsent(context) {
        if (config.AGENT_PIPELINE !== 'cascade') return undefined;
        const run = context as voice.RunContext<CallUserData>;
        return ended ? undefined : takeSmsConsent(state, run);
      },
      async saveLead(lead) {
        const full = { ...lead, callId, createdAt: Date.now() };
        try {
          await reporter.saveLead(full);
        } catch (err) {
          logger.error(
            { err: (err as Error).message, callId, eventType: lead.eventType, operationId: lead.operationId },
            'lead NOT saved',
          );
          throw err;
        }
        await notify({ type: 'lead-saved', lead: full });
        logger.info({ callId, eventType: lead.eventType, operationId: lead.operationId }, 'lead saved');
      },
      async transfer(department, reason) {
        const ts = Date.now();
        // A recovery must not speak over a transfer.
        responseGuard.cancel();
        if (source === 'web') {
          const transfer = { callId, department, reason, status: 'simulated' as const, ts };
          reporter.send({ type: 'transfer', transfer });
          await notify({ type: 'transfer', transfer });
          return { status: 'web-demo' };
        }
        const resolved = resolveTransferTarget(config, department);
        if (!resolved.target) {
          logger.warn({ department, routeReason: resolved.reason }, 'transfer route unavailable');
          reporter.send({ type: 'transfer', transfer: { callId, department, reason, status: 'unavailable', ts } });
          return { status: 'unavailable' };
        }
        try {
          // A timeout is not proof that no transfer was requested. Never redial it.
          await withTimeout(
            sip.transferSipParticipant(callId, caller.identity, toTelUri(resolved.target), {
              playDialtone: true,
            }),
            15_000,
            'SIP transfer',
          );
          setCallOwnership(state, 'human');
          reporter.send({
            type: 'transfer',
            transfer: { callId, department, reason, target: resolved.target, status: 'transferred', ts },
          });
          return { status: 'transferred' };
        } catch (err) {
          const error = (err as Error).message;
          const uncertain = /timed out/i.test(error);
          logger.error({ err: error, department, uncertain }, 'SIP transfer failed');
          reporter.send({
            type: 'transfer',
            transfer: {
              callId,
              department,
              reason,
              target: resolved.target,
              status: uncertain ? 'unknown' : 'failed',
              ts,
            },
          });
          return uncertain ? { status: 'unknown', error } : { status: 'failed', error };
        }
      },
      async endCall(goodbye) {
        // GPT-Live's voice model says the goodbye itself before delegating the hang-up.
        await hangup(live ? undefined : goodbye);
      },
      async lookupHours(query) {
        const params = new URLSearchParams();
        if (query.date) params.set('date', query.date);
        params.set('schedule', query.schedule);
        try {
          const res = await fetch(`${config.API_URL}/internal/hours?${params.toString()}`, {
            headers: { 'x-internal-secret': config.INTERNAL_API_SECRET },
            signal: AbortSignal.timeout(3000),
          });
          if (!res.ok) {
            return { status: 'unknown', date: query.date ?? '', schedule: query.schedule };
          }
          const parsed = hoursQueryResultSchema.safeParse(await res.json());
          if (!parsed.success || parsed.data.schedule !== query.schedule || (query.date && parsed.data.date !== query.date)) {
            return { status: 'unknown', date: query.date ?? '', schedule: query.schedule };
          }
          return parsed.data;
        } catch {
          return { status: 'unknown', date: query.date ?? '', schedule: query.schedule };
        }
      },
      async prepareLinkSms(params) {
        const res = await fetch(`${config.API_URL}/internal/messages/drafts`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-internal-secret': config.INTERNAL_API_SECRET,
          },
          body: JSON.stringify({
            callId,
            purpose: params.purpose,
            phone: params.phone,
            version: params.version,
            delivery: 'after_call',
          }),
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) {
          throw new Error(`SMS draft request failed with HTTP ${res.status}`);
        }
        const data = (await res.json()) as {
          draftId?: unknown;
          recipient?: unknown;
          version?: unknown;
        };
        if (
          typeof data.draftId !== 'string' ||
          typeof data.recipient !== 'string' ||
          data.version !== params.version
        ) {
          throw new Error('SMS draft response failed validation');
        }
        return { draftId: data.draftId, recipient: data.recipient, version: data.version };
      },
      async reviewLinkSms(params) {
        // Realtime models cannot prove they spoke the requested exact review here.
        if (config.AGENT_PIPELINE !== 'cascade') return undefined;
        const draft = state.pendingDraft;
        if (!draft || draft.id !== params.draftId || draft.version !== params.version || draft.recipient !== params.recipient || draft.purpose !== params.purpose) return undefined;
        const callerSequence = state.turnCount;
        responseGuard.cancel();
        const spokenNumber = params.recipient.split('').join(' ');
        const speech = session.say(`After this call ends, I will text the ${params.purpose === 'booking' ? 'booking' : 'location'} link to ${spokenNumber}. Shall I send it?`);
        try { await speech.waitForPlayout(); } catch { return undefined; }
        if (speech.interrupted || speech.exception() || state.pendingDraft !== draft || state.requestVersion !== params.version || state.turnCount !== callerSequence) return undefined;
        const review = { speechId: speech.id, completedAt: Date.now(), callerSequence };
        try {
          const res = await fetch(`${config.API_URL}/internal/messages/${encodeURIComponent(params.draftId)}/review`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': config.INTERNAL_API_SECRET },
            body: JSON.stringify({ callId, expectedVersion: params.version, review }), signal: AbortSignal.timeout(3000),
          });
          return res.ok && state.pendingDraft === draft && state.turnCount === callerSequence ? review : undefined;
        } catch { return undefined; }
      },
      async cancelLinkSms(params) {
        try {
          const res = await fetch(
            `${config.API_URL}/internal/messages/${encodeURIComponent(params.draftId)}/cancel`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-internal-secret': config.INTERNAL_API_SECRET,
              },
              body: JSON.stringify({ callId }),
              signal: AbortSignal.timeout(3000),
            },
          );
          if (!res.ok) {
            logger.warn({ callId, status: res.status }, 'SMS draft cancel rejected');
          }
        } catch (err) {
          logger.warn({ err: (err as Error).message, callId }, 'SMS draft cancel failed');
        }
      },
      async sendLinkSms(params) {
        try {
          const res = await fetch(`${config.API_URL}/internal/messages/${encodeURIComponent(params.draftId)}/approve-after-call`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-internal-secret': config.INTERNAL_API_SECRET,
            },
            body: JSON.stringify({
              callId,
              expectedVersion: params.version,
              channel: source,
              consent: params.consent,
            }),
            signal: AbortSignal.timeout(6000),
          });
          return await readMessageResult(res);
        } catch (err) {
          logger.warn({ err: (err as Error).message, callId }, 'SMS send request failed');
          return { status: 'unknown' };
        }
      },
    };

    const instructionArgs = { source, callerNumber, now: new Date(), timezone: config.TIMEZONE };
    const liveInstructions = live ? buildLiveInstructions(knowledge, instructionArgs) : undefined;
    const instructions = liveInstructions?.voice ?? buildInstructions(knowledge, instructionArgs, afterCallSms);

    session = new voice.AgentSession<CallUserData>(
      buildSessionOptions(
        config,
        { services, state },
        liveInstructions && { backendInstructions: liveInstructions.backend, vad: ctx.proc.userData.vad as VAD },
      ),
    );
    bindResponseGuard(session, responseGuard);

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
      if (item.role === 'user') {
        userTurnText = `${userTurnText} ${text}`.trim();
        lastCallerLine = userTurnText;
        userFinals = '';
        recordCallerTurn(state, item.id);
        // Transcript items update request provenance and closing state. Audio
        // events own response timing; late fragments must not request more speech.
        callConcluded = false;
        clearTimeout(goodbyeTimer);
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
        // Bind a closing decision to the exchange it judged. A later caller turn
        // increments the version and makes this result stale.
        if (live && text.trim()) void checkClosing(lastCallerLine, text, state.closingCheckVersion);
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
    const effectPending = () =>
      state.transferStatus === 'requested' ||
      state.transferStatus === 'transferring' ||
      Boolean(state.pendingDraft?.consentMessageId && !state.pendingDraft.sentOperationId) ||
      responseGuard.awaitingAnswer;
    const armGoodbyeNet = () => {
      clearTimeout(goodbyeTimer);
      goodbyeTimer = setTimeout(() => {
        if (effectPending()) {
          logger.info('hangup held for pending effect');
          return;
        }
        logger.info('call wrapped up without end_call, hanging up');
        void hangup();
      }, GOODBYE_NET_MS);
    };
    const checkClosing = async (caller: string, chloe: string, version: number) => {
      clearTimeout(goodbyeTimer);
      const concluded = await callIsOver(caller, chloe);
      // Ignore a late judgement from an older exchange, a closed call, or a human-owned call.
      if (version !== state.closingCheckVersion || ended || !aiMayCloseRoom(state)) return;
      callConcluded = concluded;
      logger.debug({ callConcluded }, 'closing check');
      if (concluded) armGoodbyeNet();
    };
    // The caller talking pauses the timer; a "bye" back from them re-arms it.
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === 'speaking') {
        clearTimeout(goodbyeTimer);
        callConcluded = false;
      } else if (ev.newState === 'listening' && callConcluded && !effectPending()) {
        armGoodbyeNet();
      }
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
        if (effectPending()) {
          logger.info('dead-air check held for pending effect');
          return;
        }
        checkedIn = true;
        void speak('Are you still there?')
          .waitForPlayout()
          .then(() => {
            hangupTimer = setTimeout(() => {
              if (effectPending()) {
                logger.info('dead-air hangup held for pending effect');
                return;
              }
              logger.info('caller silent, hanging up');
              void hangup("I'll let you go. Thanks for calling LeMans, bye!");
            }, HANGUP_AFTER_CHECK_IN_MS);
          });
      }
    });

    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev) => {
      // Tool arguments and results can hold phone numbers and personal data.
      for (const call of ev.functionCalls) logger.info({ tool: call.name }, 'tool ran');
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      logger.error({ err: String(ev.error) }, 'session error');
      // Live mode records this failure without injecting another model reply.
      responseGuard.failCurrent();
    });

    let ended = false;
    let finishTask: Promise<void> | undefined;
    const finish = (reason: string): Promise<void> => {
      if (finishTask) return finishTask;
      finishTask = (async () => {
      ended = true;
      responseGuard.close();
      clearTimeout(hangupTimer);
      clearTimeout(goodbyeTimer);
      // An unsent, unconfirmed draft is cancelled on disconnect. A submitted
      // operation stays in the store for its later receipt.
      const draft = state.pendingDraft;
      if (draft && !draft.scheduledAfterCall && !draft.sentOperationId && !draft.submissionState && services.cancelLinkSms) {
        await services
          .cancelLinkSms({ draftId: draft.id, version: draft.version })
          .catch(() => undefined);
      }
      reporter.send({ type: 'call-ended', callId, endedAt: Date.now(), reason });
      await reporter.flush();
      const deleted = roomDeletion ? await roomDeletion : false;
      if (reason === voice.CloseReason.PARTICIPANT_DISCONNECTED || deleted) {
        const approved = state.pendingDraft?.scheduledAfterCall ? state.pendingDraft.id : undefined;
        await reporter.completeMessages(callId, deleted ? 'room_deleted' : 'caller_disconnected', approved)
          .catch(() => logger.error({ callId, code: 'post_call_sms_dispatch_failed' }, 'After-call SMS needs review'));
      }
      logger.info({ reason, usage: session.usage }, 'call ended');
      })();
      return finishTask;
    };
    session.on(voice.AgentSessionEventTypes.Close, (ev) => void finish(ev.reason));
    ctx.addShutdownCallback(() => finish('job_shutdown'));

    const agent = new Receptionist(instructions, config.AGENT_PIPELINE === 'cascade' ? 'say' : 'generate', afterCallSms);
    await session.start({ agent, room: ctx.room, inputOptions: { closeOnDisconnect: true } });

    if (live) {
      // What the voice model hands to the backend, and what the backend does with it.
      const duplex = agent.duplexSession as openai.realtime.GPTLiveSession;
      duplex.on('openai_server_event_received', (ev) => {
        if (ev.type === 'session.delegation.created') logger.info({ delegation: ev.delegation?.id }, 'GPT-Live delegated');
        if (ev.type !== 'response.event' || ev.event?.type !== 'response.output_item.done') return;
        const item = (ev.event as { item?: BackendItem }).item;
        logger.info({ delegation: ev.delegation_id, kind: item?.type, tool: item?.name }, 'GPT-Live backend output');
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
