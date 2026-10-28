import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AriController } from './ari.controller';
import { AriService } from './ari.service';
import { AriRtpMediaService } from './ari-rtp-media.service';
import { AriWebSocketGateway } from './ari-websocket.gateway';
import { VoiceModule } from '../voice/voice.module';

@Module({
  imports: [ConfigModule, VoiceModule],
  controllers: [AriController],
  providers: [AriService, AriRtpMediaService, AriWebSocketGateway],
  exports: [AriService, AriRtpMediaService, AriWebSocketGateway],
})
export class AriModule {}
