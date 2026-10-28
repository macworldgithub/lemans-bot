import { Controller, Get } from '@nestjs/common';

@Controller('voice')
export class VoiceController {
  // Voice agent operates entirely via WebSocket (Socket.IO gateway).
  // This controller exposes only a health check for ops/monitoring.

  @Get('health')
  health() {
    return { status: 'healthy', timestamp: new Date().toISOString() };
  }
}