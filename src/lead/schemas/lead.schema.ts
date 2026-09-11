// import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
// import { Document, Types } from 'mongoose';

// export type LeadDocument = Lead & Document;

// @Schema({ timestamps: true })
// export class Lead {
//   @Prop({ required: true, type: Types.ObjectId, ref: 'Tradie' })
//   tradie_id: Types.ObjectId;

//   @Prop({ required: true })
//   caller_number: string;

//   @Prop({ required: true })
//   issue: string;

//   @Prop({ required: true })
//   address: string;

//   @Prop()
//   additional_info: string;

//   @Prop({ required: true })
//   call_id: string;

//   @Prop({ enum: ['PENDING', 'CONTACTED', 'CONVERTED', 'LOST'], default: 'PENDING' })
//   status: string;

//   @Prop()
//   ai_transcript: string;

//   @Prop({ default: false })
//   tradie_notified: boolean;

//   @Prop({ type: String, default: 'LeMans Inquiries' })
// assignedTo: string;
// }

// export const LeadSchema = SchemaFactory.createForClass(Lead);

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type LeadDocument = Lead & Document;

@Schema({ timestamps: true })
export class Lead {
  @Prop({ required: true, type: Types.ObjectId, ref: 'Tradie' })
  tradie_id: Types.ObjectId;

  @Prop({ required: true })
  caller_number: string;

  @Prop({ required: true })
  issue: string;

  @Prop({ required: true })
  address: string;

  @Prop()
  additional_info: string;

  @Prop({ required: true })
  call_id: string;

  @Prop({ enum: ['PENDING', 'CONTACTED', 'CONVERTED', 'LOST'], default: 'PENDING' })
  status: string;

  @Prop()
  ai_transcript: string;

  @Prop({ default: false })
  tradie_notified: boolean;

  @Prop({ type: String, default: 'LeMans Inquiries' })
assignedTo: string;
}

export const LeadSchema = SchemaFactory.createForClass(Lead);
