import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { VoiceService } from './voice.service';
import { Lead } from './schemas/lead.schema';
import { ActiveCampaignService } from '../integrations/active-campaign.service';
import { LiveTranscriptGateway } from './live-transcript.gateway';
import { SpeakerVerifierService } from './speaker-lock/speaker-verifier.service';

describe('VoiceService', () => {
  let service: VoiceService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoiceService,
        LiveTranscriptGateway,
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: getModelToken(Lead.name), useValue: {} },
        { provide: ActiveCampaignService, useValue: {} },
        {
          provide: SpeakerVerifierService,
          useValue: { enabled: false, ready: false },
        },
      ],
    }).compile();

    service = module.get<VoiceService>(VoiceService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

describe('LiveTranscriptGateway', () => {
  let gateway: LiveTranscriptGateway;
  let emitted: Array<[string, any]>;

  beforeEach(() => {
    gateway = new LiveTranscriptGateway({
      get: () => undefined,
    } as unknown as ConfigService);
    emitted = [];
    gateway.server = {
      emit: (name: string, payload: any) => emitted.push([name, payload]),
    } as any;
  });

  it('builds caller and bot lines in conversation order from streamed events', () => {
    gateway.callStarted('c1', 'web');
    gateway.publish({ callId: 'c1', role: 'bot', id: 'b1', kind: 'delta', text: 'Hi, ' });
    gateway.publish({ callId: 'c1', role: 'bot', id: 'b1', kind: 'final', text: 'Hi, Chloe here.' });
    gateway.publish({ callId: 'c1', role: 'user', id: 'u1', kind: 'start' });
    gateway.publish({ callId: 'c1', role: 'bot', id: 'b2', kind: 'delta', text: 'Sure' });
    gateway.publish({ callId: 'c1', role: 'user', id: 'u1', kind: 'delta', text: 'Book a ' });
    gateway.publish({ callId: 'c1', role: 'user', id: 'u1', kind: 'delta', text: 'party' });

    const client = { emit: jest.fn() };
    gateway.handleConnection(client as any);
    const [, snapshot] = client.emit.mock.calls[0];
    const lines = snapshot.calls[0].lines;

    expect(lines.map((l: any) => `${l.role}:${l.text}`)).toEqual([
      'bot:Hi, Chloe here.',
      'user:Book a party',
      'bot:Sure',
    ]);
    expect(lines[0].final).toBe(true);
    expect(lines[1].final).toBe(false);
    expect(emitted.filter(([n]) => n === 'transcript')).toHaveLength(6);
  });

  it('defaults transcription to gpt-live-transcribe with a vocabulary prompt', () => {
    const cfg = gateway.getInputTranscriptionConfig();
    expect(cfg.model).toBe('gpt-live-transcribe');
    expect(cfg.prompt).toContain('Le Mans');
    expect(cfg.language).toBeUndefined();
  });
});
