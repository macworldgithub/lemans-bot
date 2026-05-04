import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VoiceGateway } from './voice.gateway';
import { VoiceService } from './voice.service';
import { VoiceController } from './voice.controller';
import { Lead, LeadSchema } from './schemas/lead.schema';
import { ActiveCampaignService } from '../integrations/active-campaign.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Lead.name, schema: LeadSchema }]),
  ],
  providers: [VoiceGateway, VoiceService, ActiveCampaignService],
  controllers: [VoiceController],
  exports: [VoiceService],
})
export class VoiceModule {}