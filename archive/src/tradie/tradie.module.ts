import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TradieService } from './tradie.service';
import { TradieController } from './tradie.controller';
import { Tradie, TradieSchema } from './schemas/tradie.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Tradie.name, schema: TradieSchema }]),
  ],
  controllers: [TradieController],
  providers: [TradieService],
  exports: [TradieService],
})
export class TradieModule {}
