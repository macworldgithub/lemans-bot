import { Controller, Get, Post, Body, Param, Patch } from '@nestjs/common';
import { TradieService } from './tradie.service';
import { Tradie } from './schemas/tradie.schema';
import { Availability } from './schemas/tradie.schema';

@Controller('tradies')
export class TradieController {
  constructor(private readonly tradieService: TradieService) {}

  @Post()
  create(@Body() createTradieDto: any) {
    return this.tradieService.create(createTradieDto);
  }

  @Get()
  findAll() {
    return this.tradieService.findAll();
  }

  @Get('geo/:geoNumber')
  findByGeoNumber(@Param('geoNumber') geoNumber: string) {
    return this.tradieService.findByGeoNumber(geoNumber);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.tradieService.findById(id);
  }

  @Patch(':id/availability')
  updateAvailability(
    @Param('id') id: string,
    @Body('availability') availability: Availability,
  ) {
    return this.tradieService.updateAvailability(id, availability);
  }
}
