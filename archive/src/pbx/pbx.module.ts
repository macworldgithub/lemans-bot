import { Module } from '@nestjs/common';
import { PbxService } from './pbx.service';
import { PbxController } from './pbx.controller';
import { TradieModule } from '../tradie/tradie.module';

@Module({
  imports: [TradieModule],
  controllers: [PbxController],
  providers: [PbxService],
  exports: [PbxService],
})
export class PbxModule {}
