import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UserDocument = User & Document;

export enum GeoNumberType {
  NEW = 'NEW',
  PORTING = 'PORTING',
  NONE = 'NONE',
}

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true })
  customerName: string;

  @Prop({ required: true })
  companyName: string;

  @Prop()
  acn: string;

  @Prop({ required: true, unique: true, lowercase: true })
  email: string;

  @Prop({ required: true })
  password: string;

  @Prop({ required: true })
  trade: string;

  @Prop({ required: true })
  mobileNumber: string;

  @Prop({ default: false })
  wantsGeoNumber: boolean;

  @Prop({ enum: GeoNumberType, default: GeoNumberType.NONE })
  geoNumberType: GeoNumberType;

  @Prop()
  portingNumber: string;

  @Prop()
  openingHours: string;

  @Prop({ type: Object })
  paymentDetails: any;

  @Prop({ default: false })
  emailVerified: boolean;

  @Prop()
  emailVerificationToken?: string;

  @Prop()
  resetPasswordToken?: string;

  @Prop()
  resetPasswordExpiry?: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);
