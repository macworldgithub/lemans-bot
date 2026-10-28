import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CustomerDocument = Customer & Document;

@Schema({ timestamps: true })
export class Customer {
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) phone: string;
  @Prop({ required: true }) address: string;
  @Prop({ required: true }) urgency: string;
  @Prop({ required: true }) serviceType: string;
  @Prop({ required: true }) problemDescription: string;
  @Prop({ required: true }) preferredTime: string;
  @Prop() summary: string;
}

export const CustomerSchema = SchemaFactory.createForClass(Customer);
