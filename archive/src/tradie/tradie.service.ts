import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Tradie, TradieDocument } from './schemas/tradie.schema';
import { Availability } from './schemas/tradie.schema';

@Injectable()
export class TradieService {
  constructor(
    @InjectModel(Tradie.name) private tradieModel: Model<TradieDocument>,
  ) {}

  async findByGeoNumber(geo_number: string): Promise<Tradie | null> {
    return this.tradieModel.findOne({ 
      geo_number, 
      is_active: true,
      availability: { $ne: Availability.OFFLINE }
    }).exec();
  }

  async findById(id: string): Promise<Tradie | null> {
    return this.tradieModel.findById(id).exec();
  }

  async create(createTradieDto: any): Promise<Tradie> {
    const tradie = new this.tradieModel(createTradieDto);
    return tradie.save();
  }

  async updateAvailability(id: string, availability: Availability): Promise<Tradie | null> {
    return this.tradieModel.findByIdAndUpdate(
      id, 
      { availability }, 
      { new: true }
    ).exec();
  }

  async findAll(): Promise<Tradie[]> {
    return this.tradieModel.find({ is_active: true }).exec();
  }

  async isAvailable(id: string): Promise<boolean> {
    const tradie = await this.findById(id);
    return tradie ? tradie.availability === Availability.AVAILABLE : false;
  }
}
