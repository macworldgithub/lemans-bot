import { Controller, Post, Body, Get, Patch, Delete, Param, Res, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { PbxService } from './pbx.service';

@Controller('pbx')
export class PbxController {
  constructor(private readonly pbxService: PbxService) {}

  /**
   * Webhook endpoint for incoming calls from PBX
   * Must respond quickly (<2 seconds)
   */
  @Post('incoming-call')
  async incomingCall(@Body() callData: {
    caller_number: string;
    called_number: string;
    call_id: string;
  }, @Res() res: Response) {
    try {
      // Process the call asynchronously
      this.pbxService.handleIncomingCall(callData).catch(error => {
        console.error('Async call handling failed:', error);
      });

      // Respond immediately to PBX
      res.status(HttpStatus.OK).json({ 
        success: true, 
        message: 'Call received and processing' 
      });

    } catch (error) {
      console.error('Webhook error:', error);
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ 
        success: false, 
        error: 'Internal server error' 
      });
    }
  }

  /**
   * Test PBX connection
   */
  @Get('test')
  async testConnection() {
    return this.pbxService.testConnection();
  }

  /**
   * List available DIDs
   */
  @Get('dids')
  async listDIDs() {
    return this.pbxService.listDIDs();
  }

  /**
   * Create new DID number
   */
  @Post('dids')
  async createDID(@Body() didData: {
    did_number: string;
    provider?: string;
    region?: string;
    type?: string;
  }) {
    return this.pbxService.createDID(didData);
  }

  /**
   * Assign DID to tradie
   */
  @Post('dids/assign')
  async assignDID(@Body() data: {
    did_number: string;
    tradie_id: string;
  }) {
    return this.pbxService.assignDID(data.did_number, data.tradie_id);
  }

  /**
   * Update DID settings
   */
  @Patch('dids/:didNumber')
  async updateDID(
    @Param('didNumber') didNumber: string,
    @Body() settings: any,
  ) {
    return this.pbxService.updateDID(didNumber, settings);
  }

  /**
   * Delete DID
   */
  @Delete('dids/:didNumber')
  async deleteDID(@Param('didNumber') didNumber: string) {
    return this.pbxService.deleteDID(didNumber);
  }

  /**
   * Get call status
   */
  @Post('call-status')
  async getCallStatus(@Body() body: { call_id: string }) {
    return this.pbxService.getCallStatus(body.call_id);
  }
}
