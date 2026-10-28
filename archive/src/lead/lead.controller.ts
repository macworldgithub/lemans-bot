import { Controller, Get, Post, Body, Param, Patch } from '@nestjs/common';
import { LeadService } from './lead.service';
import { Lead } from './schemas/lead.schema';

@Controller('leads')
export class LeadController {
  constructor(private readonly leadService: LeadService) {}

  @Post()
  create(@Body() createLeadDto: any) {
    return this.leadService.create(createLeadDto);
  }

  @Post('from-ai')
  createFromAI(@Body() aiData: any) {
    return this.leadService.createFromAIData(aiData);
  }

  @Get()
  findAll() {
    return this.leadService.findPendingLeads();
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.leadService.findById(id);
  }

  @Get('tradie/:tradieId')
  findByTradieId(@Param('tradieId') tradieId: string) {
    return this.leadService.findByTradieId(tradieId);
  }

  @Get('call/:callId')
  findByCallId(@Param('callId') callId: string) {
    return this.leadService.findByCallId(callId);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body('status') status: string,
  ) {
    return this.leadService.updateStatus(id, status);
  }

  @Patch(':id/notify')
  markAsNotified(@Param('id') id: string) {
    return this.leadService.markAsNotified(id);
  }
}
