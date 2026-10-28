import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VoiceGateway } from './voice.gateway';
import { VoiceService } from './voice.service';
import { VoiceController } from './voice.controller';
import { Lead, LeadSchema } from './schemas/lead.schema';
import { ActiveCampaignService } from '../integrations/active-campaign.service';
import { LiveTranscriptGateway } from './live-transcript.gateway';
import { SpeakerVerifierService } from './speaker-lock/speaker-verifier.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Lead.name, schema: LeadSchema }]),
  ],
  providers: [
    VoiceGateway,
    VoiceService,
    ActiveCampaignService,
    LiveTranscriptGateway,
    SpeakerVerifierService,
  ],
  controllers: [VoiceController],
  exports: [VoiceService, LiveTranscriptGateway, SpeakerVerifierService],
})
export class VoiceModule {}