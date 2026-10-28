import { Module } from '@nestjs/common';
import { VoiceAgentController } from './voice-agent.controller';
import { VoiceAgentService } from './voice-agent.service';
import { TradieModule } from '../tradie/tradie.module';
import { LeadModule } from '../lead/lead.module';

@Module({
  imports: [TradieModule, LeadModule],
  controllers: [VoiceAgentController],
  providers: [VoiceAgentService],
  exports: [VoiceAgentService],
})
export class VoiceAgentModule {}
