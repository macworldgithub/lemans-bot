import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { VoiceModule } from './voice/voice.module';
import { AuthModule } from './auth/auth.module';
import { TradieModule } from './tradie/tradie.module';
import { LeadModule } from './lead/lead.module';
import { PbxModule } from './pbx/pbx.module';
import { VoiceAgentModule } from './voice-agent/voice-agent.module';
import { AriModule } from './ari/ari.module';
import { Customer, CustomerSchema } from './voice/Schema/customer.schema';
import { DashboardModule } from './dashboard/dashboard.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('MONGO_URI'),
      }),
    }),
    MongooseModule.forFeature([
      {
        name: Customer.name,
        schema: CustomerSchema,
      },
    ]),
    VoiceModule,
    AuthModule,
    TradieModule,
    LeadModule,
    PbxModule,
    VoiceAgentModule,
    AriModule,
    DashboardModule,
  ],
})
export class AppModule {}
