import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import dgram, { RemoteInfo, Socket } from 'dgram';
import { CallLatency } from './call-latency';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';

type RemoteEndpoint = {
  address: string;
  port: number;
};

type RtpSession = {
  callId: string;
  remote?: RemoteEndpoint;
  explicitRemote: boolean;
  packetsRx: number;
  bytesRx: number;
  lastPacketAt?: string;
  txSequence: number;
  txTimestamp: number;
  ssrc: number;
  txQueue?: Buffer;
  txDrainTimer?: ReturnType<typeof setTimeout> | null;
  txNextPacketAt?: number;
  txStartedAt?: number;
  txLastAudioAt?: number;
  txIdleSince?: number;
  txAudioStarted?: boolean;
};

// G.711 µ-law RTP is 8 kHz: 160 samples make one standard 20 ms packet.
const RTP_SAMPLE_RATE_HZ = 8_000;
const RTP_PACKET_DURATION_MS = 20;
const RTP_PACKET_SAMPLES =
  (RTP_SAMPLE_RATE_HZ * RTP_PACKET_DURATION_MS) / 1_000;
const RTP_PREBUFFER_PACKETS = 2;
const RTP_PREBUFFER_TIMEOUT_MS = 60;
const RTP_PARTIAL_PACKET_TIMEOUT_MS = 60;
const RTP_IDLE_SILENCE_MS = 400;
const RTP_ULAW_SILENCE = 0xff;

type AudioFrameHandler = (frame: {
  callId: string;
  payload: Buffer;
  receivedAtMs: number;
  sequenceNumber: number;
  timestamp: number;
  marker: boolean;
  payloadType: number;
}) => void;

@Injectable()
export class AriRtpMediaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AriRtpMediaService.name);
  private socket: Socket | null = null;
  private readonly sessions = new Map<string, RtpSession>();
  private readonly remoteKeyToCallId = new Map<string, string>();
  private onAudioFrameHandler: AudioFrameHandler | null = null;
  private onStartupFailure: ((callId: string, reason: string) => void) | null =
    null;
  private readonly pendingPackets = new Map<
    string,
    {
      remote: RemoteInfo;
      packets: { packet: Buffer; receivedAtMs: number }[];
      bytes: number;
    }
  >();

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.startSocket();
  }

  onModuleDestroy() {
    for (const callId of this.sessions.keys())
      this.unregisterCallSession(callId);
    this.pendingPackets.clear();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  getHealth() {
    return {
      listening: Boolean(this.socket),
      bindHost: this.getBindHost(),
      bindPort: this.getBindPort(),
      activeRtpSessions: this.sessions.size,
    };
  }

  setAudioFrameHandler(handler: AudioFrameHandler) {
    this.onAudioFrameHandler = handler;
  }

  setStartupFailureHandler(handler: (callId: string, reason: string) => void) {
    this.onStartupFailure = handler;
  }

  setRemoteEndpoint(callId: string, address: string, port: number) {
    const session = this.sessions.get(callId);
    if (!session) throw new Error('RTP call no longer active');
    if (
      isIP(address) !== 4 ||
      address === '0.0.0.0' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      throw new Error('Invalid Asterisk RTP endpoint');
    }
    const key = this.toRemoteKey({ address, port });
    const owner = this.remoteKeyToCallId.get(key);
    if (owner && owner !== callId)
      throw new Error('RTP endpoint already owned by another call');
    if (session.remote)
      this.remoteKeyToCallId.delete(this.toRemoteKey(session.remote));
    session.remote = { address, port };
    this.remoteKeyToCallId.set(key, callId);
    const pending = this.pendingPackets.get(key);
    this.pendingPackets.delete(key);
    if (pending) {
      for (const { packet, receivedAtMs } of pending.packets) {
        this.handleIncomingPacket(packet, pending.remote, receivedAtMs);
      }
    }
    if (
      ![...this.sessions.values()].some(
        (call) => call.explicitRemote && !call.remote,
      )
    ) {
      this.pendingPackets.clear();
    }
  }

  registerCallSession(callId: string, explicitRemote = false) {
    if (this.sessions.has(callId)) {
      return;
    }

    this.sessions.set(callId, {
      callId,
      explicitRemote,
      packetsRx: 0,
      bytesRx: 0,
      txSequence: Math.floor(Math.random() * 65535),
      txTimestamp: Math.floor(Math.random() * 0xffffffff),
      ssrc: Math.floor(Math.random() * 0xffffffff),
    });

    this.logger.log(`RTP session registered for call=${callId}`);
  }

  unregisterCallSession(callId: string) {
    const session = this.sessions.get(callId);
    if (!session) {
      return;
    }

    if (session.txDrainTimer) {
      clearTimeout(session.txDrainTimer);
      session.txDrainTimer = null;
    }
    session.txQueue = undefined;

    if (session.remote) {
      this.remoteKeyToCallId.delete(this.toRemoteKey(session.remote));
    }

    this.sessions.delete(callId);
    if (
      ![...this.sessions.values()].some(
        (call) => call.explicitRemote && !call.remote,
      )
    ) {
      this.pendingPackets.clear();
    }
    this.logger.log(`RTP session unregistered for call=${callId}`);
  }

  sendUlawToCall(callId: string, ulawPayload: Buffer) {
    const session = this.sessions.get(callId);
    if (!session || !session.remote || !this.socket) {
      return;
    }

    if (!ulawPayload.length) return;

    // Append to the session's output queue; the drain timer sends at steady 20ms pace
    if (!session.txQueue) {
      session.txQueue = Buffer.alloc(0);
    }
    // Preserve the provider's samples and duration. Shortening streamed chunks
    // can exhaust the queue before the next chunk arrives and introduce gaps.
    session.txQueue = Buffer.concat([session.txQueue, ulawPayload]);
    session.txLastAudioAt = performance.now();
    session.txIdleSince = undefined;
    CallLatency.mark(callId, 'OUTPUT_QUEUED', 'First AI audio queued for RTP');

    // Start the drain timer if not already running
    if (!session.txDrainTimer) {
      this.startDrainTimer(session);
    }
  }

  /**
   * Flush any queued audio (called on barge-in / speech start)
   */
  flushQueue(callId: string) {
    const session = this.sessions.get(callId);
    if (!session) return;
    session.txQueue = Buffer.alloc(0);
    session.txLastAudioAt = undefined;
  }

  isOutputQueueDrained(callId: string): boolean {
    const session = this.sessions.get(callId);
    return !session || !session.txQueue?.length;
  }

  private startDrainTimer(session: RtpSession) {
    session.txStartedAt = performance.now();
    session.txNextPacketAt = session.txStartedAt + RTP_PACKET_DURATION_MS;
    this.scheduleDrainTick(session);
  }

  private scheduleDrainTick(session: RtpSession) {
    if (session.txDrainTimer) return;
    const dueAt = session.txNextPacketAt ?? performance.now();
    const delay = Math.max(0, dueAt - performance.now());
    session.txDrainTimer = setTimeout(() => {
      session.txDrainTimer = null;
      this.drainRtpPacket(session);
    }, delay);
  }

  private drainRtpPacket(session: RtpSession) {
    if (!this.sessions.has(session.callId)) return;
    if (!session.remote || !this.socket) {
      session.txNextPacketAt = undefined;
      session.txStartedAt = undefined;
      session.txAudioStarted = false;
      return;
    }

    const now = performance.now();
    const queue = session.txQueue ?? Buffer.alloc(0);
    let packet: Buffer;
    const prebufferBytes = RTP_PACKET_SAMPLES * RTP_PREBUFFER_PACKETS;
    const prebufferElapsed = now - (session.txStartedAt ?? now);

    if (
      !session.txAudioStarted &&
      queue.length < prebufferBytes &&
      prebufferElapsed < RTP_PREBUFFER_TIMEOUT_MS
    ) {
      packet = Buffer.alloc(RTP_PACKET_SAMPLES, RTP_ULAW_SILENCE);
    } else if (queue.length >= RTP_PACKET_SAMPLES) {
      packet = queue.subarray(0, RTP_PACKET_SAMPLES);
      session.txQueue = queue.subarray(RTP_PACKET_SAMPLES);
      session.txAudioStarted = true;
    } else if (
      queue.length > 0 &&
      now - (session.txLastAudioAt ?? now) >= RTP_PARTIAL_PACKET_TIMEOUT_MS
    ) {
      packet = Buffer.alloc(RTP_PACKET_SAMPLES, RTP_ULAW_SILENCE);
      queue.copy(packet, 0);
      session.txQueue = Buffer.alloc(0);
      session.txAudioStarted = true;
    } else {
      packet = Buffer.alloc(RTP_PACKET_SAMPLES, RTP_ULAW_SILENCE);
    }

    if (!session.txQueue?.length) {
      session.txIdleSince ??= now;
      if (now - session.txIdleSince >= RTP_IDLE_SILENCE_MS) {
        session.txNextPacketAt = undefined;
        session.txStartedAt = undefined;
        session.txIdleSince = undefined;
        session.txAudioStarted = false;
        return;
      }
    } else {
      session.txIdleSince = undefined;
    }

    const rtpPacket = this.buildRtpPacket(session, packet);
    this.socket.send(
      rtpPacket,
      session.remote.port,
      session.remote.address,
      (error) => {
        if (error) {
          this.logger.error('RTP socket error: ' + error.message);
          return;
        }
        CallLatency.mark(
          session.callId,
          'T15',
          'First AI RTP packet sent toward Asterisk',
        );
      },
    );

    const nextAt = (session.txNextPacketAt ?? now) + RTP_PACKET_DURATION_MS;
    // Keep the packet clock steady without sending catch-up bursts if the event
    // loop was briefly delayed.
    session.txNextPacketAt =
      now >= nextAt ? now + RTP_PACKET_DURATION_MS : nextAt;
    this.scheduleDrainTick(session);
  }

  private startSocket() {
    if (this.socket) {
      return;
    }

    this.socket = dgram.createSocket('udp4');

    this.socket.on('message', (message: Buffer, remote: RemoteInfo) => {
      this.handleIncomingPacket(message, remote);
    });

    this.socket.on('error', (error) => {
      this.logger.error(`RTP socket error: ${error.message}`);
    });

    const host = this.getBindHost();
    const port = this.getBindPort();
    this.socket.bind(port, host, () => {
      this.logger.log(`RTP media socket listening on ${host}:${port}`);
    });
  }

  private handleIncomingPacket(
    packet: Buffer,
    remote: RemoteInfo,
    receivedAtMs = performance.now(),
  ) {
    if (packet.length < 12 || packet[0] >> 6 !== 2) {
      return;
    }

    const remoteKey = this.toRemoteKey({
      address: remote.address,
      port: remote.port,
    });
    let callId = this.remoteKeyToCallId.get(remoteKey);

    if (!callId) {
      callId = this.bindRemoteToPendingSession(remote.address, remote.port);
      if (!callId) {
        this.bufferPendingPacket(remoteKey, packet, remote, receivedAtMs);
        return;
      }
    }

    const session = this.sessions.get(callId);
    if (!session) {
      return;
    }

    const version = packet[0] >> 6;
    if (version !== 2) {
      return;
    }

    const marker = (packet[1] & 0x80) !== 0;
    const payloadType = packet[1] & 0x7f;
    const sequenceNumber = packet.readUInt16BE(2);
    const timestamp = packet.readUInt32BE(4);

    const csrcCount = packet[0] & 0x0f;
    const headerLength = 12 + csrcCount * 4;
    if (packet.length < headerLength) {
      return;
    }

    const payload = packet.subarray(headerLength);
    session.packetsRx += 1;
    session.bytesRx += payload.length;
    session.lastPacketAt = new Date().toISOString();

    if (this.onAudioFrameHandler) {
      this.onAudioFrameHandler({
        callId,
        payload,
        receivedAtMs,
        sequenceNumber,
        timestamp,
        marker,
        payloadType,
      });
    }
  }

  private bufferPendingPacket(
    key: string,
    packet: Buffer,
    remote: RemoteInfo,
    receivedAtMs: number,
  ) {
    const pendingCalls = [...this.sessions.values()].filter(
      (call) => call.explicitRemote && !call.remote,
    );
    if (!pendingCalls.length) return;
    let pending = this.pendingPackets.get(key);
    // Bound unaffiliated packets during endpoint lookup; overflow fails startup explicitly.
    if (
      (!pending && this.pendingPackets.size >= 16) ||
      (pending?.bytes ?? 0) + packet.length > 80_000
    ) {
      for (const call of pendingCalls)
        this.onStartupFailure?.(call.callId, 'RTP_STARTUP_BUFFER_LIMIT');
      return;
    }
    if (!pending) {
      pending = { remote, packets: [], bytes: 0 };
      this.pendingPackets.set(key, pending);
    }
    pending.packets.push({ packet: Buffer.from(packet), receivedAtMs });
    pending.bytes += packet.length;
  }

  private bindRemoteToPendingSession(
    address: string,
    port: number,
  ): string | undefined {
    const unboundSession = [...this.sessions.values()].find(
      (session) => !session.remote && !session.explicitRemote,
    );
    if (!unboundSession) {
      return undefined;
    }

    unboundSession.remote = { address, port };
    const remoteKey = this.toRemoteKey(unboundSession.remote);
    this.remoteKeyToCallId.set(remoteKey, unboundSession.callId);
    this.logger.log(
      `RTP remote bound for call=${unboundSession.callId} remote=${address}:${port}`,
    );

    return unboundSession.callId;
  }

  private buildRtpPacket(session: RtpSession, payload: Buffer) {
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = 0x00;

    header.writeUInt16BE(session.txSequence, 2);
    header.writeUInt32BE(session.txTimestamp, 4);
    header.writeUInt32BE(session.ssrc, 8);

    session.txSequence = (session.txSequence + 1) & 0xffff;
    session.txTimestamp = (session.txTimestamp + payload.length) >>> 0;

    return Buffer.concat([header, payload]);
  }

  private toRemoteKey(remote: RemoteEndpoint) {
    return `${remote.address}:${remote.port}`;
  }

  private getBindHost() {
    return (
      this.configService.get<string>('ASTERISK_EXTERNAL_MEDIA_BIND_HOST') ||
      '0.0.0.0'
    );
  }

  private getBindPort() {
    const fromConfig = this.configService.get<string>(
      'ASTERISK_EXTERNAL_MEDIA_BIND_PORT',
    );
    if (fromConfig) {
      const parsed = Number(fromConfig);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }

    const externalHost =
      this.configService.get<string>('ASTERISK_EXTERNAL_MEDIA_HOST') ||
      '127.0.0.1:6000';
    const parts = externalHost.split(':');
    const parsed = Number(parts[parts.length - 1]);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
    return 6000;
  }
}
