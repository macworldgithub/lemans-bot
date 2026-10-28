import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import dgram, { RemoteInfo, Socket } from 'dgram';

type RemoteEndpoint = {
  address: string;
  port: number;
};

type RtpSession = {
  callId: string;
  remote?: RemoteEndpoint;
  packetsRx: number;
  bytesRx: number;
  lastPacketAt?: string;
  txSequence: number;
  txTimestamp: number;
  ssrc: number;
  txQueue?: Buffer;
  txDrainTimer?: ReturnType<typeof setInterval> | null;
};

type AudioFrameHandler = (frame: {
  callId: string;
  payload: Buffer;
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

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.startSocket();
  }

  onModuleDestroy() {
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

  registerCallSession(callId: string) {
    if (this.sessions.has(callId)) {
      return;
    }

    this.sessions.set(callId, {
      callId,
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
      clearInterval(session.txDrainTimer);
      session.txDrainTimer = null;
    }
    session.txQueue = undefined;

    if (session.remote) {
      this.remoteKeyToCallId.delete(this.toRemoteKey(session.remote));
    }

    this.sessions.delete(callId);
    this.logger.log(`RTP session unregistered for call=${callId}`);
  }

  sendUlawToCall(callId: string, ulawPayload: Buffer) {
    const session = this.sessions.get(callId);
    if (!session || !session.remote || !this.socket) {
      return;
    }

    // Append to the session's output queue; the drain timer sends at steady 20ms pace
    if (!session.txQueue) {
      session.txQueue = Buffer.alloc(0);
    }
    session.txQueue = Buffer.concat([session.txQueue, ulawPayload]);

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
  }

  private startDrainTimer(session: RtpSession) {
    const PACKET_SIZE = 160; // 20ms at 8kHz µ-law
    const PTIME_MS = 20;

    session.txDrainTimer = setInterval(() => {
      if (!session.txQueue || session.txQueue.length === 0) {
        // Nothing left to send — stop the timer
        if (session.txDrainTimer) {
          clearInterval(session.txDrainTimer);
          session.txDrainTimer = null;
        }
        return;
      }

      if (!session.remote || !this.socket) {
        return;
      }

      // Take one 160-byte packet from the front of the queue
      const chunk = session.txQueue.subarray(0, PACKET_SIZE);
      session.txQueue = session.txQueue.subarray(chunk.length);

      const rtpPacket = this.buildRtpPacket(session, chunk);
      this.socket.send(rtpPacket, session.remote.port, session.remote.address);
    }, PTIME_MS);
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

  private handleIncomingPacket(packet: Buffer, remote: RemoteInfo) {
    if (packet.length < 12) {
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
        sequenceNumber,
        timestamp,
        marker,
        payloadType,
      });
    }
  }

  private bindRemoteToPendingSession(
    address: string,
    port: number,
  ): string | undefined {
    const unboundSession = [...this.sessions.values()].find(
      (session) => !session.remote,
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
