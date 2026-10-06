import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type LeadDocument = Lead & Document;
// Keep the existing collection while avoiding the unrelated tradie Lead model.
export const VOICE_LEAD_MODEL = 'VoiceLead';

@Schema({ timestamps: true, collection: 'leads', bufferCommands: false })
export class Lead {
  @Prop({ type: String, default: null })
  callerName: string | null;

  @Prop()
  callerNumber: string;

  @Prop()
  callerEmail?: string;

  @Prop({
    required: true,
    enum: [
      'kids_party',
      'teen_party',
      'buck_party',
      'corporate',
      'adult_party',
      'karts',
      'vr',
      'activities',
      'booking_change',
      'complaint',
      'after_hours',
      'school_group',
      'emergency',
      'general_enquiry',
      'unknown',
    ],
  })
  eventType: string;

  @Prop()
  eventDate: string;

  @Prop()
  groupSize: number;

  @Prop({ required: true })
  enquiryDetails: string;

  @Prop({ required: true })
  callId: string;

  @Prop({ default: 'voice_agent' })
  source: string;

  @Prop({ default: 'new' })
  status: string;

  @Prop()
  activeCampaignContactId: string;

  @Prop({ type: String, default: 'LeMans Inquiries' })
  assignedTo: string;

  @Prop({ enum: ['partial', 'complete'], default: 'partial' })
  captureStatus: string;

  @Prop({ enum: ['pending', 'complete', 'failed'], default: 'pending' })
  extractionStatus: string;

  @Prop({ type: String })
  preferredLanguage: string;

  @Prop({ default: '' })
  callerTranscript: string;

  @Prop({
    type: [
      {
        _id: false,
        role: String,
        text: String,
        startMs: Number,
        endMs: Number,
      },
    ],
    default: [],
  })
  conversation: {
    role: string;
    text: string;
    startMs: number;
    endMs: number;
  }[];

  @Prop({ type: Date })
  startedAt: Date;

  @Prop({ type: Date, default: null })
  endedAt: Date | null;
}

export const LeadSchema = SchemaFactory.createForClass(Lead);
