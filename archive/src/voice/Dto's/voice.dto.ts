import { ApiProperty } from '@nestjs/swagger';

export class VoiceDto {
  @ApiProperty({ example: 'Hello, how can I help you?', required: false })
  text?: string;

  @ApiProperty({ example: 'session-123', required: false })
  sessionId?: string;
}
