import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VoiceGateway } from './voice.gateway';
import { VoiceService } from './voice.service';
import { VoiceController } from './voice.controller';
import { LeadSchema, VOICE_LEAD_MODEL } from './schemas/lead.schema';
import { LeadCaptureService } from './lead-capture.service';
import { ActiveCampaignService } from '../integrations/active-campaign.service';
import { SandwichService } from './sandwich.service';
import { CrmDeliveryService } from '../integrations/crm-delivery.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: VOICE_LEAD_MODEL, schema: LeadSchema }]),
  ],
  providers: [
    VoiceGateway,
    VoiceService,
    LeadCaptureService,
    ActiveCampaignService,
    CrmDeliveryService,
    SandwichService,
  ],
  controllers: [VoiceController],
  exports: [VoiceService],
})
export class VoiceModule {}
