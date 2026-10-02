import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { VoiceService } from './voice.service';
import { Lead } from './schemas/lead.schema';
import { ActiveCampaignService } from '../integrations/active-campaign.service';

describe('VoiceService', () => {
  let service: VoiceService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoiceService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'OPENAI_API_KEY') return 'test-key';
              return null;
            }),
          },
        },
        {
          provide: getModelToken(Lead.name),
          useValue: {
            create: jest.fn(),
            find: jest.fn(),
          },
        },
        {
          provide: ActiveCampaignService,
          useValue: {
            createContact: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<VoiceService>(VoiceService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

