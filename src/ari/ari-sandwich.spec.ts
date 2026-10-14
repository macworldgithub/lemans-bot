import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { AriService } from './ari.service';
import { AriRtpMediaService } from './ari-rtp-media.service';
import { AriWebSocketGateway } from './ari-websocket.gateway';
import { VoiceService } from '../voice/voice.service';

describe('Asterisk Sandwich adapter', () => {
  let service: AriService;
  let api: any;
  let ready: () => void;
  let event: (event: any) => void;
  let voice: any;
  let rtp: any;
  let media: any;
  beforeEach(() => {
    jest.spyOn(axios, 'create').mockReturnValue({
      request: jest.fn(async (request) => ({
        data: request.params?.variable
          ? {
              value: request.params.variable.endsWith('ADDRESS')
                ? '127.0.0.1'
                : '18000',
            }
          : { id: 'extmedia-phone' },
      })),
    } as unknown as AxiosInstance);
    voice = {
      isSandwichEnabled: () => true,
      getSystemPrompt: () => 'Chloe',
      startExternalSession: jest.fn(),
      finalizeExternalSession: jest.fn().mockResolvedValue(undefined),
      createPhonePipeline: jest.fn((_id, callback) => {
        event = callback;
        return new Promise<void>((resolve) => {
          ready = resolve;
        });
      }),
      closePhonePipeline: jest.fn().mockResolvedValue(undefined),
      sendPhoneAudio: jest.fn(),
      speakPhone: jest.fn(),
    };
    rtp = {
      registerCallSession: jest.fn(),
      unregisterCallSession: jest.fn(),
      setRemoteEndpoint: jest.fn(),
      sendUlawToCall: jest.fn(),
      flushQueue: jest.fn(),
      isOutputQueueDrained: () => true,
    };
    media = {
      flushCallAudio: jest.fn(),
      sendAudioToCall: jest.fn(),
      closeCallConnection: jest.fn(),
    };
    service = new AriService(
      { get: () => undefined } as unknown as ConfigService,
      rtp as AriRtpMediaService,
      media as AriWebSocketGateway,
      voice as VoiceService,
    );
    api = service;
  });
  afterEach(async () => {
    ready?.();
    await service.onModuleDestroy();
    jest.restoreAllMocks();
  });
  async function settle() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  it('keeps existing ARI endpoint binding and buffers caller speech until both pipeline and bridge are ready', async () => {
    await api.handleStasisStart({
      channel: { id: 'phone', caller: { number: '1234' } },
    });
    expect(voice.startExternalSession).toHaveBeenCalledWith('phone', '1234');
    expect(rtp.setRemoteEndpoint).toHaveBeenCalledWith(
      'phone',
      '127.0.0.1',
      18000,
    );
    api.handleInboundRtpFrame('phone', Buffer.alloc(160, 0xff));
    expect(voice.sendPhoneAudio).not.toHaveBeenCalled();
    expect(voice.speakPhone).not.toHaveBeenCalled();
    ready();
    await settle();
    expect(voice.sendPhoneAudio).toHaveBeenCalledWith(
      'phone',
      Buffer.alloc(160, 0xff),
    );
    expect(voice.speakPhone).toHaveBeenCalledTimes(1);
    api.activatePhoneAudio('phone');
    expect(voice.speakPhone).toHaveBeenCalledTimes(1);
  });
  it('routes µ-law output directly to RTP and clears queued output on barge-in', async () => {
    await api.handleStasisStart({ channel: { id: 'phone' } });
    ready();
    await settle();
    event({ type: 'audio-delta', delta: '////' });
    expect(rtp.sendUlawToCall).toHaveBeenCalledWith(
      'phone',
      Buffer.from('////', 'base64'),
    );
    event({ type: 'speech-started' });
    expect(rtp.flushQueue).toHaveBeenCalledWith('phone');
  });
  it('flushes the optional WebSocket media path and uses valid G.711 silence conversion', async () => {
    await api.handleStasisStart({ channel: { id: 'phone' } });
    ready();
    await settle();
    await api.processWebSocketAudio('phone', Buffer.alloc(320));
    expect(voice.sendPhoneAudio).toHaveBeenCalledWith(
      'phone',
      Buffer.alloc(160, 0xff),
    );
    event({
      type: 'audio-delta',
      delta: Buffer.alloc(160, 0xff).toString('base64'),
    });
    expect(media.sendAudioToCall).toHaveBeenCalledWith(
      'phone',
      Buffer.alloc(320),
    );
    event({ type: 'speech-started' });
    expect(media.flushCallAudio).toHaveBeenCalledWith('phone');
  });
  it('drains the phone pipeline before finalizing the existing lead and ignores late audio after hangup', async () => {
    await api.handleStasisStart({ channel: { id: 'phone' } });
    ready();
    await settle();
    await api.handleChannelCleanup({ channel: { id: 'phone' } });
    expect(voice.closePhonePipeline.mock.invocationCallOrder[0]).toBeLessThan(
      voice.finalizeExternalSession.mock.invocationCallOrder[0],
    );
    event({ type: 'audio-delta', delta: '////' });
    expect(rtp.sendUlawToCall).not.toHaveBeenCalled();
  });
});
