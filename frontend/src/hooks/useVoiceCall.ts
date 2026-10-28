import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DisconnectReason,
  type Participant,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
  type TextStreamReader,
} from 'livekit-client';

import type { BadgeTone } from '../components/StatusBadge';
import type { OrbState } from '../components/Orb';
import { applyTranscriptEvent, finalizeAll, type TranscriptLine } from '../lib/transcript';

export type CallPhase = 'idle' | 'connecting' | 'active' | 'ended';

export interface LeadNotice {
  name?: string;
  eventType?: string;
}

export interface TransferNotice {
  department: 'reservations' | 'corporate' | 'duty_manager';
  status: string;
}

// Must match backend/src/shared/events.ts and the agents framework topics.
const NOTICE_TOPIC = 'lemans.notice';
const TRANSCRIPTION_TOPIC = 'lk.transcription';
const AGENT_STATE_ATTR = 'lk.agent.state';
/** No agent in the room by then means no worker could take the call. */
const AGENT_JOIN_TIMEOUT_MS = 15_000;

type Status = { text: string; tone: BadgeTone };
const STATUS = {
  ready: { text: 'Ready to connect', tone: 'default' },
  connecting: { text: 'Connecting...', tone: 'default' },
  waiting: { text: 'Connected — waiting for Chloe...', tone: 'connected' },
  listening: { text: 'Listening...', tone: 'connected' },
  thinking: { text: 'Chloe is thinking...', tone: 'connected' },
  speaking: { text: 'Chloe is speaking...', tone: 'speaking' },
  ended: { text: 'Call ended', tone: 'default' },
  unavailable: { text: 'Chloe is unavailable right now — please try again', tone: 'default' },
  dropped: { text: 'Call dropped — please try again', tone: 'default' },
} satisfies Record<string, Status>;

type Stage = 'token' | 'connect' | 'mic';

function startErrorMessage(stage: Stage, err: unknown): string {
  if (stage === 'token' && (err as Error).message === 'rate-limited') return 'Too many calls — try again in a minute';
  if (stage === 'mic') {
    const name = (err as { name?: string }).name;
    if (name === 'NotAllowedError') return 'Mic access denied — check browser permissions';
    if (name === 'NotFoundError') return 'No microphone found';
  }
  return 'Could not reach the call server — please try again';
}

/** Web demo call: joins a LiveKit room, the receptionist agent is dispatched into it. */
export function useVoiceCall() {
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [orb, setOrb] = useState<OrbState>('idle');
  const [status, setStatus] = useState<Status>(STATUS.ready);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [lead, setLead] = useState<LeadNotice | null>(null);
  const [transfer, setTransfer] = useState<TransferNotice | null>(null);

  const roomRef = useRef<Room | null>(null);
  const audioRef = useRef<HTMLDivElement | null>(null);
  const joinTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const applyAgentState = useCallback((state: string | undefined) => {
    if (state === 'speaking') {
      setOrb('speaking');
      setStatus(STATUS.speaking);
    } else if (state === 'thinking') {
      setOrb('listening');
      setStatus(STATUS.thinking);
    } else if (state === 'listening' || state === 'idle') {
      setOrb('listening');
      setStatus(STATUS.listening);
    }
  }, []);

  const finish = useCallback((message: Status = STATUS.ended) => {
    clearTimeout(joinTimer.current);
    const room = roomRef.current;
    roomRef.current = null;
    room?.removeAllListeners();
    void room?.disconnect();
    if (audioRef.current) audioRef.current.textContent = '';
    setPhase('ended');
    setOrb('idle');
    setStatus(message);
    setLines((prev) => finalizeAll(prev));
    setLead(null);
    setTransfer(null);
  }, []);

  const start = useCallback(async () => {
    if (roomRef.current) return;
    setPhase('connecting');
    setStatus(STATUS.connecting);

    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    roomRef.current = room;

    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();
        audioRef.current?.appendChild(el);
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => track.detach().forEach((el) => el.remove()))
      .on(RoomEvent.ParticipantAttributesChanged, (changed: Record<string, string>, p: Participant) => {
        if (p.isAgent && AGENT_STATE_ATTR in changed) applyAgentState(changed[AGENT_STATE_ATTR]);
      })
      .on(RoomEvent.ParticipantConnected, (p: Participant) => {
        if (!p.isAgent) return;
        clearTimeout(joinTimer.current);
        applyAgentState(p.attributes[AGENT_STATE_ATTR] ?? 'listening');
      })
      .on(RoomEvent.ParticipantDisconnected, (p: Participant) => {
        // Agent hung up (end_call deletes the room, handled by Disconnected) or crashed.
        if (p.isAgent && roomRef.current === room) finish(STATUS.dropped);
      })
      .on(RoomEvent.DataReceived, (payload: Uint8Array, _p?: Participant, _k?: unknown, topic?: string) => {
        if (topic !== NOTICE_TOPIC) return;
        try {
          const notice = JSON.parse(new TextDecoder().decode(payload));
          if (notice.type === 'hangup') finish();
          else if (notice.type === 'lead-saved') setLead(notice.lead);
          else if (notice.type === 'transfer') setTransfer(notice.transfer);
        } catch {
          // ignore malformed notices
        }
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (roomRef.current !== room) return; // user pressed End Call
        if (reason !== DisconnectReason.CLIENT_INITIATED) finish();
      });

    // Live transcript: one text stream per segment. Interim streams carry the text so far,
    // the final stream the committed text. Agent speech arrives word by word, in sync with audio.
    room.registerTextStreamHandler(TRANSCRIPTION_TOPIC, async (reader: TextStreamReader, from: { identity: string }) => {
      const attrs = reader.info.attributes ?? {};
      const id = attrs['lk.segment_id'] ?? reader.info.id;
      const role = from.identity === room.localParticipant.identity ? 'user' : 'bot';
      const isFinal = attrs['lk.transcription_final'] === 'true';
      const ts = reader.info.timestamp ?? Date.now();
      let text = '';
      for await (const chunk of reader) {
        text += chunk;
        if (!isFinal) setLines((prev) => applyTranscriptEvent(prev, { id, role, kind: 'interim', text, ts }));
      }
      if (isFinal) setLines((prev) => applyTranscriptEvent(prev, { id, role, kind: 'final', text, ts }));
    });

    let stage: Stage = 'token';
    try {
      const res = await fetch('/api/token', { method: 'POST' });
      if (!res.ok) throw new Error(res.status === 429 ? 'rate-limited' : `token request failed (${res.status})`);
      const { serverUrl, participantToken } = (await res.json()) as { serverUrl: string; participantToken: string };

      stage = 'connect';
      await room.connect(serverUrl, participantToken);
      stage = 'mic';
      await room.localParticipant.setMicrophoneEnabled(true);
      await room.startAudio();

      setLines([]);
      setStartedAt(Date.now());
      setShowTranscript(true);
      setPhase('active');
      setOrb('listening');
      setStatus(STATUS.waiting);
      const agent = [...room.remoteParticipants.values()].find((p) => p.isAgent);
      if (agent) applyAgentState(agent.attributes[AGENT_STATE_ATTR]);
      else joinTimer.current = setTimeout(() => roomRef.current === room && finish(STATUS.unavailable), AGENT_JOIN_TIMEOUT_MS);
    } catch (err) {
      console.error(`Call failed to start (${stage}):`, err);
      finish({ text: startErrorMessage(stage, err), tone: 'default' });
      setPhase('idle');
    }
  }, [applyAgentState, finish]);

  const end = useCallback(() => finish(), [finish]);

  // Leave the room if the page is closed or the component unmounts mid-call.
  useEffect(() => {
    const leave = () => void roomRef.current?.disconnect();
    window.addEventListener('beforeunload', leave);
    return () => {
      window.removeEventListener('beforeunload', leave);
      leave();
    };
  }, []);

  return {
    phase,
    orb,
    status,
    lines,
    startedAt,
    showTranscript,
    lead,
    transfer,
    start,
    end,
    audioRef,
  };
}
