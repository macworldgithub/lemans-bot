import { Controller, Get, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('stats')
  getStats() {
    return this.dashboardService.getStats();
  }

  @Get('leads')
  getLeads(
    @Query('page') page = '1',
    @Query('limit') limit = '50',
  ) {
    return this.dashboardService.getLeads(Number(page), Number(limit));
  }
}