import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type LeadDocument = Lead & Document;

@Schema({ timestamps: true })
export class Lead {
  @Prop({ required: true })
  callerName: string;

  @Prop()
  callerNumber: string;

  @Prop({
    required: true,
    enum: ['kids_party', 'buck_party', 'corporate', 'general_enquiry', 'unknown'],
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
}

export const LeadSchema = SchemaFactory.createForClass(Lead);