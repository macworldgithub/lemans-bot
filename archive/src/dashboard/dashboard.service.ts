import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Lead, LeadDocument } from '../voice/schemas/lead.schema';

@Injectable()
export class DashboardService {
  constructor(
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
  ) {}

  async getStats() {
    const [total, byEventType, recent] = await Promise.all([
      this.leadModel.countDocuments(),
      this.leadModel.aggregate([
        { $group: { _id: '$eventType', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      this.leadModel
        .find()
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
    ]);

    return {
      totalLeads: total,
      byEventType,
      recentLeads: recent,
    };
  }

  async getLeads(page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const [leads, total] = await Promise.all([
      this.leadModel.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.leadModel.countDocuments(),
    ]);
    return { leads, total, page, limit };
  }
}