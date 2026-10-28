import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { TradieService } from '../tradie/tradie.service';

export interface PbxResponse {
  success: boolean;
  data?: any;
  error?: string;
}

export interface CallStatusResponse {
  answered: boolean;
  status: string;
  duration?: number;
}

@Injectable()
export class PbxService {
  private readonly logger = new Logger(PbxService.name);
  private readonly pbxClient: AxiosInstance;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly server: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly tradieService: TradieService,
  ) {
    const apiKey = this.configService.get<string>('PBX_API_KEY');
    const baseUrl = this.configService.get<string>('PBX_BASE_URL');
    const server = this.configService.get<string>('PBX_SERVER') ?? '440';

    if (!apiKey || !baseUrl) {
      throw new Error('PBX_API_KEY and PBX_BASE_URL must be configured');
    }

    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.server = server;

    this.pbxClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
    });
  }

  async handleIncomingCall(callData: {
    caller_number: string;
    called_number: string;
    call_id: string;
  }) {
    this.logger.log(
      `Handling incoming call: ${callData.call_id} from ${callData.caller_number} to ${callData.called_number}`,
    );

    try {
      const tradie = await this.tradieService.findByGeoNumber(callData.called_number);
      if (!tradie) {
        this.logger.error(`No tradie found for geo number: ${callData.called_number}`);
        return { success: false, error: 'No tradie found' };
      }

      const tradieId = (tradie as any)._id.toString();
      const isAvailable = await this.tradieService.isAvailable(tradieId);
      if (!isAvailable) {
        this.logger.log(`Tradie ${tradieId} is not available, redirecting to AI`);
        return this.redirectIncomingCallToAI(callData.call_id, tradie.ai_endpoint);
      }

      const dialResult = await this.dialTradie(tradie.mobile_number, callData.call_id);
      if (!dialResult.success) {
        this.logger.error(`Failed to dial tradie: ${dialResult.error}`);
        return this.redirectIncomingCallToAI(callData.call_id, tradie.ai_endpoint);
      }

      const answerResult = await this.waitForTradieAnswer(callData.call_id, 6000);
      if (answerResult.answered) {
        this.logger.log(`Tradie answered call ${callData.call_id}`);
        return { success: true, action: 'connected_to_tradie' };
      }

      this.logger.log(`Tradie did not answer within timeout, redirecting to AI`);
      return this.redirectIncomingCallToAI(callData.call_id, tradie.ai_endpoint);
    } catch (error) {
      this.logger.error(`Error handling incoming call: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  private async waitForTradieAnswer(
    callId: string,
    timeoutMs: number,
  ): Promise<{ answered: boolean }> {
    return new Promise((resolve) => {
      let checkCount = 0;
      const maxChecks = Math.floor(timeoutMs / 1000);

      const checkInterval = setInterval(async () => {
        checkCount += 1;

        try {
          const status = await this.getCallStatus(callId);

          if (status.answered) {
            clearInterval(checkInterval);
            resolve({ answered: true });
            return;
          }

          if (checkCount >= maxChecks) {
            clearInterval(checkInterval);
            resolve({ answered: false });
            return;
          }
        } catch (error) {
          this.logger.error(`Error checking call status: ${error.message}`);
          clearInterval(checkInterval);
          resolve({ answered: false });
        }
      }, 1000);
    });
  }

  private async redirectIncomingCallToAI(callId: string, tradieAiEndpoint?: string) {
    try {
      const aiEndpoint = tradieAiEndpoint || this.configService.get<string>('AI_ENDPOINT');

      if (!aiEndpoint) {
        throw new Error('No AI endpoint configured');
      }

      this.logger.log(`Redirecting call ${callId} to AI endpoint: ${aiEndpoint}`);

      const redirectResult = await this.redirectToAIEndpoint(callId, aiEndpoint);
      if (!redirectResult.success) {
        throw new Error(redirectResult.error);
      }

      return { success: true, action: 'redirected_to_ai', ai_endpoint: aiEndpoint };
    } catch (error) {
      this.logger.error(`Error redirecting to AI: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  private async redirectToAIEndpoint(
    callId: string,
    aiEndpoint: string,
  ): Promise<PbxResponse> {
    return this.pbxRequest('pbxware.call.redirect', {
      call_id: callId,
      destination: aiEndpoint,
    });
  }

  private async pbxRequest(
    action: string,
    params: any = {},
  ): Promise<PbxResponse> {
    try {
      this.logger.log(
        `PBX Request: action=${action}, params=${JSON.stringify(params)}`,
      );

      const queryParams = {
        apikey: this.apiKey,
        action,
        server: this.server,
        ...params,
      };

      const response = await this.pbxClient.get('', {
        params: queryParams,
      });

      this.logger.log(`PBX Response: ${JSON.stringify(response.data)}`);

      const data =
        typeof response.data === 'string'
          ? this.safeParseResponse(response.data)
          : response.data;

      // PBXware often returns JSON-like payloads for API calls, but the
      // client stays tolerant in case the transport returns text.
      if (data?.result === 'success') {
        return { success: true, data };
      } else {
        return { success: false, error: data?.message || 'Unknown PBX error' };
      }
    } catch (error) {
      this.logger.error(`PBX Request failed: ${error.message}`);
      return {
        success: false,
        error:
          error.response?.data?.message ||
          error.message ||
          'PBX request failed',
      };
    }
  }

  private safeParseResponse(responseText: string): any {
    try {
      return JSON.parse(responseText);
    } catch {
      return { raw: responseText };
    }
  }

  /**
   * Dial a tradie's mobile number
   * action: pbxware.call.originate
   */
  async dialTradie(destination: string, callId: string): Promise<PbxResponse> {
    return this.pbxRequest('pbxware.call.originate', {
      destination,
      call_id: callId,
    });
  }

  /**
   * Transfer a call to another destination
   * action: pbxware.call.transfer
   */
  async transferCall(
    callId: string,
    destination: string,
  ): Promise<PbxResponse> {
    return this.pbxRequest('pbxware.call.transfer', {
      call_id: callId,
      destination,
    });
  }

  /**
   * Redirect call to AI endpoint
   * action: pbxware.call.redirect
   */
  async redirectToAI(callId: string, aiEndpoint: string): Promise<PbxResponse> {
    return this.redirectToAIEndpoint(callId, aiEndpoint);
  }

  /**
   * Get call status
   * action: pbxware.call.status
   */
  async getCallStatus(callId: string): Promise<CallStatusResponse> {
    const response = await this.pbxRequest('pbxware.call.status', {
      call_id: callId,
    });

    if (response.success && response.data) {
      return {
        answered: response.data.answered || false,
        status: response.data.status || 'unknown',
        duration: response.data.duration,
      };
    }

    return {
      answered: false,
      status: 'error',
    };
  }

  /**
   * List available DIDs
   * action: pbxware.did.list
   */
  async listDIDs(): Promise<PbxResponse> {
    return this.pbxRequest('pbxware.did.list');
  }

  /**
   * Create new DID number (geographic number)
   * action: pbxware.did.create
   */
  async createDID(didData: {
    did_number: string;
    provider?: string;
    region?: string;
    type?: string;
  }): Promise<PbxResponse> {
    return this.pbxRequest('pbxware.did.create', didData);
  }

  /**
   * Assign DID to tradie/customer
   * action: pbxware.did.assign
   */
  async assignDID(didNumber: string, tradieId: string): Promise<PbxResponse> {
    return this.pbxRequest('pbxware.did.assign', {
      did_number: didNumber,
      customer_id: tradieId,
    });
  }

  /**
   * Update DID settings
   * action: pbxware.did.update
   */
  async updateDID(didNumber: string, settings: any): Promise<PbxResponse> {
    return this.pbxRequest('pbxware.did.update', {
      did_number: didNumber,
      ...settings,
    });
  }

  /**
   * Delete/remove DID
   * action: pbxware.did.delete
   */
  async deleteDID(didNumber: string): Promise<PbxResponse> {
    return this.pbxRequest('pbxware.did.delete', {
      did_number: didNumber,
    });
  }

  /**
   * Hang up a call
   * action: pbxware.call.hangup
   */
  async hangupCall(callId: string): Promise<PbxResponse> {
    return this.pbxRequest('pbxware.call.hangup', {
      call_id: callId,
    });
  }

  /**
   * Start call recording
   * action: pbxware.call.record.start
   */
  async startRecording(callId: string): Promise<PbxResponse> {
    return this.pbxRequest('pbxware.call.record.start', {
      call_id: callId,
    });
  }

  /**
   * Stop call recording
   * action: pbxware.call.record.stop
   */
  async stopRecording(callId: string): Promise<PbxResponse> {
    return this.pbxRequest('pbxware.call.record.stop', {
      call_id: callId,
    });
  }

  /**
   * Test PBX connection
   */
  async testConnection(): Promise<PbxResponse> {
    return this.pbxRequest('pbxware.system.status');
  }
}
