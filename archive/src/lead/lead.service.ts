import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Lead, LeadDocument } from './schemas/lead.schema';

@Injectable()
export class LeadService {
  constructor(
    @InjectModel(Lead.name) private leadModel: Model<LeadDocument>,
  ) {}

  async create(createLeadDto: any): Promise<Lead> {
    const lead = new this.leadModel(createLeadDto);
    return lead.save();
  }

  async findById(id: string): Promise<Lead | null> {
    return this.leadModel.findById(id).exec();
  }

  async findByTradieId(tradie_id: string): Promise<Lead[]> {
    return this.leadModel.find({ tradie_id }).sort({ createdAt: -1 }).exec();
  }

  async findByCallId(call_id: string): Promise<Lead | null> {
    return this.leadModel.findOne({ call_id }).exec();
  }

  async updateStatus(id: string, status: string): Promise<Lead | null> {
    return this.leadModel.findByIdAndUpdate(
      id,
      { status },
      { new: true }
    ).exec();
  }

  async markAsNotified(id: string): Promise<Lead | null> {
    return this.leadModel.findByIdAndUpdate(
      id,
      { tradie_notified: true },
      { new: true }
    ).exec();
  }

  async findPendingLeads(): Promise<Lead[]> {
    return this.leadModel.find({ 
      status: 'PENDING',
      tradie_notified: false 
    }).exec();
  }

  async createFromAIData(aiData: {
    tradie_id: string;
    caller_number: string;
    issue: string;
    address: string;
    call_id: string;
    additional_info?: string;
    ai_transcript?: string;
  }): Promise<Lead> {
    return this.create({
      ...aiData,
      status: 'PENDING',
      tradie_notified: false,
    });
  }
}
