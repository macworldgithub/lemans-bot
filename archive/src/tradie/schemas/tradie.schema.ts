import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TradieDocument = Tradie & Document;

export enum Availability {
  AVAILABLE = 'AVAILABLE',
  BUSY = 'BUSY',
  OFFLINE = 'OFFLINE',
}

@Schema({ timestamps: true })
export class Tradie {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true, unique: true })
  geo_number: string;

  @Prop({ required: true })
  mobile_number: string;

  @Prop()
  ai_endpoint: string;

  @Prop()
  working_hours: string;

  @Prop({ enum: Availability, default: Availability.AVAILABLE })
  availability: Availability;

  @Prop({ default: true })
  is_active: boolean;

  @Prop()
  company_name: string;

  @Prop()
  trade: string;
}

export const TradieSchema = SchemaFactory.createForClass(Tradie);
