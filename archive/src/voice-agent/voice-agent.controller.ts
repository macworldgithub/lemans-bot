import { Controller, Post, Body, Get, Param } from '@nestjs/common';
import { VoiceAgentService } from './voice-agent.service';

@Controller('voice-agent')
export class VoiceAgentController {
  constructor(private readonly voiceAgentService: VoiceAgentService) {}

  /**
   * AI endpoint route for voice agent integration
   * This is where PBX redirects calls when tradie doesn't answer
   */
  @Post('incoming-call')
  async handleIncomingCall(@Body() callData: {
    call_id: string;
    caller_number: string;
    called_number: string;
  }) {
    return this.voiceAgentService.handleIncomingCall(callData);
  }

  /**
   * Endpoint for AI agent to send collected data back to backend
   */
  @Post('lead-data')
  async submitLeadData(@Body() leadData: {
    call_id: string;
    tradie_id: string;
    caller_number: string;
    issue: string;
    address: string;
    additional_info?: string;
    ai_transcript?: string;
  }) {
    return this.voiceAgentService.submitLeadData(leadData);
  }

  /**
   * Get tradie info for AI agent personalization
   */
  @Get('tradie/:tradieId')
  async getTradieInfo(@Param('tradieId') tradieId: string) {
    return this.voiceAgentService.getTradieInfo(tradieId);
  }

  /**
   * Health check for AI agent
   */
  @Get('health')
  async healthCheck() {
    return { status: 'healthy', timestamp: new Date().toISOString() };
  }
}