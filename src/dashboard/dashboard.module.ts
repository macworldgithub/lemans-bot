// ─── dashboard.module.ts ──────────────────────────────────────────────────────
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { LeadSchema, VOICE_LEAD_MODEL } from '../voice/schemas/lead.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: VOICE_LEAD_MODEL, schema: LeadSchema }]),
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
