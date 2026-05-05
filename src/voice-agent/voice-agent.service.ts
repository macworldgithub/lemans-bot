import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TradieService } from '../tradie/tradie.service';
import { LeadService } from '../lead/lead.service';

@Injectable()
export class VoiceAgentService {
  private readonly logger = new Logger(VoiceAgentService.name);

  constructor(
    private readonly tradieService: TradieService,
    private readonly leadService: LeadService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Handle incoming call to AI agent
   * This endpoint is called when PBX redirects a call to the AI
   */
  async handleIncomingCall(callData: {
    call_id: string;
    caller_number: string;
    called_number: string;
  }) {
    this.logger.log(`AI Agent handling call: ${callData.call_id}`);

    try {
      // Find tradie by the called number
      const tradie = await this.tradieService.findByGeoNumber(callData.called_number);
      
      if (!tradie) {
        this.logger.error(`No tradie found for geo number: ${callData.called_number}`);
        return { 
          success: false, 
          error: 'No tradie found',
          fallback_message: 'Sorry, we could not connect you to the right service.'
        };
      }

      // Get AI endpoint (tradie-specific or global fallback)
      const aiEndpoint = tradie.ai_endpoint || this.configService.get<string>('AI_ENDPOINT');
      
      if (!aiEndpoint) {
        throw new Error('No AI endpoint configured');
      }

      // Return tradie info for AI personalization
      return {
        success: true,
        tradie_info: {
          id: (tradie as any)._id,
          name: tradie.name,
          company_name: tradie.company_name,
          trade: tradie.trade,
          working_hours: tradie.working_hours,
        },
        call_data: {
          call_id: callData.call_id,
          caller_number: callData.caller_number,
        },
        ai_endpoint: aiEndpoint,
        ai_instructions: this.generateAIInstructions(tradie),
      };

    } catch (error) {
      this.logger.error(`Error in AI call handling: ${error.message}`);
      return { 
        success: false, 
        error: error.message,
        fallback_message: 'Sorry, we are experiencing technical difficulties.'
      };
    }
  }

  /**
   * Submit lead data collected by AI agent
   */
  async submitLeadData(leadData: {
    call_id: string;
    tradie_id: string;
    caller_number: string;
    issue: string;
    address: string;
    additional_info?: string;
    ai_transcript?: string;
  }) {
    this.logger.log(`Processing lead data from AI for call: ${leadData.call_id}`);

    try {
      const lead = await this.leadService.createFromAIData(leadData);
      return { success: true, lead_id: (lead as any)._id };

    } catch (error) {
      this.logger.error(`Error processing AI lead data: ${error.message}`);
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

  /**
   * Get tradie information for AI agent
   */
  async getTradieInfo(tradieId: string) {
    try {
      const tradie = await this.tradieService.findById(tradieId);
      
      if (!tradie) {
        return { success: false, error: 'Tradie not found' };
      }

      return {
        success: true,
        tradie: {
          id: (tradie as any)._id,
          name: tradie.name,
          company_name: tradie.company_name,
          trade: tradie.trade,
          working_hours: tradie.working_hours,
        },
      };

    } catch (error) {
      this.logger.error(`Error getting tradie info: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate personalized AI instructions based on tradie info
   */
  private generateAIInstructions(tradie: any): string {
    const instructions = `
You are a professional voice assistant for ${tradie.name || 'the tradie'}${tradie.company_name ? ` from ${tradie.company_name}` : ''}.
${tradie.trade ? `They specialize in ${tradie.trade}.` : ''}
${tradie.working_hours ? `Their working hours are: ${tradie.working_hours}.` : ''}

Your role is to:
1. Greet the customer professionally
2. Collect the following information:
   - The issue or problem they're experiencing
   - Their address or location
   - Any additional relevant details
3. Be empathetic and reassuring
4. Let them know someone will contact them soon
5. Keep the conversation natural and conversational

Please collect all required information and then submit it to the backend system.
    `.trim();

    return instructions;
  }
}