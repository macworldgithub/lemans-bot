// // // import { Injectable, Logger } from '@nestjs/common';
// // // import { ConfigService } from '@nestjs/config';
// // // import { InjectModel } from '@nestjs/mongoose';
// // // import { ClientRequest } from 'http';
// // // import { Model } from 'mongoose';
// // // import { Socket as NetSocket } from 'net';
// // // import { TLSSocket } from 'tls';
// // // import WebSocket from 'ws';
// // // import { Lead, LeadDocument } from './schemas/lead.schema';
// // // import { ActiveCampaignService } from '../integrations/active-campaign.service';

// // // // ─── Types ────────────────────────────────────────────────────────────────────

// // // export type EventType =
// // //   | 'kids_party'
// // //   | 'buck_party'
// // //   | 'corporate'
// // //   | 'general_enquiry'
// // //   | 'unknown';

// // // interface RealtimeSession {
// // //   ws: WebSocket;
// // //   elevenLabsWs: WebSocket | null;
// // //   elevenLabsReady: boolean;
// // //   textBuffer: string[];
// // //   isResponseActive: boolean;
// // //   onEvent: (event: any) => void;
// // //   sessionStartedAtMs: number;
// // //   openAiConnectedAtMs: number | null;
// // //   elevenLabsConnectedAtMs: number | null;
// // //   greetingTriggeredAtMs: number | null;
// // //   firstResponseCreatedAtMs: number | null;
// // //   firstAudioDeltaLogged: boolean;
// // //   processedFunctionCallIds: Set<string>;
// // //   lastQuestionAsked: string;
// // //   silenceRepromptCount: number;
// // //   detectedEventType: EventType;
// // //   callerNumber: string;
// // // }

// // // interface FunctionCallPayload {
// // //   name: string;
// // //   arguments: string;
// // //   call_id: string;
// // // }

// // // // Transfer number map — populate from env or hardcode for POC
// // // const TRANSFER_NUMBERS: Record<EventType, string | null> = {
// // //   kids_party: process.env.TRANSFER_KIDS_PARTY ?? null,
// // //   buck_party: process.env.TRANSFER_BUCK_PARTY ?? null,
// // //   corporate: process.env.TRANSFER_CORPORATE ?? null,
// // //   general_enquiry: process.env.TRANSFER_GENERAL ?? null,
// // //   unknown: process.env.TRANSFER_GENERAL ?? null,
// // // };

// // // @Injectable()
// // // export class VoiceService {
// // //   private readonly logger = new Logger(VoiceService.name);
// // //   private sessions = new Map<string, RealtimeSession>();
// // //   private readonly MAX_SILENCE_REPROMPTS = 2;

// // //   constructor(
// // //     private readonly config: ConfigService,
// // //     @InjectModel(Lead.name)
// // //     private readonly leadModel: Model<LeadDocument>,
// // //     private readonly activeCampaign: ActiveCampaignService,
// // //   ) {}

// // //   // ─── Type guard ─────────────────────────────────────────────────────────────

// // //   private toFunctionCallPayload(value: unknown): FunctionCallPayload | null {
// // //     if (!value || typeof value !== 'object') return null;
// // //     const r = value as Record<string, unknown>;
// // //     if (r.type !== 'function_call') return null;
// // //     if (
// // //       typeof r.name !== 'string' ||
// // //       typeof r.arguments !== 'string' ||
// // //       typeof r.call_id !== 'string'
// // //     )
// // //       return null;
// // //     return { name: r.name, arguments: r.arguments, call_id: r.call_id };
// // //   }

// // //   // ─── Silence handling ────────────────────────────────────────────────────────

// // //   handleSilenceTimeout(sessionId: string): void {
// // //     const session = this.sessions.get(sessionId);
// // //     if (!session) return;

// // //     if (session.isResponseActive) {
// // //       this.logger.debug(
// // //         `[${sessionId}] Silence ignored — response still active`,
// // //       );
// // //       return;
// // //     }

// // //     session.silenceRepromptCount += 1;

// // //     if (session.silenceRepromptCount > this.MAX_SILENCE_REPROMPTS) {
// // //       this.logger.log(
// // //         `[${sessionId}] Max silence re-prompts reached — closing politely`,
// // //       );
// // //       this._injectAndRespond(
// // //         sessionId,
// // //         "It seems like you might have stepped away. No worries — feel free to call back whenever you're ready. Thanks for calling LeMans Entertainment, take care!",
// // //       );
// // //       setTimeout(() => this.closeSession(sessionId), 8_000);
// // //       return;
// // //     }

// // //     const reprompt = this._buildSilenceReprompt(session);
// // //     this.logger.log(
// // //       `[${sessionId}] Silence #${session.silenceRepromptCount} — re-prompting: "${reprompt}"`,
// // //     );
// // //     this._injectAndRespond(sessionId, reprompt);
// // //   }

// // //   private _buildSilenceReprompt(session: RealtimeSession): string {
// // //     const last = session.lastQuestionAsked?.trim();
// // //     if (!last) {
// // //       return "I guess you didn't hear that — are you still there?";
// // //     }
// // //     return `I guess you didn't hear that, let me repeat my question. ${last}`;
// // //   }

// // //   private _injectAndRespond(sessionId: string, text: string): void {
// // //     const session = this.sessions.get(sessionId);
// // //     if (!session || session.ws.readyState !== WebSocket.OPEN) return;

// // //     session.ws.send(
// // //       JSON.stringify({
// // //         type: 'conversation.item.create',
// // //         item: {
// // //           type: 'message',
// // //           role: 'user',
// // //           content: [
// // //             {
// // //               type: 'input_text',
// // //               text: `[SYSTEM: The user has been silent. Re-engage by saying exactly this, naturally: "${text}"]`,
// // //             },
// // //           ],
// // //         },
// // //       }),
// // //     );
// // //     session.ws.send(JSON.stringify({ type: 'response.create' }));
// // //   }

// // //   // ─── Create session ──────────────────────────────────────────────────────────

// // //   async createRealtimeSession(
// // //     sessionId: string,
// // //     onEvent: (event: any) => void,
// // //     callerNumber = 'unknown',
// // //   ): Promise<void> {
// // //     const apiKey = this.config.get<string>('OPENAI_API_KEY');
// // //     const model = 'gpt-realtime-mini';
// // //     const url = `wss://api.openai.com/v1/realtime?model=${model}`;
// // //     const sessionStartedAtMs = Date.now();

// // //     return new Promise((resolve, reject) => {
// // //       const ws = new WebSocket(url, {
// // //         headers: {
// // //           Authorization: `Bearer ${apiKey}`,
// // //           'OpenAI-Beta': 'realtime=v1',
// // //         },
// // //       });

// // //       this.instrumentHandshake(sessionId, 'OpenAI', ws, sessionStartedAtMs);

// // //       ws.on('open', () => {
// // //         const openAiConnectedAtMs = Date.now();
// // //         this.logger.log(
// // //           `[${sessionId}] OpenAI connected in ${openAiConnectedAtMs - sessionStartedAtMs}ms`,
// // //         );

// // //         ws.send(
// // //           JSON.stringify({
// // //             type: 'session.update',
// // //             session: {
// // //               modalities: ['text'],
// // //               instructions: this.getSystemPrompt(),
// // //               input_audio_format: 'pcm16',
// // //               turn_detection: {
// // //                 type: 'server_vad',
// // //                 threshold: 0.8,
// // //                 prefix_padding_ms: 300,
// // //                 silence_duration_ms: 2000,
// // //               },
// // //               tools: [
// // //                 this.getTransferCallTool(),
// // //                 this.getSaveLeadTool(),
// // //                 this.getAnswerFaqTool(),
// // //               ],
// // //               tool_choice: 'auto',
// // //             },
// // //           }),
// // //         );

// // //         this.sessions.set(sessionId, {
// // //           ws,
// // //           elevenLabsWs: null,
// // //           elevenLabsReady: false,
// // //           textBuffer: [],
// // //           isResponseActive: false,
// // //           onEvent,
// // //           sessionStartedAtMs,
// // //           openAiConnectedAtMs,
// // //           elevenLabsConnectedAtMs: null,
// // //           greetingTriggeredAtMs: null,
// // //           firstResponseCreatedAtMs: null,
// // //           firstAudioDeltaLogged: false,
// // //           processedFunctionCallIds: new Set(),
// // //           lastQuestionAsked: '',
// // //           silenceRepromptCount: 0,
// // //           detectedEventType: 'unknown',
// // //           callerNumber,
// // //         });

// // //         this.openElevenLabsStream(sessionId);
// // //         resolve();
// // //       });

// // //       ws.on('message', async (data: WebSocket.Data) => {
// // //         try {
// // //           const event = JSON.parse(data.toString());
// // //           await this.handleRealtimeEvent(sessionId, event);
// // //         } catch (err) {
// // //           this.logger.error(`[${sessionId}] Failed to parse event:`, err);
// // //         }
// // //       });

// // //       ws.on('error', (err) => {
// // //         this.logger.error(`[${sessionId}] OpenAI WS error:`, err);
// // //         onEvent({ type: 'error', error: { message: err.message } });
// // //         reject(err);
// // //       });

// // //       ws.on('close', (code, reason) => {
// // //         this.logger.log(
// // //           `[${sessionId}] OpenAI WS closed: ${code} - ${reason}`,
// // //         );
// // //         this.closeElevenLabsWs(sessionId);
// // //         this.sessions.delete(sessionId);
// // //         onEvent({ type: 'session-closed' });
// // //       });
// // //     });
// // //   }

// // //   // ─── Send audio ──────────────────────────────────────────────────────────────

// // //   sendAudio(sessionId: string, base64Audio: string): void {
// // //     const session = this.sessions.get(sessionId);
// // //     if (!session) return;
// // //     session.ws.send(
// // //       JSON.stringify({ type: 'input_audio_buffer.append', audio: base64Audio }),
// // //     );
// // //   }

// // //   // ─── Trigger greeting ────────────────────────────────────────────────────────

// // //   triggerGreeting(sessionId: string): void {
// // //     const session = this.sessions.get(sessionId);
// // //     if (!session) return;
// // //     session.greetingTriggeredAtMs = Date.now();
// // //     session.ws.send(JSON.stringify({ type: 'response.create' }));
// // //   }

// // //   // ─── ElevenLabs stream ───────────────────────────────────────────────────────

// // //   private openElevenLabsStream(sessionId: string, force = false): void {
// // //     const session = this.sessions.get(sessionId);
// // //     if (!session) return;

// // //     if (
// // //       !force &&
// // //       session.elevenLabsWs &&
// // //       (session.elevenLabsWs.readyState === WebSocket.OPEN ||
// // //         session.elevenLabsWs.readyState === WebSocket.CONNECTING)
// // //     ) {
// // //       return;
// // //     }

// // //     this.closeElevenLabsWs(sessionId);

// // //     const apiKey = this.config.get<string>('ELEVENLABS_API_KEY');
// // //     const voiceId = this.config.get<string>('ELEVENLABS_VOICE_ID');
// // //     const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_flash_v2_5&output_format=pcm_16000`;

// // //     const elWs = new WebSocket(wsUrl);
// // //     this.instrumentHandshake(
// // //       sessionId,
// // //       'ElevenLabs',
// // //       elWs,
// // //       session.sessionStartedAtMs,
// // //     );

// // //     elWs.on('open', () => {
// // //       this.logger.log(`[${sessionId}] ElevenLabs connected`);
// // //       session.elevenLabsConnectedAtMs = Date.now();

// // //       elWs.send(
// // //         JSON.stringify({
// // //           text: ' ',
// // //           voice_settings: {
// // //             stability: 0.45,
// // //             similarity_boost: 0.75,
// // //             speed: 1.1,
// // //           },
// // //           xi_api_key: apiKey,
// // //         }),
// // //       );

// // //       if (session.elevenLabsWs === elWs) {
// // //         session.elevenLabsReady = true;
// // //         for (const text of session.textBuffer) {
// // //           this.sendTextToElevenLabs(sessionId, text);
// // //         }
// // //         session.textBuffer = [];
// // //       }
// // //     });

// // //     elWs.on('message', (data: WebSocket.Data) => {
// // //       try {
// // //         const msg = JSON.parse(data.toString());
// // //         if (msg.audio) {
// // //           if (!session.firstAudioDeltaLogged) {
// // //             session.firstAudioDeltaLogged = true;
// // //             this.logger.log(
// // //               `[${sessionId}] First audio at ${Date.now() - session.sessionStartedAtMs}ms`,
// // //             );
// // //           }
// // //           session.onEvent({ type: 'audio-delta', delta: msg.audio });
// // //         }
// // //         if (msg.isFinal === true) {
// // //           session.onEvent({ type: 'audio-done' });
// // //         }
// // //       } catch {
// // //         // binary frames — ignore
// // //       }
// // //     });

// // //     elWs.on('error', (err) => {
// // //       this.logger.warn(`[${sessionId}] ElevenLabs WS error: ${err.message}`);
// // //     });

// // //     elWs.on('close', () => {
// // //       if (session.elevenLabsWs === elWs) {
// // //         session.elevenLabsReady = false;
// // //       }
// // //     });

// // //     session.elevenLabsWs = elWs;
// // //   }

// // //   private sendTextToElevenLabs(sessionId: string, text: string): void {
// // //     const session = this.sessions.get(sessionId);
// // //     if (session?.elevenLabsWs?.readyState === WebSocket.OPEN) {
// // //       session.elevenLabsWs.send(
// // //         JSON.stringify({ text, try_trigger_generation: true }),
// // //       );
// // //     }
// // //   }

// // //   private flushElevenLabsStream(sessionId: string): void {
// // //     const session = this.sessions.get(sessionId);
// // //     if (session?.elevenLabsWs?.readyState === WebSocket.OPEN) {
// // //       session.elevenLabsWs.send(JSON.stringify({ text: '' }));
// // //     }
// // //   }

// // //   private closeElevenLabsWs(sessionId: string): void {
// // //     const session = this.sessions.get(sessionId);
// // //     if (!session?.elevenLabsWs) return;
// // //     try {
// // //       if (session.elevenLabsWs.readyState === WebSocket.CONNECTING) {
// // //         session.elevenLabsWs.terminate();
// // //       } else if (session.elevenLabsWs.readyState === WebSocket.OPEN) {
// // //         session.elevenLabsWs.close();
// // //       }
// // //     } catch (err) {
// // //       this.logger.warn(
// // //         `[${sessionId}] Error closing ElevenLabs WS: ${err.message}`,
// // //       );
// // //     }
// // //     session.elevenLabsWs = null;
// // //     session.elevenLabsReady = false;
// // //     session.textBuffer = [];
// // //   }

// // //   // ─── Event hub ───────────────────────────────────────────────────────────────

// // //   private async handleRealtimeEvent(
// // //     sessionId: string,
// // //     event: any,
// // //   ): Promise<void> {
// // //     const session = this.sessions.get(sessionId);
// // //     if (!session) return;

// // //     this.logger.debug(`[${sessionId}] Event: ${event.type}`);

// // //     switch (event.type) {
// // //       case 'response.created':
// // //         session.isResponseActive = true;
// // //         session.silenceRepromptCount = 0;
// // //         if (!session.firstResponseCreatedAtMs) {
// // //           session.firstResponseCreatedAtMs = Date.now();
// // //         }
// // //         this.openElevenLabsStream(sessionId);
// // //         break;

// // //       case 'response.done': {
// // //         session.isResponseActive = false;
// // //         const outputs = (event as any).response?.output;
// // //         if (Array.isArray(outputs)) {
// // //           for (const item of outputs) {
// // //             const fn = this.toFunctionCallPayload(item);
// // //             if (fn) await this.handleFunctionCall(sessionId, fn);
// // //           }
// // //         }
// // //         break;
// // //       }

// // //       case 'response.text.delta':
// // //         if (session.elevenLabsReady) {
// // //           this.sendTextToElevenLabs(sessionId, event.delta);
// // //         } else {
// // //           session.textBuffer.push(event.delta);
// // //         }
// // //         session.onEvent({ type: 'transcript-delta', delta: event.delta });
// // //         break;

// // //       case 'response.text.done':
// // //         if (typeof event.text === 'string' && event.text.trim()) {
// // //           session.lastQuestionAsked = event.text.trim();
// // //         }
// // //         this.flushElevenLabsStream(sessionId);
// // //         session.onEvent({ type: 'transcript-done', transcript: event.text });
// // //         break;

// // //       case 'input_audio_buffer.speech_started':
// // //         session.silenceRepromptCount = 0;
// // //         if (session.isResponseActive) {
// // //           try {
// // //             session.ws.send(JSON.stringify({ type: 'response.cancel' }));
// // //           } catch (err) {
// // //             this.logger.warn(`[${sessionId}] Cancel failed: ${err.message}`);
// // //           }
// // //         }
// // //         this.closeElevenLabsWs(sessionId);
// // //         this.openElevenLabsStream(sessionId, true);
// // //         session.onEvent({ type: 'speech-started' });
// // //         break;

// // //       case 'conversation.item.input_audio_transcription.completed':
// // //         session.onEvent({
// // //           type: 'user-transcript',
// // //           transcript: event.transcript,
// // //         });
// // //         break;

// // //       case 'response.function_call_arguments.done':
// // //         await this.handleFunctionCall(sessionId, event);
// // //         break;

// // //       case 'response.output_item.done': {
// // //         const fn = this.toFunctionCallPayload((event as any).item);
// // //         if (fn) await this.handleFunctionCall(sessionId, fn);
// // //         break;
// // //       }

// // //       case 'error':
// // //         this.logger.error(
// // //           `[${sessionId}] OpenAI error: ${JSON.stringify(event.error)}`,
// // //         );
// // //         break;
// // //     }
// // //   }

// // //   // ─── Function call dispatcher ────────────────────────────────────────────────

// // //   private async handleFunctionCall(
// // //     sessionId: string,
// // //     event: FunctionCallPayload,
// // //   ): Promise<void> {
// // //     const session = this.sessions.get(sessionId);
// // //     if (!session) return;

// // //     const callId = event.call_id ?? null;
// // //     if (callId && session.processedFunctionCallIds.has(callId)) {
// // //       this.logger.debug(`[${sessionId}] Duplicate fn call ignored: ${callId}`);
// // //       return;
// // //     }
// // //     if (callId) session.processedFunctionCallIds.add(callId);

// // //     try {
// // //       const args = JSON.parse(event.arguments);

// // //       if (event.name === 'transfer_call') {
// // //         await this.handleTransferCall(sessionId, args, event.call_id);
// // //       } else if (event.name === 'save_lead') {
// // //         await this.handleSaveLead(sessionId, args, event.call_id);
// // //       } else if (event.name === 'answer_faq') {
// // //         await this.handleAnswerFaq(sessionId, args, event.call_id);
// // //       }
// // //     } catch (err) {
// // //       if (callId) session.processedFunctionCallIds.delete(callId);
// // //       this.logger.error(`[${sessionId}] Function call error: ${err.message}`);
// // //     }
// // //   }

// // //   // ─── transfer_call ───────────────────────────────────────────────────────────

// // //   private async handleTransferCall(
// // //     sessionId: string,
// // //     args: any,
// // //     callId: string,
// // //   ): Promise<void> {
// // //     const session = this.sessions.get(sessionId);
// // //     if (!session) return;

// // //     const eventType: EventType = args.event_type ?? 'unknown';
// // //     session.detectedEventType = eventType;

// // //     this.logger.log(
// // //       `[${sessionId}] Transfer requested — event_type: ${eventType}`,
// // //     );

// // //     const transferTo = TRANSFER_NUMBERS[eventType];

// // //     if (transferTo) {
// // //       this.logger.log(`[${sessionId}] Transferring to ${transferTo}`);
// // //       session.onEvent({
// // //         type: 'transfer-initiated',
// // //         data: {
// // //           event_type: eventType,
// // //           transfer_to: transferTo,
// // //           caller_name: args.caller_name,
// // //           caller_number: session.callerNumber,
// // //         },
// // //       });

// // //       this._sendFunctionResult(sessionId, callId, {
// // //         success: true,
// // //         message: `Transferring to the right team now.`,
// // //         transfer_to: transferTo,
// // //       });
// // //     } else {
// // //       // Transfer number not configured — fall back to lead capture
// // //       this.logger.warn(
// // //         `[${sessionId}] No transfer number for ${eventType} — saving lead instead`,
// // //       );

// // //       this._sendFunctionResult(sessionId, callId, {
// // //         success: false,
// // //         message:
// // //           'Transfer unavailable right now — I will save your details instead.',
// // //       });
// // //     }

// // //     session.ws.send(JSON.stringify({ type: 'response.create' }));
// // //   }

// // //   // ─── save_lead ───────────────────────────────────────────────────────────────

// // //   private async handleSaveLead(
// // //     sessionId: string,
// // //     args: any,
// // //     callId: string,
// // //   ): Promise<void> {
// // //     const session = this.sessions.get(sessionId);
// // //     if (!session) return;

// // //     this.logger.log(
// // //       `[${sessionId}] Saving lead for: ${args.caller_name} | ${args.event_type}`,
// // //     );

// // //     const lead = await this.leadModel.create({
// // //       callerName: args.caller_name,
// // //       callerNumber: args.caller_number || session.callerNumber,
// // //       eventType: args.event_type,
// // //       eventDate: args.event_date,
// // //       groupSize: args.group_size,
// // //       enquiryDetails: args.enquiry_details,
// // //       callId: sessionId,
// // //       source: 'voice_agent',
// // //     });

// // //     this.logger.log(`[${sessionId}] Lead saved: ${lead._id}`);

// // //     // Push to ActiveCampaign
// // //     try {
// // //       await this.activeCampaign.createContact({
// // //         firstName: args.caller_name,
// // //         phone: args.caller_number || session.callerNumber,
// // //         tag: args.event_type,
// // //         fieldValues: [
// // //           { field: 'EVENT_TYPE', value: args.event_type },
// // //           { field: 'EVENT_DATE', value: args.event_date ?? '' },
// // //           { field: 'GROUP_SIZE', value: String(args.group_size ?? '') },
// // //           { field: 'ENQUIRY', value: args.enquiry_details ?? '' },
// // //         ],
// // //       });
// // //       this.logger.log(`[${sessionId}] ActiveCampaign contact created`);
// // //     } catch (err) {
// // //       this.logger.warn(
// // //         `[${sessionId}] ActiveCampaign push failed: ${err.message}`,
// // //       );
// // //     }

// // //     this._sendFunctionResult(sessionId, callId, {
// // //       success: true,
// // //       message: 'Lead saved. Our team will be in touch soon.',
// // //     });

// // //     session.ws.send(JSON.stringify({ type: 'response.create' }));
// // //     session.onEvent({ type: 'lead-saved', data: args });
// // //   }

// // //   // ─── answer_faq ──────────────────────────────────────────────────────────────

// // //   private async handleAnswerFaq(
// // //     sessionId: string,
// // //     args: any,
// // //     callId: string,
// // //   ): Promise<void> {
// // //     const session = this.sessions.get(sessionId);
// // //     if (!session) return;

// // //     const answer = this.resolveFaq(args.question_category);
// // //     this.logger.log(
// // //       `[${sessionId}] FAQ: ${args.question_category} → ${answer.substring(0, 80)}`,
// // //     );

// // //     this._sendFunctionResult(sessionId, callId, {
// // //       success: true,
// // //       answer,
// // //     });

// // //     session.ws.send(JSON.stringify({ type: 'response.create' }));
// // //   }

// // //   // ─── FAQ knowledge base ──────────────────────────────────────────────────────

// // //   private resolveFaq(category: string): string {
// // //     const kb: Record<string, string> = {
// // //       opening_hours:
// // //         'LeMans Entertainment is open 7 days a week. Monday to Friday 10am–10pm, Saturday and Sunday 9am–11pm. Public holidays may vary.',
// // //       directions:
// // //         'We are located at [ADDRESS]. Easiest access is via [MAIN ROAD]. Use the [LANDMARK] as your reference point.',
// // //       parking:
// // //         'Free parking is available on-site with over 100 spaces. There is also street parking available on nearby roads.',
// // //       kids_party:
// // //         'Our kids party packages start from $XX per child with a minimum of 10 kids. Packages include go-karting, food and a dedicated party host. Weekends book out fast so we recommend booking at least 3–4 weeks in advance.',
// // //       buck_party:
// // //         'Buck party packages are super popular and typically include racing, drinks on arrival, and a trophy presentation. Spots genuinely sell out months ahead, especially Friday and Saturday nights. Worth locking in ASAP.',
// // //       corporate:
// // //         'Our corporate packages are fully customisable — we do team building days, client entertainment, product launches and more. Our corporate sales team handles these personally to tailor the experience.',
// // //       pricing:
// // //         'Pricing depends on the package and group size. Our team can give you an exact quote based on your requirements. Would you like me to connect you with someone?',
// // //       booking:
// // //         'You can book online at our website or our team can take your details and call you back to confirm. Weekend and peak times sell out quickly — we recommend booking as soon as you can.',
// // //     };

// // //     return (
// // //       kb[category] ??
// // //       'That is a great question. Let me get the right person to help you with that.'
// // //     );
// // //   }

// // //   // ─── Helpers ─────────────────────────────────────────────────────────────────

// // //   private _sendFunctionResult(
// // //     sessionId: string,
// // //     callId: string,
// // //     output: object,
// // //   ): void {
// // //     const session = this.sessions.get(sessionId);
// // //     if (!session || session.ws.readyState !== WebSocket.OPEN) return;

// // //     session.ws.send(
// // //       JSON.stringify({
// // //         type: 'conversation.item.create',
// // //         item: {
// // //           type: 'function_call_output',
// // //           call_id: callId,
// // //           output: JSON.stringify(output),
// // //         },
// // //       }),
// // //     );
// // //   }

// // //   // ─── Cleanup ─────────────────────────────────────────────────────────────────

// // //   closeSession(sessionId: string): void {
// // //     const session = this.sessions.get(sessionId);
// // //     if (session) {
// // //       this.closeElevenLabsWs(sessionId);
// // //       try {
// // //         session.ws.close();
// // //       } catch {
// // //         // already closed
// // //       }
// // //       this.sessions.delete(sessionId);
// // //       this.logger.log(`[${sessionId}] Session closed`);
// // //     }
// // //   }

// // //   // ─── WS instrumentation ──────────────────────────────────────────────────────

// // //   private instrumentHandshake(
// // //     sessionId: string,
// // //     provider: 'OpenAI' | 'ElevenLabs',
// // //     ws: WebSocket,
// // //     startedAtMs: number,
// // //   ): void {
// // //     const wsWithReq = ws as WebSocket & { _req?: ClientRequest };
// // //     const req = wsWithReq._req;
// // //     if (!req) return;

// // //     let attached = false;
// // //     const attach = (socket: NetSocket): void => {
// // //       if (attached) return;
// // //       attached = true;
// // //       socket.once('lookup', () =>
// // //         this.logger.log(
// // //           `[${sessionId}] ${provider} DNS lookup in ${Date.now() - startedAtMs}ms`,
// // //         ),
// // //       );
// // //       socket.once('connect', () =>
// // //         this.logger.log(
// // //           `[${sessionId}] ${provider} TCP connect in ${Date.now() - startedAtMs}ms`,
// // //         ),
// // //       );
// // //       (socket as TLSSocket).once('secureConnect', () =>
// // //         this.logger.log(
// // //           `[${sessionId}] ${provider} TLS handshake in ${Date.now() - startedAtMs}ms`,
// // //         ),
// // //       );
// // //     };

// // //     if (req.socket) attach(req.socket);
// // //     req.once('socket', (s: NetSocket) => attach(s));
// // //     ws.on('upgrade', () =>
// // //       this.logger.log(
// // //         `[${sessionId}] ${provider} WS upgrade in ${Date.now() - startedAtMs}ms`,
// // //       ),
// // //     );
// // //   }

// // //   // ─── System prompt ───────────────────────────────────────────────────────────

// // //   private getSystemPrompt(): string {
// // //     return `
// // // =============================================================
// // // ABSOLUTE RULE — ENGLISH ONLY
// // // =============================================================
// // // You MUST speak and respond in English at all times, no matter what.
// // // If the caller uses another language, respond only in English.
// // // =============================================================

// // // ### IDENTITY ###
// // // You are Alex — the friendly voice receptionist for LeMans Entertainment Melbourne.
// // // You answer the main enquiries line. You're warm, professional, and upbeat — like
// // // the best person at the venue's front desk.

// // // ### AI DISCLOSURE ###
// // // Do NOT volunteer that you are AI.
// // // ONLY if directly asked "are you a robot?" or "are you AI?" respond honestly:
// // // "Yeah, I'm actually an AI assistant for LeMans. I'll get you sorted just the same though!"
// // // Then pivot straight back to helping them.

// // // ### PERSONALITY ###
// // // - Friendly, upbeat, professional — like you love working at LeMans
// // // - Short sentences. 1–2 sentences per response.
// // // - Natural filler: "yeah", "absolutely", "no worries", "for sure"
// // // - Match caller energy — excited with excited callers, reassuring with worried ones
// // // - React genuinely before asking the next question — never go question-to-question

// // // ### WHAT LEMANS IS ###
// // // LeMans Entertainment is a go-karting and entertainment venue in Melbourne.
// // // They host kids parties, buck/hen parties, corporate events, and general fun visits.
// // // Weekend and peak times sell out fast — this is a genuine, honest fact to share.

// // // ### EVENT TYPE CLASSIFICATION (INTERNAL — NEVER ANNOUNCE) ###
// // // Silently classify every call into one of:
// // // - kids_party      — birthday party, kids entertainment, school groups
// // // - buck_party       — bucks night, hens night, bachelor/bachelorette
// // // - corporate        — corporate team building, client entertainment, company event
// // // - general_enquiry  — pricing, hours, directions, parking, casual visit

// // // CORPORATE CALLS: Detect IMMEDIATELY. Warm transfer straight away to the sales
// // // mobile. Do NOT ask lots of questions — just get their name and transfer.

// // // ### CALL FLOW ###

// // // STEP 1 — GREET
// // // "Hi, thanks for calling LeMans Entertainment! This is Alex speaking — how can I help you today?"

// // // STEP 2 — IDENTIFY INTENT
// // // Let them tell you what they need. Listen and classify silently.

// // // STEP 3a — BASIC QUESTION (hours, parking, directions, general)
// // // → Call answer_faq with the appropriate question_category
// // // → Answer naturally from the result
// // // → Check if they need anything else
// // // → If they want to book/enquire further: get name + number + details → save_lead

// // // STEP 3b — KIDS PARTY / BUCK PARTY enquiry
// // // → Ask 2–3 natural questions to understand their needs:
// // //   - Approx number of people / group size
// // //   - Preferred date or timeframe
// // //   - Any specific requests
// // // → Mention genuinely that these book out fast: "Just so you know, weekends especially
// // //   sell out pretty quickly — worth locking something in sooner rather than later."
// // // → Collect name and number
// // // → Call save_lead to capture the enquiry
// // // → Tell them the team will call back to confirm details

// // // STEP 3c — CORPORATE enquiry
// // // → React warmly: "Oh nice, a corporate event — we love those!"
// // // → Get their name
// // // → Say: "I'll put you straight through to our corporate team who handle these personally."
// // // → Call transfer_call with event_type: "corporate"

// // // STEP 3d — TRANSFER (any event type where transfer is appropriate)
// // // → Call transfer_call with the correct event_type
// // // → If transfer fails/unavailable: pivot to save_lead

// // // STEP 4 — WRAP UP (if not transferred)
// // // After saving lead: "Perfect, I've got all that. Someone from our team will give you a
// // // call back [today/shortly] to go over everything. Is there anything else I can help with?"

// // // ### URGENCY MESSAGING (IMPORTANT) ###
// // // For kids parties and buck parties, weave in genuine urgency naturally:
// // // - "Just giving you a heads up — [weekend dates/peak periods] do sell out pretty quickly."
// // // - "We'd definitely recommend locking in a date as soon as you can."
// // // - "Honestly these slots go fast, especially Saturday nights."
// // // Only say it once per call. Keep it genuine, not pushy.

// // // ### OFF-TOPIC HANDLING ###
// // // You ONLY handle LeMans Entertainment enquiries.
// // // For anything unrelated: "Ah sorry, I'm only set up for LeMans enquiries. Is there
// // // anything about the venue or events I can help you with?"

// // // ### SILENCE HANDLING ###
// // // If you receive a [SYSTEM: The user has been silent...] instruction:
// // // Speak exactly what it says, naturally and conversationally. Do not add extra content.

// // // ### HARD RULES ###
// // // - ONE question at a time
// // // - 1–2 sentences per response max
// // // - NEVER repeat the same transition twice in a call
// // // - ALWAYS call save_lead OR transfer_call before ending — never end without one
// // // - Corporate → transfer immediately
// // // - No promises on specific callback times unless instructed
// // // `;
// // //   }

// // //   // ─── Tool definitions ─────────────────────────────────────────────────────────

// // //   private getTransferCallTool() {
// // //     return {
// // //       type: 'function',
// // //       name: 'transfer_call',
// // //       description:
// // //         'Initiates a warm call transfer to the appropriate team based on the event type. Use immediately for corporate enquiries.',
// // //       parameters: {
// // //         type: 'object',
// // //         properties: {
// // //           event_type: {
// // //             type: 'string',
// // //             enum: ['kids_party', 'buck_party', 'corporate', 'general_enquiry'],
// // //             description: 'The type of enquiry/event detected',
// // //           },
// // //           caller_name: {
// // //             type: 'string',
// // //             description: "Caller's name if collected",
// // //           },
// // //           transfer_reason: {
// // //             type: 'string',
// // //             description: 'Brief reason for the transfer',
// // //           },
// // //         },
// // //         required: ['event_type'],
// // //       },
// // //     };
// // //   }

// // //   private getSaveLeadTool() {
// // //     return {
// // //       type: 'function',
// // //       name: 'save_lead',
// // //       description:
// // //         'Saves caller enquiry details to the database and sends to ActiveCampaign. Call this when a transfer is not possible or when a non-corporate caller wants a callback.',
// // //       parameters: {
// // //         type: 'object',
// // //         properties: {
// // //           caller_name: { type: 'string', description: "Caller's name" },
// // //           caller_number: {
// // //             type: 'string',
// // //             description: "Caller's phone number",
// // //           },
// // //           event_type: {
// // //             type: 'string',
// // //             enum: [
// // //               'kids_party',
// // //               'buck_party',
// // //               'corporate',
// // //               'general_enquiry',
// // //               'unknown',
// // //             ],
// // //           },
// // //           event_date: {
// // //             type: 'string',
// // //             description: 'Preferred date or timeframe',
// // //           },
// // //           group_size: { type: 'number', description: 'Approximate group size' },
// // //           enquiry_details: {
// // //             type: 'string',
// // //             description:
// // //               'Full details of the enquiry including everything discussed',
// // //           },
// // //         },
// // //         required: ['caller_name', 'event_type', 'enquiry_details'],
// // //       },
// // //     };
// // //   }

// // //   private getAnswerFaqTool() {
// // //     return {
// // //       type: 'function',
// // //       name: 'answer_faq',
// // //       description:
// // //         'Retrieves the answer to a common FAQ about LeMans Entertainment from the knowledge base.',
// // //       parameters: {
// // //         type: 'object',
// // //         properties: {
// // //           question_category: {
// // //             type: 'string',
// // //             enum: [
// // //               'opening_hours',
// // //               'directions',
// // //               'parking',
// // //               'kids_party',
// // //               'buck_party',
// // //               'corporate',
// // //               'pricing',
// // //               'booking',
// // //             ],
// // //             description: 'The category of the FAQ question',
// // //           },
// // //         },
// // //         required: ['question_category'],
// // //       },
// // //     };
// // //   }
// // // }
// // import { Injectable, Logger } from '@nestjs/common';
// // import { ConfigService } from '@nestjs/config';
// // import { InjectModel } from '@nestjs/mongoose';
// // import { ClientRequest } from 'http';
// // import { Model } from 'mongoose';
// // import { Socket as NetSocket } from 'net';
// // import { TLSSocket } from 'tls';
// // import WebSocket from 'ws';
// // import { Lead, LeadDocument } from './schemas/lead.schema';
// // import { ActiveCampaignService } from '../integrations/active-campaign.service';

// // // ─── Types ────────────────────────────────────────────────────────────────────

// // export type EventType =
// //   | 'kids_party'
// //   | 'buck_party'
// //   | 'corporate'
// //   | 'general_enquiry'
// //   | 'unknown';

// // interface RealtimeSession {
// //   ws: WebSocket;
// //   elevenLabsWs: WebSocket | null;
// //   elevenLabsReady: boolean;
// //   textBuffer: string[];
// //   isResponseActive: boolean;
// //   onEvent: (event: any) => void;
// //   sessionStartedAtMs: number;
// //   openAiConnectedAtMs: number | null;
// //   elevenLabsConnectedAtMs: number | null;
// //   greetingTriggeredAtMs: number | null;
// //   firstResponseCreatedAtMs: number | null;
// //   firstAudioDeltaLogged: boolean;
// //   processedFunctionCallIds: Set<string>;
// //   lastQuestionAsked: string;
// //   silenceRepromptCount: number;
// //   detectedEventType: EventType;
// //   callerNumber: string;
// //   preferredLanguage: 'english' | 'mandarin';
// //   silenceTimer: ReturnType<typeof setTimeout> | null;
// // }

// // interface FunctionCallPayload {
// //   name: string;
// //   arguments: string;
// //   call_id: string;
// // }

// // // Transfer number map — populate from env or hardcode for POC
// // const TRANSFER_NUMBERS: Record<EventType, string | null> = {
// //   kids_party: process.env.TRANSFER_KIDS_PARTY ?? null,       // Birthday & Social Group Sales
// //   buck_party: process.env.TRANSFER_BUCK_PARTY ?? null,       // Birthday & Social Group Sales
// //   corporate: process.env.TRANSFER_CORPORATE ?? null,         // Corporate Events Sales
// //   general_enquiry: process.env.TRANSFER_GENERAL ?? null,
// //   unknown: process.env.TRANSFER_GENERAL ?? null,
// // };

// // // ─── Business Hours ──────────────────────────────────────────────────────────
// // // Le Mans Entertainment — 55 Waterview Cl, Dandenong South VIC 3175
// // // Mon: Closed | Tue: Closed | Wed: 4:00pm–10:00pm | Thu: 4:00pm–10:00pm
// // // Fri: 11:15am–11:00pm | Sat: 9:15am–11:00pm | Sun: 9:15am–10:00pm
// // // Note: Hours change during school holidays and seasonal holidays.

// // @Injectable()
// // export class VoiceService {
// //   private readonly logger = new Logger(VoiceService.name);
// //   private sessions = new Map<string, RealtimeSession>();
// //   private readonly MAX_SILENCE_REPROMPTS = 2;

// //   constructor(
// //     private readonly config: ConfigService,
// //     @InjectModel(Lead.name)
// //     private readonly leadModel: Model<LeadDocument>,
// //     private readonly activeCampaign: ActiveCampaignService,
// //   ) {}

// //   // ─── Type guard ─────────────────────────────────────────────────────────────

// //   private toFunctionCallPayload(value: unknown): FunctionCallPayload | null {
// //     if (!value || typeof value !== 'object') return null;
// //     const r = value as Record<string, unknown>;
// //     if (r.type !== 'function_call') return null;
// //     if (
// //       typeof r.name !== 'string' ||
// //       typeof r.arguments !== 'string' ||
// //       typeof r.call_id !== 'string'
// //     )
// //       return null;
// //     return { name: r.name, arguments: r.arguments, call_id: r.call_id };
// //   }

// //   // ─── Silence handling ────────────────────────────────────────────────────────

// //   handleSilenceTimeout(sessionId: string): void {
// //     const session = this.sessions.get(sessionId);
// //     if (!session) return;

// //     if (session.isResponseActive) {
// //       this.logger.debug(
// //         `[${sessionId}] Silence ignored — response still active`,
// //       );
// //       return;
// //     }

// //     session.silenceRepromptCount += 1;

// //     if (session.silenceRepromptCount > this.MAX_SILENCE_REPROMPTS) {
// //       this.logger.log(
// //         `[${sessionId}] Max silence re-prompts reached — closing politely`,
// //       );
// //       this._injectAndRespond(
// //         sessionId,
// //         "It seems like you might have stepped away. No worries — feel free to call back whenever you're ready. Thanks for calling LeMans Entertainment, take care!",
// //       );
// //       setTimeout(() => this.closeSession(sessionId), 8_000);
// //       return;
// //     }

// //     const reprompt = this._buildSilenceReprompt(session);
// //     this.logger.log(
// //       `[${sessionId}] Silence #${session.silenceRepromptCount} — re-prompting: "${reprompt}"`,
// //     );
// //     this._injectAndRespond(sessionId, reprompt);
// //   }

// //   // Called by the gateway when the browser signals playback has finished.
// //   // This is the correct moment to start the silence countdown — not when
// //   // ElevenLabs sends its last chunk, but when the speaker has actually gone quiet.
// //   handlePlaybackDone(sessionId: string): void {
// //     const session = this.sessions.get(sessionId);
// //     if (!session) return;

// //     // Clear any existing timer before starting a fresh one
// //     if (session.silenceTimer) {
// //       clearTimeout(session.silenceTimer);
// //       session.silenceTimer = null;
// //     }

// //     if (session.isResponseActive) return; // still generating — don't start yet

// //     const SILENCE_TIMEOUT_MS = 8_000;
// //     session.silenceTimer = setTimeout(() => {
// //       this.handleSilenceTimeout(sessionId);
// //     }, SILENCE_TIMEOUT_MS);

// //     this.logger.debug(`[${sessionId}] Silence countdown started (${SILENCE_TIMEOUT_MS}ms)`);
// //   }

// //   private _buildSilenceReprompt(session: RealtimeSession): string {
// //     const last = session.lastQuestionAsked?.trim();
// //     if (!last) {
// //       return "I guess you didn't hear that — are you still there?";
// //     }
// //     return `I guess you didn't hear that, let me repeat my question. ${last}`;
// //   }

// //   private _injectAndRespond(sessionId: string, text: string): void {
// //     const session = this.sessions.get(sessionId);
// //     if (!session || session.ws.readyState !== WebSocket.OPEN) return;

// //     session.ws.send(
// //       JSON.stringify({
// //         type: 'conversation.item.create',
// //         item: {
// //           type: 'message',
// //           role: 'user',
// //           content: [
// //             {
// //               type: 'input_text',
// //               text: `[SYSTEM: The user has been silent. Re-engage by saying exactly this, naturally: "${text}"]`,
// //             },
// //           ],
// //         },
// //       }),
// //     );
// //     session.ws.send(JSON.stringify({ type: 'response.create' }));
// //   }

// //   // ─── Create session ──────────────────────────────────────────────────────────

// //   async createRealtimeSession(
// //     sessionId: string,
// //     onEvent: (event: any) => void,
// //     callerNumber = 'unknown',
// //   ): Promise<void> {
// //     const apiKey = this.config.get<string>('OPENAI_API_KEY');
// //     const model =
// //       this.config.get<string>('OPENAI_REALTIME_MODEL') ?? 'gpt-realtime-2';
// //     const inputSampleRate = Number(
// //       this.config.get<string>('OPENAI_INPUT_SAMPLE_RATE') ?? 24000,
// //     );
// //     const vadThreshold = Number(
// //       this.config.get<string>('OPENAI_VAD_THRESHOLD') ?? 0.8,
// //     );
// //     const vadPrefixPaddingMs = Number(
// //       this.config.get<string>('OPENAI_VAD_PREFIX_PADDING_MS') ?? 300,
// //     );
// //     const vadSilenceDurationMs = Number(
// //       this.config.get<string>('OPENAI_VAD_SILENCE_DURATION_MS') ?? 2000,
// //     );
// //     const url = `wss://api.openai.com/v1/realtime?model=${model}`;
// //     const sessionStartedAtMs = Date.now();

// //     return new Promise((resolve, reject) => {
// //       const ws = new WebSocket(url, {
// //         headers: {
// //           Authorization: `Bearer ${apiKey}`,
// //         },
// //       });

// //       this.instrumentHandshake(sessionId, 'OpenAI', ws, sessionStartedAtMs);

// //       ws.on('open', () => {
// //         const openAiConnectedAtMs = Date.now();
// //         this.logger.log(
// //           `[${sessionId}] OpenAI connected in ${openAiConnectedAtMs - sessionStartedAtMs}ms`,
// //         );

// //         ws.send(
// //           JSON.stringify({
// //             type: 'session.update',
// //             session: {
// //               type: 'realtime',
// //               model,
// //               output_modalities: ['text'],
// //               audio: {
// //                 input: {
// //                   format: {
// //                     type: 'audio/pcm',
// //                     rate: inputSampleRate,
// //                   },
// //                   turn_detection: {
// //                     type: 'server_vad',
// //                     threshold: vadThreshold,
// //                     prefix_padding_ms: vadPrefixPaddingMs,
// //                     silence_duration_ms: vadSilenceDurationMs,
// //                   },
// //                 },
// //               },
// //               instructions: this.getSystemPrompt(),
// //               tools: [
// //                 this.getTransferCallTool(),
// //                 this.getSaveLeadTool(),
// //                 this.getAnswerFaqTool(),
// //               ],
// //               tool_choice: 'auto',
// //             },
// //           }),
// //         );

// //         this.sessions.set(sessionId, {
// //           ws,
// //           elevenLabsWs: null,
// //           elevenLabsReady: false,
// //           textBuffer: [],
// //           isResponseActive: false,
// //           onEvent,
// //           sessionStartedAtMs,
// //           openAiConnectedAtMs,
// //           elevenLabsConnectedAtMs: null,
// //           greetingTriggeredAtMs: null,
// //           firstResponseCreatedAtMs: null,
// //           firstAudioDeltaLogged: false,
// //           processedFunctionCallIds: new Set(),
// //           lastQuestionAsked: '',
// //           silenceRepromptCount: 0,
// //           detectedEventType: 'unknown',
// //           callerNumber,
// //           preferredLanguage: 'english',
// //           silenceTimer: null,
// //         });

// //         this.openElevenLabsStream(sessionId);
// //         resolve();
// //       });

// //       ws.on('message', async (data: WebSocket.Data) => {
// //         try {
// //           const event = JSON.parse(data.toString());
// //           await this.handleRealtimeEvent(sessionId, event);
// //         } catch (err) {
// //           this.logger.error(`[${sessionId}] Failed to parse event:`, err);
// //         }
// //       });

// //       ws.on('error', (err) => {
// //         this.logger.error(`[${sessionId}] OpenAI WS error:`, err);
// //         onEvent({ type: 'error', error: { message: err.message } });
// //         reject(err);
// //       });

// //       ws.on('close', (code, reason) => {
// //         this.logger.log(
// //           `[${sessionId}] OpenAI WS closed: ${code} - ${reason}`,
// //         );
// //         this.closeElevenLabsWs(sessionId);
// //         this.sessions.delete(sessionId);
// //         onEvent({ type: 'session-closed' });
// //       });
// //     });
// //   }

// //   // ─── Send audio ──────────────────────────────────────────────────────────────

// //   sendAudio(sessionId: string, base64Audio: string): void {
// //     const session = this.sessions.get(sessionId);
// //     if (!session) return;
// //     session.ws.send(
// //       JSON.stringify({ type: 'input_audio_buffer.append', audio: base64Audio }),
// //     );
// //   }

// //   // ─── Trigger greeting ────────────────────────────────────────────────────────

// //   triggerGreeting(sessionId: string): void {
// //     const session = this.sessions.get(sessionId);
// //     if (!session) return;
// //     session.greetingTriggeredAtMs = Date.now();
// //     session.ws.send(JSON.stringify({ type: 'response.create' }));
// //   }

// //   // ─── ElevenLabs stream ───────────────────────────────────────────────────────

// //   private openElevenLabsStream(sessionId: string, force = false): void {
// //     const session = this.sessions.get(sessionId);
// //     if (!session) return;

// //     if (
// //       !force &&
// //       session.elevenLabsWs &&
// //       (session.elevenLabsWs.readyState === WebSocket.OPEN ||
// //         session.elevenLabsWs.readyState === WebSocket.CONNECTING)
// //     ) {
// //       return;
// //     }

// //     this.closeElevenLabsWs(sessionId);

// //     const apiKey = this.config.get<string>('ELEVENLABS_API_KEY');
// //     const voiceId = this.config.get<string>('ELEVENLABS_VOICE_ID');
// //     const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_multilingual_v2&output_format=pcm_16000`;

// //     const elWs = new WebSocket(wsUrl);
// //     this.instrumentHandshake(
// //       sessionId,
// //       'ElevenLabs',
// //       elWs,
// //       session.sessionStartedAtMs,
// //     );

// //     elWs.on('open', () => {
// //       this.logger.log(`[${sessionId}] ElevenLabs connected`);
// //       session.elevenLabsConnectedAtMs = Date.now();

// //       elWs.send(
// //         JSON.stringify({
// //           text: ' ',
// //           voice_settings: {
// //             stability: 0.55,
// //             similarity_boost: 0.78,
// //             style: 0.35,
// //             use_speaker_boost: true,
// //           },
// //           xi_api_key: apiKey,
// //         }),
// //       );

// //       if (session.elevenLabsWs === elWs) {
// //         session.elevenLabsReady = true;
// //         for (const text of session.textBuffer) {
// //           this.sendTextToElevenLabs(sessionId, text);
// //         }
// //         session.textBuffer = [];
// //       }
// //     });

// //     elWs.on('message', (data: WebSocket.Data) => {
// //       try {
// //         const msg = JSON.parse(data.toString());
// //         if (msg.audio) {
// //           if (!session.firstAudioDeltaLogged) {
// //             session.firstAudioDeltaLogged = true;
// //             this.logger.log(
// //               `[${sessionId}] First audio at ${Date.now() - session.sessionStartedAtMs}ms`,
// //             );
// //           }
// //           session.onEvent({ type: 'audio-delta', delta: msg.audio });
// //         }
// //         if (msg.isFinal === true) {
// //           session.onEvent({ type: 'audio-done' });
// //         }
// //       } catch {
// //         // binary frames — ignore
// //       }
// //     });

// //     elWs.on('error', (err) => {
// //       this.logger.warn(`[${sessionId}] ElevenLabs WS error: ${err.message}`);
// //     });

// //     elWs.on('close', () => {
// //       if (session.elevenLabsWs === elWs) {
// //         session.elevenLabsReady = false;
// //       }
// //     });

// //     session.elevenLabsWs = elWs;
// //   }

// //   private sendTextToElevenLabs(sessionId: string, text: string): void {
// //     const session = this.sessions.get(sessionId);
// //     if (session?.elevenLabsWs?.readyState === WebSocket.OPEN) {
// //       session.elevenLabsWs.send(
// //         JSON.stringify({ text, try_trigger_generation: true }),
// //       );
// //     }
// //   }

// //   private flushElevenLabsStream(sessionId: string): void {
// //     const session = this.sessions.get(sessionId);
// //     if (session?.elevenLabsWs?.readyState === WebSocket.OPEN) {
// //       session.elevenLabsWs.send(JSON.stringify({ text: '' }));
// //     }
// //   }

// //   private closeElevenLabsWs(sessionId: string): void {
// //     const session = this.sessions.get(sessionId);
// //     if (!session?.elevenLabsWs) return;
// //     try {
// //       if (session.elevenLabsWs.readyState === WebSocket.CONNECTING) {
// //         session.elevenLabsWs.terminate();
// //       } else if (session.elevenLabsWs.readyState === WebSocket.OPEN) {
// //         session.elevenLabsWs.close();
// //       }
// //     } catch (err) {
// //       this.logger.warn(
// //         `[${sessionId}] Error closing ElevenLabs WS: ${err.message}`,
// //       );
// //     }
// //     session.elevenLabsWs = null;
// //     session.elevenLabsReady = false;
// //     session.textBuffer = [];
// //   }

// //   // ─── Event hub ───────────────────────────────────────────────────────────────

// //   private async handleRealtimeEvent(
// //     sessionId: string,
// //     event: any,
// //   ): Promise<void> {
// //     const session = this.sessions.get(sessionId);
// //     if (!session) return;

// //     this.logger.debug(`[${sessionId}] Event: ${event.type}`);

// //     switch (event.type) {
// //       case 'response.created':
// //         session.isResponseActive = true;
// //         session.silenceRepromptCount = 0;
// //         if (!session.firstResponseCreatedAtMs) {
// //           session.firstResponseCreatedAtMs = Date.now();
// //         }
// //         this.openElevenLabsStream(sessionId);
// //         break;

// //       case 'response.done': {
// //         session.isResponseActive = false;
// //         const outputs = (event as any).response?.output;
// //         if (Array.isArray(outputs)) {
// //           for (const item of outputs) {
// //             const fn = this.toFunctionCallPayload(item);
// //             if (fn) await this.handleFunctionCall(sessionId, fn);
// //           }
// //         }
// //         break;
// //       }

// //       // GA Realtime (gpt-realtime-2) fires response.output_text.*
// //       // Legacy preview fired response.text.* — handle both for compatibility
// //       case 'response.output_text.delta':
// //       case 'response.text.delta':
// //         if (session.elevenLabsReady) {
// //           this.sendTextToElevenLabs(sessionId, event.delta);
// //         } else {
// //           session.textBuffer.push(event.delta);
// //         }
// //         session.onEvent({ type: 'transcript-delta', delta: event.delta });
// //         break;

// //       case 'response.output_text.done':
// //       case 'response.text.done':
// //         if (typeof event.text === 'string' && event.text.trim()) {
// //           session.lastQuestionAsked = event.text.trim();
// //         }
// //         this.flushElevenLabsStream(sessionId);
// //         session.onEvent({ type: 'transcript-done', transcript: event.text });
// //         break;

// //       case 'input_audio_buffer.speech_started':
// //         session.silenceRepromptCount = 0;
// //         if (session.silenceTimer) {
// //           clearTimeout(session.silenceTimer);
// //           session.silenceTimer = null;
// //         }
// //         if (session.isResponseActive) {
// //           try {
// //             session.ws.send(JSON.stringify({ type: 'response.cancel' }));
// //           } catch (err) {
// //             this.logger.warn(`[${sessionId}] Cancel failed: ${err.message}`);
// //           }
// //         }
// //         this.closeElevenLabsWs(sessionId);
// //         this.openElevenLabsStream(sessionId, true);
// //         session.onEvent({ type: 'speech-started' });
// //         break;

// //       case 'conversation.item.input_audio_transcription.completed':
// //         session.onEvent({
// //           type: 'user-transcript',
// //           transcript: event.transcript,
// //         });
// //         break;

// //       case 'response.function_call_arguments.done':
// //         await this.handleFunctionCall(sessionId, event);
// //         break;

// //       case 'response.output_item.done': {
// //         const fn = this.toFunctionCallPayload((event as any).item);
// //         if (fn) await this.handleFunctionCall(sessionId, fn);
// //         break;
// //       }

// //       case 'error':
// //         this.logger.error(
// //           `[${sessionId}] OpenAI error: ${JSON.stringify(event.error)}`,
// //         );
// //         break;
// //     }
// //   }

// //   // ─── Function call dispatcher ────────────────────────────────────────────────

// //   private async handleFunctionCall(
// //     sessionId: string,
// //     event: FunctionCallPayload,
// //   ): Promise<void> {
// //     const session = this.sessions.get(sessionId);
// //     if (!session) return;

// //     const callId = event.call_id ?? null;
// //     if (callId && session.processedFunctionCallIds.has(callId)) {
// //       this.logger.debug(`[${sessionId}] Duplicate fn call ignored: ${callId}`);
// //       return;
// //     }
// //     if (callId) session.processedFunctionCallIds.add(callId);

// //     try {
// //       const args = JSON.parse(event.arguments);

// //       if (event.name === 'transfer_call') {
// //         await this.handleTransferCall(sessionId, args, event.call_id);
// //       } else if (event.name === 'save_lead') {
// //         await this.handleSaveLead(sessionId, args, event.call_id);
// //       } else if (event.name === 'answer_faq') {
// //         await this.handleAnswerFaq(sessionId, args, event.call_id);
// //       }
// //     } catch (err) {
// //       if (callId) session.processedFunctionCallIds.delete(callId);
// //       this.logger.error(`[${sessionId}] Function call error: ${err.message}`);
// //     }
// //   }

// //   // ─── transfer_call ───────────────────────────────────────────────────────────

// //   private async handleTransferCall(
// //     sessionId: string,
// //     args: any,
// //     callId: string,
// //   ): Promise<void> {
// //     const session = this.sessions.get(sessionId);
// //     if (!session) return;

// //     const eventType: EventType = args.event_type ?? 'unknown';
// //     session.detectedEventType = eventType;

// //     this.logger.log(
// //       `[${sessionId}] Transfer requested — event_type: ${eventType}`,
// //     );

// //     const transferTo = TRANSFER_NUMBERS[eventType];

// //     if (transferTo) {
// //       this.logger.log(`[${sessionId}] Transferring to ${transferTo}`);
// //       session.onEvent({
// //         type: 'transfer-initiated',
// //         data: {
// //           event_type: eventType,
// //           transfer_to: transferTo,
// //           caller_name: args.caller_name,
// //           caller_number: session.callerNumber,
// //         },
// //       });

// //       this._sendFunctionResult(sessionId, callId, {
// //         success: true,
// //         message: `Transferring to the right team now.`,
// //         transfer_to: transferTo,
// //       });
// //     } else {
// //       // Transfer number not configured — fall back to lead capture / voicemail
// //       this.logger.warn(
// //         `[${sessionId}] No transfer number for ${eventType} — saving lead instead`,
// //       );

// //       this._sendFunctionResult(sessionId, callId, {
// //         success: false,
// //         message:
// //           'Transfer unavailable right now — I will save your details and have the team call you back.',
// //       });
// //     }

// //     session.ws.send(JSON.stringify({ type: 'response.create' }));
// //   }

// //   // ─── save_lead ───────────────────────────────────────────────────────────────

// //   private async handleSaveLead(
// //     sessionId: string,
// //     args: any,
// //     callId: string,
// //   ): Promise<void> {
// //     const session = this.sessions.get(sessionId);
// //     if (!session) return;

// //     this.logger.log(
// //       `[${sessionId}] Saving lead for: ${args.caller_name} | ${args.event_type}`,
// //     );

// //     const lead = await this.leadModel.create({
// //       callerName: args.caller_name,
// //       callerNumber: args.caller_number || session.callerNumber,
// //       eventType: args.event_type,
// //       eventDate: args.event_date,
// //       groupSize: args.group_size,
// //       enquiryDetails: args.enquiry_details,
// //       callId: sessionId,
// //       source: 'voice_agent',
// //     });

// //     this.logger.log(`[${sessionId}] Lead saved: ${lead._id}`);

// //     // Push to ActiveCampaign (base URL: https://lemansGokarts.api-us1.com)
// //     try {
// //       await this.activeCampaign.createContact({
// //         firstName: args.caller_name,
// //         phone: args.caller_number || session.callerNumber,
// //         tag: args.event_type,
// //         fieldValues: [
// //           { field: 'EVENT_TYPE', value: args.event_type },
// //           { field: 'EVENT_DATE', value: args.event_date ?? '' },
// //           { field: 'GROUP_SIZE', value: String(args.group_size ?? '') },
// //           { field: 'ENQUIRY', value: args.enquiry_details ?? '' },
// //         ],
// //       });
// //       this.logger.log(`[${sessionId}] ActiveCampaign contact created`);
// //     } catch (err) {
// //       this.logger.warn(
// //         `[${sessionId}] ActiveCampaign push failed: ${err.message}`,
// //       );
// //     }

// //     this._sendFunctionResult(sessionId, callId, {
// //       success: true,
// //       message: 'Lead saved. Our team will be in touch soon.',
// //     });

// //     session.ws.send(JSON.stringify({ type: 'response.create' }));
// //     session.onEvent({ type: 'lead-saved', data: args });
// //   }

// //   // ─── answer_faq ──────────────────────────────────────────────────────────────

// //   private async handleAnswerFaq(
// //     sessionId: string,
// //     args: any,
// //     callId: string,
// //   ): Promise<void> {
// //     const session = this.sessions.get(sessionId);
// //     if (!session) return;

// //     const answer = this.resolveFaq(args.question_category);
// //     this.logger.log(
// //       `[${sessionId}] FAQ: ${args.question_category} → ${answer.substring(0, 80)}`,
// //     );

// //     this._sendFunctionResult(sessionId, callId, {
// //       success: true,
// //       answer,
// //     });

// //     session.ws.send(JSON.stringify({ type: 'response.create' }));
// //   }

// //   // ─── FAQ knowledge base ──────────────────────────────────────────────────────
// //   // Updated per Le Mans Entertainment onboarding document v1.0 (18/06/2026)

// //   private resolveFaq(category: string): string {
// //     const kb: Record<string, string> = {
// //       opening_hours:
// //         'Le Mans Entertainment is open Wednesday and Thursday from 4pm to 10pm, ' +
// //         'Friday from 11:15am to 11pm, Saturday from 9:15am to 11pm, and Sunday from 9:15am to 10pm. ' +
// //         'We are closed on Mondays and Tuesdays. ' +
// //         'Please note our hours do change during school holidays and seasonal holidays — ' +
// //         'it is always worth checking our website or giving us a call to confirm.',

// //       directions:
// //         'We are located at 55 Waterview Close, Dandenong South VIC 3175. ' +
// //         'Easiest access is via Frankston-Dandenong Road — head towards Dandenong South and ' +
// //         'follow the signs to Waterview Close. We are in the industrial precinct just off the main road. ' +
// //         'Pop the address into Google Maps and it will take you straight there!',

// //       parking:
// //         'We have free on-site parking with plenty of spaces available. ' +
// //         'There is also additional street parking on nearby roads if needed. ' +
// //         'Honestly parking is never really an issue — awesome, right?',

// //       kids_party:
// //         'Our kids party packages are super fun and epic — perfect for birthdays! ' +
// //         'Packages include go-karting, food, and a dedicated party host, with prices starting ' +
// //         'from a per-child rate and a minimum group size of around 10 kids. ' +
// //         'Weekends book out really fast — we recommend locking in a date at least 3 to 4 weeks ahead ' +
// //         'to avoid missing out. Our Birthday and Social Events team handles all the details to make sure ' +
// //         'it is a safe and awesome day for everyone.',

// //       buck_party:
// //         'Buck and hen party packages are absolutely epic — one of our most popular bookings! ' +
// //         'They typically include racing, drinks on arrival, and a trophy presentation. ' +
// //         'These genuinely sell out months in advance, especially Friday and Saturday nights. ' +
// //         'I would seriously recommend locking something in as soon as you can — ' +
// //         'our social events team will take care of everything to make it a fun and safe night to remember.',

// //       corporate:
// //         'Our corporate packages are fully customisable and awesome for team building — ' +
// //         'we do team days, client entertainment, product launches and more. ' +
// //         'Our dedicated Corporate Events Sales team handles these personally to tailor ' +
// //         'the experience to exactly what your company needs. ' +
// //         'I can put you straight through to them right now if you like!',

// //       pricing:
// //         'Pricing depends on the package and group size — we have awesome options across the board. ' +
// //         'Our team can put together an exact quote based on your requirements. ' +
// //         'Would you like me to connect you with someone who can go through the details with you?',

// //       booking:
// //         'You can book online via our website or our team can take your details and call you back to confirm. ' +
// //         'Weekend and peak times do sell out quickly — we always recommend booking as soon as you can ' +
// //         'to lock in your preferred date. Shall I grab your details and have someone call you back?',

// //       languages:
// //         'We are happy to assist you in English or Mandarin. ' +
// //         '我们也可以用普通话为您服务！Please let me know which language you prefer.',
// //     };

// //     return (
// //       kb[category] ??
// //       'That is a great question! Let me get the right person to help you with that — ' +
// //         'they will be able to give you the most accurate and awesome answer.'
// //     );
// //   }

// //   // ─── Helpers ─────────────────────────────────────────────────────────────────

// //   private _sendFunctionResult(
// //     sessionId: string,
// //     callId: string,
// //     output: object,
// //   ): void {
// //     const session = this.sessions.get(sessionId);
// //     if (!session || session.ws.readyState !== WebSocket.OPEN) return;

// //     session.ws.send(
// //       JSON.stringify({
// //         type: 'conversation.item.create',
// //         item: {
// //           type: 'function_call_output',
// //           call_id: callId,
// //           output: JSON.stringify(output),
// //         },
// //       }),
// //     );
// //   }

// //   // ─── Cleanup ─────────────────────────────────────────────────────────────────

// //   closeSession(sessionId: string): void {
// //     const session = this.sessions.get(sessionId);
// //     if (session) {
// //       this.closeElevenLabsWs(sessionId);
// //       try {
// //         session.ws.close();
// //       } catch {
// //         // already closed
// //       }
// //       this.sessions.delete(sessionId);
// //       this.logger.log(`[${sessionId}] Session closed`);
// //     }
// //   }

// //   // ─── WS instrumentation ──────────────────────────────────────────────────────

// //   private instrumentHandshake(
// //     sessionId: string,
// //     provider: 'OpenAI' | 'ElevenLabs',
// //     ws: WebSocket,
// //     startedAtMs: number,
// //   ): void {
// //     const wsWithReq = ws as WebSocket & { _req?: ClientRequest };
// //     const req = wsWithReq._req;
// //     if (!req) return;

// //     let attached = false;
// //     const attach = (socket: NetSocket): void => {
// //       if (attached) return;
// //       attached = true;
// //       socket.once('lookup', () =>
// //         this.logger.log(
// //           `[${sessionId}] ${provider} DNS lookup in ${Date.now() - startedAtMs}ms`,
// //         ),
// //       );
// //       socket.once('connect', () =>
// //         this.logger.log(
// //           `[${sessionId}] ${provider} TCP connect in ${Date.now() - startedAtMs}ms`,
// //         ),
// //       );
// //       (socket as TLSSocket).once('secureConnect', () =>
// //         this.logger.log(
// //           `[${sessionId}] ${provider} TLS handshake in ${Date.now() - startedAtMs}ms`,
// //         ),
// //       );
// //     };

// //     if (req.socket) attach(req.socket);
// //     req.once('socket', (s: NetSocket) => attach(s));
// //     ws.on('upgrade', () =>
// //       this.logger.log(
// //         `[${sessionId}] ${provider} WS upgrade in ${Date.now() - startedAtMs}ms`,
// //       ),
// //     );
// //   }

// //   // ─── System prompt ───────────────────────────────────────────────────────────

// //   private getSystemPrompt(): string {
// //     return `
// // =============================================================
// // ABSOLUTE RULE — LANGUAGE SUPPORT
// // =============================================================
// // You support TWO languages: English and Mandarin (Simplified Chinese).
// // Default to English. If the caller speaks Mandarin, switch fully to Mandarin
// // and maintain that language for the rest of the call.
// // If the caller uses any other language, respond only in English.
// // =============================================================

// // ### IDENTITY ###
// // You are Chloe — the bubbly, caring voice receptionist for Le Mans Entertainment Melbourne,
// // located at 55 Waterview Close, Dandenong South VIC 3175. Phone: (03) 8787 8741.
// // You answer the main enquiries line. You are warm, motherly, excited, empathetic, and optimistic —
// // like the most enthusiastic and caring person at the venue's front desk.

// // ### AI DISCLOSURE ###
// // Do NOT volunteer that you are AI.
// // ONLY if directly asked "are you a robot?" or "are you AI?" respond honestly:
// // "Yeah, I'm actually an AI assistant for Le Mans! I'll get you sorted just the same though — let's do this!"
// // Then pivot straight back to helping them.

// // ### PERSONALITY ###
// // - Bubbly, motherly, excited, caring, empathetic, optimistic — you genuinely love working at Le Mans
// // - Short sentences. 1–2 sentences per response.
// // - Natural filler: "yeah", "absolutely", "no worries", "for sure", "awesome", "epic"
// // - Key phrases to use naturally: "epic", "awesome", "fun", "safe"
// // - Match caller energy — excited with excited callers, reassuring with worried ones
// // - React genuinely before asking the next question — never go question-to-question robotically
// // - Be motherly and caring — especially with parents calling about kids parties

// // ### WHAT LE MANS IS ###
// // Le Mans Entertainment is a go-karting and entertainment venue in Melbourne, at Dandenong South.
// // They host kids birthday parties, buck/hen parties, corporate events, and general fun visits.
// // Weekend and peak times sell out fast — this is a genuine, honest fact to share warmly.

// // ### BUSINESS HOURS ###
// // Wednesday: 4:00pm – 10:00pm
// // Thursday: 4:00pm – 10:00pm
// // Friday: 11:15am – 11:00pm
// // Saturday: 9:15am – 11:00pm
// // Sunday: 9:15am – 10:00pm
// // Monday: CLOSED
// // Tuesday: CLOSED
// // Important: Hours change during school holidays and seasonal holidays.
// // Always advise callers to check the website or call ahead to confirm during holiday periods.

// // ### EVENT TYPE CLASSIFICATION (INTERNAL — NEVER ANNOUNCE) ###
// // Silently classify every call into one of:
// // - kids_party      — birthday party, kids entertainment, school groups → route to Birthday & Social Group Sales
// // - buck_party       — bucks night, hens night, bachelor/bachelorette → route to Birthday & Social Group Sales
// // - corporate        — corporate team building, client entertainment, company event → route to Corporate Events Sales
// // - general_enquiry  — pricing, hours, directions, parking, casual visit

// // CORPORATE CALLS: Detect IMMEDIATELY. Warm transfer straight away to Corporate Events Sales.
// // Do NOT ask lots of questions — just get their name and transfer.

// // ### CALL FLOW ###

// // STEP 1 — GREET
// // "Hi, thanks for calling Le Mans Entertainment! This is Chloe speaking — how can I help you today?"

// // STEP 2 — IDENTIFY INTENT
// // Let them tell you what they need. Listen and classify silently.
// // If a caller starts speaking Mandarin, switch to Mandarin immediately and naturally.

// // STEP 3a — BASIC QUESTION (hours, parking, directions, general)
// // → Call answer_faq with the appropriate question_category
// // → Answer naturally from the result — make it feel warm and conversational
// // → Check if they need anything else
// // → If they want to book/enquire further: get name + number + details → save_lead

// // STEP 3b — KIDS PARTY / BUCK PARTY enquiry
// // → Ask 2–3 natural questions to understand their needs:
// //   - Approx number of people / group size
// //   - Preferred date or timeframe
// //   - Any specific requests
// // → Mention genuinely that these book out fast: "Just so you know, weekends especially
// //   sell out pretty quickly — totally worth locking something in sooner rather than later!"
// // → Collect name and number
// // → Call save_lead to capture the enquiry
// // → Tell them the team will call back to confirm details — keep it warm and reassuring

// // STEP 3c — CORPORATE enquiry
// // → React warmly: "Oh awesome, a corporate event — we absolutely love those!"
// // → Get their name
// // → Say: "I'll put you straight through to our corporate team — they handle these personally
// //   and will make sure it's an epic experience for your whole team."
// // → Call transfer_call with event_type: "corporate"

// // STEP 3d — TRANSFER (any event type where transfer is appropriate)
// // → Call transfer_call with the correct event_type
// // → If transfer fails/unavailable: pivot to save_lead and assure caller the team will call back

// // STEP 4 — WRAP UP (if not transferred)
// // After saving lead: "Perfect, I've got all of that noted down — how exciting! Someone from our
// // team will give you a call back to go over everything and lock it all in for you.
// // Is there anything else I can help with?"

// // ### FALLBACK / VOICEMAIL ###
// // If a transfer cannot be completed for any reason, always fall back to save_lead.
// // Reassure the caller warmly: "No worries at all! I'll make sure our team gets your details
// // and gives you a call back as soon as possible."
// // Never leave a caller without their enquiry being captured.

// // ### URGENCY MESSAGING (IMPORTANT) ###
// // For kids parties and buck parties, weave in genuine urgency naturally and warmly:
// // - "Just giving you a heads up — weekend dates do fill up super fast, especially Saturdays!"
// // - "We'd definitely recommend locking in a date as soon as you can — it goes so quickly!"
// // - "Honestly these slots are so popular, Saturday nights especially — it is worth getting in early."
// // Only say it once per call. Keep it genuine and caring, never pushy.

// // ### OFF-TOPIC HANDLING ###
// // You ONLY handle Le Mans Entertainment enquiries.
// // For anything unrelated: "Ah sorry, I'm only set up for Le Mans enquiries! Is there
// // anything about the venue or our awesome events I can help you with?"

// // ### SILENCE HANDLING ###
// // If you receive a [SYSTEM: The user has been silent...] instruction:
// // Speak exactly what it says, naturally and conversationally. Do not add extra content.

// // ### MANDARIN CALLERS ###
// // If a caller speaks Mandarin at any point, respond fully in Mandarin for the remainder of the call.
// // Maintain your bubbly, caring Chloe personality in Mandarin.
// // All the same call flow rules apply — just in Mandarin.
// // Example Mandarin greeting if needed: "你好！感谢您致电Le Mans Entertainment！我是Chloe，请问有什么可以帮您？"

// // ### HARD RULES ###
// // - ONE question at a time
// // - 1–2 sentences per response max
// // - NEVER repeat the same transition twice in a call
// // - ALWAYS call save_lead OR transfer_call before ending — never end without one
// // - Corporate → transfer immediately to Corporate Events Sales
// // - Kids/Buck → Birthday & Social Group Sales (transfer or save_lead)
// // - No promises on specific callback times unless instructed
// // - Always be safe, fun, awesome — that is the Le Mans way
// // `;
// //   }

// //   // ─── Tool definitions ─────────────────────────────────────────────────────────

// //   private getTransferCallTool() {
// //     return {
// //       type: 'function',
// //       name: 'transfer_call',
// //       description:
// //         'Initiates a warm call transfer to the appropriate team based on the event type. ' +
// //         'Use immediately for corporate enquiries (Corporate Events Sales). ' +
// //         'Use for kids_party and buck_party to reach Birthday & Social Group Sales.',
// //       parameters: {
// //         type: 'object',
// //         properties: {
// //           event_type: {
// //             type: 'string',
// //             enum: ['kids_party', 'buck_party', 'corporate', 'general_enquiry'],
// //             description: 'The type of enquiry/event detected',
// //           },
// //           caller_name: {
// //             type: 'string',
// //             description: "Caller's name if collected",
// //           },
// //           transfer_reason: {
// //             type: 'string',
// //             description: 'Brief reason for the transfer',
// //           },
// //         },
// //         required: ['event_type'],
// //       },
// //     };
// //   }

// //   private getSaveLeadTool() {
// //     return {
// //       type: 'function',
// //       name: 'save_lead',
// //       description:
// //         'Saves caller enquiry details to the database and sends to ActiveCampaign ' +
// //         '(account: lemansGokarts.api-us1.com). ' +
// //         'Call this when a transfer is not possible, when a non-corporate caller wants a callback, ' +
// //         'or as the voicemail/fallback when a live transfer cannot be completed.',
// //       parameters: {
// //         type: 'object',
// //         properties: {
// //           caller_name: { type: 'string', description: "Caller's name" },
// //           caller_number: {
// //             type: 'string',
// //             description: "Caller's phone number",
// //           },
// //           event_type: {
// //             type: 'string',
// //             enum: [
// //               'kids_party',
// //               'buck_party',
// //               'corporate',
// //               'general_enquiry',
// //               'unknown',
// //             ],
// //           },
// //           event_date: {
// //             type: 'string',
// //             description: 'Preferred date or timeframe',
// //           },
// //           group_size: { type: 'number', description: 'Approximate group size' },
// //           enquiry_details: {
// //             type: 'string',
// //             description:
// //               'Full details of the enquiry including everything discussed',
// //           },
// //           preferred_language: {
// //             type: 'string',
// //             enum: ['english', 'mandarin'],
// //             description: "Caller's preferred language if identified",
// //           },
// //         },
// //         required: ['caller_name', 'event_type', 'enquiry_details'],
// //       },
// //     };
// //   }

// //   private getAnswerFaqTool() {
// //     return {
// //       type: 'function',
// //       name: 'answer_faq',
// //       description:
// //         'Retrieves the answer to a common FAQ about Le Mans Entertainment from the knowledge base.',
// //       parameters: {
// //         type: 'object',
// //         properties: {
// //           question_category: {
// //             type: 'string',
// //             enum: [
// //               'opening_hours',
// //               'directions',
// //               'parking',
// //               'kids_party',
// //               'buck_party',
// //               'corporate',
// //               'pricing',
// //               'booking',
// //               'languages',
// //             ],
// //             description: 'The category of the FAQ question',
// //           },
// //         },
// //         required: ['question_category'],
// //       },
// //     };
// //   }
// // }
// import { Injectable, Logger } from '@nestjs/common';
// import { ConfigService } from '@nestjs/config';
// import { InjectModel } from '@nestjs/mongoose';
// import { ClientRequest } from 'http';
// import { Model } from 'mongoose';
// import { Socket as NetSocket } from 'net';
// import { TLSSocket } from 'tls';
// import WebSocket from 'ws';
// import { Lead, LeadDocument } from './schemas/lead.schema';
// import { ActiveCampaignService } from '../integrations/active-campaign.service';

// // ─── Types ────────────────────────────────────────────────────────────────────

// export type EventType =
//   | 'kids_party'
//   | 'buck_party'
//   | 'corporate'
//   | 'general_enquiry'
//   | 'unknown';

// interface RealtimeSession {
//   ws: WebSocket;
//   elevenLabsWs: WebSocket | null;
//   elevenLabsReady: boolean;
//   textBuffer: string[];
//   isResponseActive: boolean;
//   onEvent: (event: any) => void;
//   sessionStartedAtMs: number;
//   openAiConnectedAtMs: number | null;
//   elevenLabsConnectedAtMs: number | null;
//   greetingTriggeredAtMs: number | null;
//   firstResponseCreatedAtMs: number | null;
//   firstAudioDeltaLogged: boolean;
//   processedFunctionCallIds: Set<string>;
//   lastQuestionAsked: string;
//   // Tracks the last genuine AI response text, never the reprompt wrapper.
//   // Used by _buildSilenceReprompt so the prefix never gets baked into itself.
//   lastRealAnswer: string;
//   isRepromptActive: boolean;
//   silenceRepromptCount: number;
//   detectedEventType: EventType;
//   callerNumber: string;
//   preferredLanguage: 'english' | 'mandarin';
//   silenceTimer: ReturnType<typeof setTimeout> | null;
// }

// interface FunctionCallPayload {
//   name: string;
//   arguments: string;
//   call_id: string;
// }

// // Transfer number map — populate from env or hardcode for POC
// const TRANSFER_NUMBERS: Record<EventType, string | null> = {
//   kids_party: process.env.TRANSFER_KIDS_PARTY ?? null,       // Birthday & Social Group Sales
//   buck_party: process.env.TRANSFER_BUCK_PARTY ?? null,       // Birthday & Social Group Sales
//   corporate: process.env.TRANSFER_CORPORATE ?? null,         // Corporate Events Sales
//   general_enquiry: process.env.TRANSFER_GENERAL ?? null,
//   unknown: process.env.TRANSFER_GENERAL ?? null,
// };

// // ─── Business Hours ──────────────────────────────────────────────────────────
// // Le Mans Entertainment — 55 Waterview Cl, Dandenong South VIC 3175
// // Mon: Closed | Tue: Closed | Wed: 4:00pm–10:00pm | Thu: 4:00pm–10:00pm
// // Fri: 11:15am–11:00pm | Sat: 9:15am–11:00pm | Sun: 9:15am–10:00pm
// // Note: Hours change during school holidays and seasonal holidays.

// @Injectable()
// export class VoiceService {
//   private readonly logger = new Logger(VoiceService.name);
//   private sessions = new Map<string, RealtimeSession>();
//   private readonly MAX_SILENCE_REPROMPTS = 2;

//   constructor(
//     private readonly config: ConfigService,
//     @InjectModel(Lead.name)
//     private readonly leadModel: Model<LeadDocument>,
//     private readonly activeCampaign: ActiveCampaignService,
//   ) {}

//   // ─── Type guard ─────────────────────────────────────────────────────────────

//   private toFunctionCallPayload(value: unknown): FunctionCallPayload | null {
//     if (!value || typeof value !== 'object') return null;
//     const r = value as Record<string, unknown>;
//     if (r.type !== 'function_call') return null;
//     if (
//       typeof r.name !== 'string' ||
//       typeof r.arguments !== 'string' ||
//       typeof r.call_id !== 'string'
//     )
//       return null;
//     return { name: r.name, arguments: r.arguments, call_id: r.call_id };
//   }

//   // ─── Silence handling ────────────────────────────────────────────────────────

//   handleSilenceTimeout(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     if (session.isResponseActive) {
//       this.logger.debug(
//         `[${sessionId}] Silence ignored — response still active`,
//       );
//       return;
//     }

//     session.silenceRepromptCount += 1;

//     if (session.silenceRepromptCount > this.MAX_SILENCE_REPROMPTS) {
//       this.logger.log(
//         `[${sessionId}] Max silence re-prompts reached — closing politely`,
//       );
//       this._injectAndRespond(
//         sessionId,
//         "It seems like you might have stepped away. No worries — feel free to call back whenever you're ready. Thanks for calling LeMans Entertainment, take care!",
//       );
//       setTimeout(() => this.closeSession(sessionId), 8_000);
//       return;
//     }

//     const reprompt = this._buildSilenceReprompt(session);
//     this.logger.log(
//       `[${sessionId}] Silence #${session.silenceRepromptCount} — re-prompting: "${reprompt}"`,
//     );
//     this._injectAndRespond(sessionId, reprompt);
//   }

//   handlePlaybackDone(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     if (session.silenceTimer) {
//       clearTimeout(session.silenceTimer);
//       session.silenceTimer = null;
//     }

//     if (session.isResponseActive) return;

//     const SILENCE_TIMEOUT_MS = 8_000;
//     session.silenceTimer = setTimeout(() => {
//       this.handleSilenceTimeout(sessionId);
//     }, SILENCE_TIMEOUT_MS);

//     this.logger.debug(`[${sessionId}] Silence countdown started (${SILENCE_TIMEOUT_MS}ms)`);
//   }

//   private _buildSilenceReprompt(session: RealtimeSession): string {
//     const last = session.lastRealAnswer?.trim();
//     if (!last) {
//       return "I guess you didn't hear that — are you still there?";
//     }
//     return `I guess you didn't hear that, let me repeat my question. ${last}`;
//   }

//   private _injectAndRespond(sessionId: string, text: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session || session.ws.readyState !== WebSocket.OPEN) return;

//     // Flag so the response.output_text.done handler doesn't overwrite lastRealAnswer
//     // with the reprompt text (which would cause the prefix to snowball on next silence).
//     session.isRepromptActive = true;

//     session.ws.send(
//       JSON.stringify({
//         type: 'conversation.item.create',
//         item: {
//           type: 'message',
//           role: 'user',
//           content: [
//             {
//               type: 'input_text',
//               text: `[SYSTEM: The user has been silent. Re-engage by saying exactly this, naturally: "${text}"]`,
//             },
//           ],
//         },
//       }),
//     );
//     session.ws.send(JSON.stringify({ type: 'response.create' }));
//   }

//   // ─── Create session ──────────────────────────────────────────────────────────

//   async createRealtimeSession(
//     sessionId: string,
//     onEvent: (event: any) => void,
//     callerNumber = 'unknown',
//   ): Promise<void> {
//     const apiKey = this.config.get<string>('OPENAI_API_KEY');
//     const model =
//       this.config.get<string>('OPENAI_REALTIME_MODEL') ?? 'gpt-realtime-2';
//     const inputSampleRate = Number(
//       this.config.get<string>('OPENAI_INPUT_SAMPLE_RATE') ?? 24000,
//     );
//     const vadThreshold = Number(
//       this.config.get<string>('OPENAI_VAD_THRESHOLD') ?? 0.8,
//     );
//     const vadPrefixPaddingMs = Number(
//       this.config.get<string>('OPENAI_VAD_PREFIX_PADDING_MS') ?? 300,
//     );
//     const vadSilenceDurationMs = Number(
//       this.config.get<string>('OPENAI_VAD_SILENCE_DURATION_MS') ?? 2000,
//     );
//     const url = `wss://api.openai.com/v1/realtime?model=${model}`;
//     const sessionStartedAtMs = Date.now();

//     return new Promise((resolve, reject) => {
//       const ws = new WebSocket(url, {
//         headers: {
//           Authorization: `Bearer ${apiKey}`,
//         },
//       });

//       this.instrumentHandshake(sessionId, 'OpenAI', ws, sessionStartedAtMs);

//       ws.on('open', () => {
//         const openAiConnectedAtMs = Date.now();
//         this.logger.log(
//           `[${sessionId}] OpenAI connected in ${openAiConnectedAtMs - sessionStartedAtMs}ms`,
//         );

//         ws.send(
//           JSON.stringify({
//             type: 'session.update',
//             session: {
//               type: 'realtime',
//               model,
//               output_modalities: ['text'],
//               audio: {
//                 input: {
//                   format: {
//                     type: 'audio/pcm',
//                     rate: inputSampleRate,
//                   },
//                   turn_detection: {
//                     type: 'server_vad',
//                     threshold: vadThreshold,
//                     prefix_padding_ms: vadPrefixPaddingMs,
//                     silence_duration_ms: vadSilenceDurationMs,
//                   },
//                 },
//               },
//               instructions: this.getSystemPrompt(),
//               // answer_faq removed — all FAQ knowledge is now inlined in the system prompt
//               // so the model replies directly without a tool-call round-trip
//               tools: [
//                 this.getTransferCallTool(),
//                 this.getSaveLeadTool(),
//               ],
//               tool_choice: 'auto',
//             },
//           }),
//         );

//         this.sessions.set(sessionId, {
//           ws,
//           elevenLabsWs: null,
//           elevenLabsReady: false,
//           textBuffer: [],
//           isResponseActive: false,
//           onEvent,
//           sessionStartedAtMs,
//           openAiConnectedAtMs,
//           elevenLabsConnectedAtMs: null,
//           greetingTriggeredAtMs: null,
//           firstResponseCreatedAtMs: null,
//           firstAudioDeltaLogged: false,
//           processedFunctionCallIds: new Set(),
//           lastQuestionAsked: '',
//           lastRealAnswer: '',
//           isRepromptActive: false,
//           silenceRepromptCount: 0,
//           detectedEventType: 'unknown',
//           callerNumber,
//           preferredLanguage: 'english',
//           silenceTimer: null,
//         });

//         this.openElevenLabsStream(sessionId);
//         resolve();
//       });

//       ws.on('message', async (data: WebSocket.Data) => {
//         try {
//           const event = JSON.parse(data.toString());
//           await this.handleRealtimeEvent(sessionId, event);
//         } catch (err) {
//           this.logger.error(`[${sessionId}] Failed to parse event:`, err);
//         }
//       });

//       ws.on('error', (err) => {
//         this.logger.error(`[${sessionId}] OpenAI WS error:`, err);
//         onEvent({ type: 'error', error: { message: err.message } });
//         reject(err);
//       });

//       ws.on('close', (code, reason) => {
//         this.logger.log(
//           `[${sessionId}] OpenAI WS closed: ${code} - ${reason}`,
//         );
//         this.closeElevenLabsWs(sessionId);
//         this.sessions.delete(sessionId);
//         onEvent({ type: 'session-closed' });
//       });
//     });
//   }

//   // ─── Send audio ──────────────────────────────────────────────────────────────

//   sendAudio(sessionId: string, base64Audio: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;
//     session.ws.send(
//       JSON.stringify({ type: 'input_audio_buffer.append', audio: base64Audio }),
//     );
//   }

//   // ─── Trigger greeting ────────────────────────────────────────────────────────

//   triggerGreeting(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;
//     session.greetingTriggeredAtMs = Date.now();
//     session.ws.send(JSON.stringify({ type: 'response.create' }));
//   }

//   // ─── ElevenLabs stream ───────────────────────────────────────────────────────

//   private openElevenLabsStream(sessionId: string, force = false): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     if (
//       !force &&
//       session.elevenLabsWs &&
//       (session.elevenLabsWs.readyState === WebSocket.OPEN ||
//         session.elevenLabsWs.readyState === WebSocket.CONNECTING)
//     ) {
//       return;
//     }

//     this.closeElevenLabsWs(sessionId);

//     const apiKey = this.config.get<string>('ELEVENLABS_API_KEY');
//     const voiceId = this.config.get<string>('ELEVENLABS_VOICE_ID');
//     const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_multilingual_v2&output_format=pcm_16000`;

//     const elWs = new WebSocket(wsUrl);
//     this.instrumentHandshake(
//       sessionId,
//       'ElevenLabs',
//       elWs,
//       session.sessionStartedAtMs,
//     );

//     elWs.on('open', () => {
//       this.logger.log(`[${sessionId}] ElevenLabs connected`);
//       session.elevenLabsConnectedAtMs = Date.now();

//       elWs.send(
//         JSON.stringify({
//           text: ' ',
//           voice_settings: {
//             stability: 0.55,
//             similarity_boost: 0.78,
//             style: 0.35,
//             use_speaker_boost: true,
//           },
//           xi_api_key: apiKey,
//         }),
//       );

//       if (session.elevenLabsWs === elWs) {
//         session.elevenLabsReady = true;
//         for (const text of session.textBuffer) {
//           this.sendTextToElevenLabs(sessionId, text);
//         }
//         session.textBuffer = [];
//       }
//     });

//     elWs.on('message', (data: WebSocket.Data) => {
//       try {
//         const msg = JSON.parse(data.toString());
//         if (msg.audio) {
//           if (!session.firstAudioDeltaLogged) {
//             session.firstAudioDeltaLogged = true;
//             this.logger.log(
//               `[${sessionId}] First audio at ${Date.now() - session.sessionStartedAtMs}ms`,
//             );
//           }
//           session.onEvent({ type: 'audio-delta', delta: msg.audio });
//         }
//         if (msg.isFinal === true) {
//           session.onEvent({ type: 'audio-done' });
//         }
//       } catch {
//         // binary frames — ignore
//       }
//     });

//     elWs.on('error', (err) => {
//       this.logger.warn(`[${sessionId}] ElevenLabs WS error: ${err.message}`);
//     });

//     elWs.on('close', () => {
//       if (session.elevenLabsWs === elWs) {
//         session.elevenLabsReady = false;
//       }
//     });

//     session.elevenLabsWs = elWs;
//   }

//   private sendTextToElevenLabs(sessionId: string, text: string): void {
//     const session = this.sessions.get(sessionId);
//     if (session?.elevenLabsWs?.readyState === WebSocket.OPEN) {
//       session.elevenLabsWs.send(
//         JSON.stringify({ text, try_trigger_generation: true }),
//       );
//     }
//   }

//   private flushElevenLabsStream(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (session?.elevenLabsWs?.readyState === WebSocket.OPEN) {
//       session.elevenLabsWs.send(JSON.stringify({ text: '' }));
//     }
//   }

//   private closeElevenLabsWs(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session?.elevenLabsWs) return;
//     try {
//       if (session.elevenLabsWs.readyState === WebSocket.CONNECTING) {
//         session.elevenLabsWs.terminate();
//       } else if (session.elevenLabsWs.readyState === WebSocket.OPEN) {
//         session.elevenLabsWs.close();
//       }
//     } catch (err) {
//       this.logger.warn(
//         `[${sessionId}] Error closing ElevenLabs WS: ${err.message}`,
//       );
//     }
//     session.elevenLabsWs = null;
//     session.elevenLabsReady = false;
//     session.textBuffer = [];
//   }

//   // ─── Event hub ───────────────────────────────────────────────────────────────

//   private async handleRealtimeEvent(
//     sessionId: string,
//     event: any,
//   ): Promise<void> {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     this.logger.debug(`[${sessionId}] Event: ${event.type}`);

//     switch (event.type) {
//       case 'response.created':
//         session.isResponseActive = true;
//         session.silenceRepromptCount = 0;
//         if (!session.firstResponseCreatedAtMs) {
//           session.firstResponseCreatedAtMs = Date.now();
//         }
//         this.openElevenLabsStream(sessionId);
//         break;

//       case 'response.done': {
//         session.isResponseActive = false;
//         const outputs = (event as any).response?.output;
//         if (Array.isArray(outputs)) {
//           for (const item of outputs) {
//             const fn = this.toFunctionCallPayload(item);
//             if (fn) await this.handleFunctionCall(sessionId, fn);
//           }
//         }
//         break;
//       }

//       case 'response.output_text.delta':
//       case 'response.text.delta':
//         if (session.elevenLabsReady) {
//           this.sendTextToElevenLabs(sessionId, event.delta);
//         } else {
//           session.textBuffer.push(event.delta);
//         }
//         session.onEvent({ type: 'transcript-delta', delta: event.delta });
//         break;

//       case 'response.output_text.done':
//       case 'response.text.done':
//         if (typeof event.text === 'string' && event.text.trim()) {
//           // Always update lastQuestionAsked (used for logging / transcript)
//           session.lastQuestionAsked = event.text.trim();
//           // Only update lastRealAnswer from genuine AI turns, not injected reprompts.
//           // This prevents the "I guess you didn't hear that..." prefix from being stored
//           // and then prepended again on the next silence, causing the snowball effect.
//           if (!session.isRepromptActive) {
//             session.lastRealAnswer = event.text.trim();
//           }
//         }
//         // Clear the flag regardless — the reprompt turn is now complete.
//         session.isRepromptActive = false;
//         this.flushElevenLabsStream(sessionId);
//         session.onEvent({ type: 'transcript-done', transcript: event.text });
//         break;

//       case 'input_audio_buffer.speech_started':
//         session.silenceRepromptCount = 0;
//         session.isRepromptActive = false;
//         if (session.silenceTimer) {
//           clearTimeout(session.silenceTimer);
//           session.silenceTimer = null;
//         }
//         if (session.isResponseActive) {
//           try {
//             session.ws.send(JSON.stringify({ type: 'response.cancel' }));
//           } catch (err) {
//             this.logger.warn(`[${sessionId}] Cancel failed: ${err.message}`);
//           }
//         }
//         this.closeElevenLabsWs(sessionId);
//         this.openElevenLabsStream(sessionId, true);
//         session.onEvent({ type: 'speech-started' });
//         break;

//       case 'conversation.item.input_audio_transcription.completed':
//         session.onEvent({
//           type: 'user-transcript',
//           transcript: event.transcript,
//         });
//         break;

//       case 'response.function_call_arguments.done':
//         await this.handleFunctionCall(sessionId, event);
//         break;

//       case 'response.output_item.done': {
//         const fn = this.toFunctionCallPayload((event as any).item);
//         if (fn) await this.handleFunctionCall(sessionId, fn);
//         break;
//       }

//       case 'error':
//         this.logger.error(
//           `[${sessionId}] OpenAI error: ${JSON.stringify(event.error)}`,
//         );
//         break;
//     }
//   }

//   // ─── Function call dispatcher ────────────────────────────────────────────────

//   private async handleFunctionCall(
//     sessionId: string,
//     event: FunctionCallPayload,
//   ): Promise<void> {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     const callId = event.call_id ?? null;
//     if (callId && session.processedFunctionCallIds.has(callId)) {
//       this.logger.debug(`[${sessionId}] Duplicate fn call ignored: ${callId}`);
//       return;
//     }
//     if (callId) session.processedFunctionCallIds.add(callId);

//     try {
//       const args = JSON.parse(event.arguments);

//       if (event.name === 'transfer_call') {
//         await this.handleTransferCall(sessionId, args, event.call_id);
//       } else if (event.name === 'save_lead') {
//         await this.handleSaveLead(sessionId, args, event.call_id);
//       }
//     } catch (err) {
//       if (callId) session.processedFunctionCallIds.delete(callId);
//       this.logger.error(`[${sessionId}] Function call error: ${err.message}`);
//     }
//   }

//   // ─── transfer_call ───────────────────────────────────────────────────────────

//   private async handleTransferCall(
//     sessionId: string,
//     args: any,
//     callId: string,
//   ): Promise<void> {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     const eventType: EventType = args.event_type ?? 'unknown';
//     session.detectedEventType = eventType;

//     this.logger.log(
//       `[${sessionId}] Transfer requested — event_type: ${eventType}`,
//     );

//     const transferTo = TRANSFER_NUMBERS[eventType];

//     if (transferTo) {
//       this.logger.log(`[${sessionId}] Transferring to ${transferTo}`);
//       session.onEvent({
//         type: 'transfer-initiated',
//         data: {
//           event_type: eventType,
//           transfer_to: transferTo,
//           caller_name: args.caller_name,
//           caller_number: session.callerNumber,
//         },
//       });

//       this._sendFunctionResult(sessionId, callId, {
//         success: true,
//         message: `Transferring to the right team now.`,
//         transfer_to: transferTo,
//       });
//     } else {
//       this.logger.warn(
//         `[${sessionId}] No transfer number for ${eventType} — saving lead instead`,
//       );

//       this._sendFunctionResult(sessionId, callId, {
//         success: false,
//         message:
//           'Transfer unavailable right now — I will save your details and have the team call you back.',
//       });
//     }

//     session.ws.send(JSON.stringify({ type: 'response.create' }));
//   }

//   // ─── save_lead ───────────────────────────────────────────────────────────────

//   private async handleSaveLead(
//     sessionId: string,
//     args: any,
//     callId: string,
//   ): Promise<void> {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     this.logger.log(
//       `[${sessionId}] Saving lead for: ${args.caller_name} | ${args.event_type}`,
//     );

//     const lead = await this.leadModel.create({
//       callerName: args.caller_name,
//       callerNumber: args.caller_number || session.callerNumber,
//       eventType: args.event_type,
//       eventDate: args.event_date,
//       groupSize: args.group_size,
//       enquiryDetails: args.enquiry_details,
//       callId: sessionId,
//       source: 'voice_agent',
//     });

//     this.logger.log(`[${sessionId}] Lead saved: ${lead._id}`);

//     try {
//       await this.activeCampaign.createContact({
//         firstName: args.caller_name,
//         phone: args.caller_number || session.callerNumber,
//         tag: args.event_type,
//         fieldValues: [
//           { field: 'EVENT_TYPE', value: args.event_type },
//           { field: 'EVENT_DATE', value: args.event_date ?? '' },
//           { field: 'GROUP_SIZE', value: String(args.group_size ?? '') },
//           { field: 'ENQUIRY', value: args.enquiry_details ?? '' },
//         ],
//       });
//       this.logger.log(`[${sessionId}] ActiveCampaign contact created`);
//     } catch (err) {
//       this.logger.warn(
//         `[${sessionId}] ActiveCampaign push failed: ${err.message}`,
//       );
//     }

//     this._sendFunctionResult(sessionId, callId, {
//       success: true,
//       message: 'Lead saved. Our team will be in touch soon.',
//     });

//     session.ws.send(JSON.stringify({ type: 'response.create' }));
//     session.onEvent({ type: 'lead-saved', data: args });
//   }

//   // ─── Helpers ─────────────────────────────────────────────────────────────────

//   private _sendFunctionResult(
//     sessionId: string,
//     callId: string,
//     output: object,
//   ): void {
//     const session = this.sessions.get(sessionId);
//     if (!session || session.ws.readyState !== WebSocket.OPEN) return;

//     session.ws.send(
//       JSON.stringify({
//         type: 'conversation.item.create',
//         item: {
//           type: 'function_call_output',
//           call_id: callId,
//           output: JSON.stringify(output),
//         },
//       }),
//     );
//   }

//   // ─── Cleanup ─────────────────────────────────────────────────────────────────

//   closeSession(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (session) {
//       this.closeElevenLabsWs(sessionId);
//       try {
//         session.ws.close();
//       } catch {
//         // already closed
//       }
//       this.sessions.delete(sessionId);
//       this.logger.log(`[${sessionId}] Session closed`);
//     }
//   }

//   // ─── WS instrumentation ──────────────────────────────────────────────────────

//   private instrumentHandshake(
//     sessionId: string,
//     provider: 'OpenAI' | 'ElevenLabs',
//     ws: WebSocket,
//     startedAtMs: number,
//   ): void {
//     const wsWithReq = ws as WebSocket & { _req?: ClientRequest };
//     const req = wsWithReq._req;
//     if (!req) return;

//     let attached = false;
//     const attach = (socket: NetSocket): void => {
//       if (attached) return;
//       attached = true;
//       socket.once('lookup', () =>
//         this.logger.log(
//           `[${sessionId}] ${provider} DNS lookup in ${Date.now() - startedAtMs}ms`,
//         ),
//       );
//       socket.once('connect', () =>
//         this.logger.log(
//           `[${sessionId}] ${provider} TCP connect in ${Date.now() - startedAtMs}ms`,
//         ),
//       );
//       (socket as TLSSocket).once('secureConnect', () =>
//         this.logger.log(
//           `[${sessionId}] ${provider} TLS handshake in ${Date.now() - startedAtMs}ms`,
//         ),
//       );
//     };

//     if (req.socket) attach(req.socket);
//     req.once('socket', (s: NetSocket) => attach(s));
//     ws.on('upgrade', () =>
//       this.logger.log(
//         `[${sessionId}] ${provider} WS upgrade in ${Date.now() - startedAtMs}ms`,
//       ),
//     );
//   }

//   // ─── System prompt ───────────────────────────────────────────────────────────

//   private getSystemPrompt(): string {
//     return `
// =============================================================
// ABSOLUTE RULE — LANGUAGE SUPPORT
// =============================================================
// You support TWO languages: English and Mandarin (Simplified Chinese).
// Default to English. If the caller speaks Mandarin, switch fully to Mandarin
// and maintain that language for the rest of the call.
// If the caller uses any other language, respond only in English.
// =============================================================

// ### IDENTITY ###
// You are Chloe — the bubbly, caring voice receptionist for Le Mans Entertainment Melbourne,
// located at 55 Waterview Close, Dandenong South VIC 3175. Phone: (03) 8787 8741.
// You answer the main enquiries line. You are warm, motherly, excited, empathetic, and optimistic —
// like the most enthusiastic and caring person at the venue's front desk.

// ### AI DISCLOSURE ###
// Do NOT volunteer that you are AI.
// ONLY if directly asked "are you a robot?" or "are you AI?" respond honestly:
// "Yeah, I'm actually an AI assistant for Le Mans! I'll get you sorted just the same though — let's do this!"
// Then pivot straight back to helping them.

// ### PERSONALITY ###
// - Bubbly, motherly, excited, caring, empathetic, optimistic — you genuinely love working at Le Mans
// - Short sentences. 1–2 sentences per response.
// - Natural filler: "yeah", "absolutely", "no worries", "for sure", "awesome", "epic"
// - Key phrases to use naturally: "epic", "awesome", "fun", "safe"
// - Match caller energy — excited with excited callers, reassuring with worried ones
// - React genuinely before asking the next question — never go question-to-question robotically
// - Be motherly and caring — especially with parents calling about kids parties

// ### WHAT LE MANS IS ###
// Le Mans Entertainment is a go-karting and entertainment venue in Melbourne, at Dandenong South.
// They host kids birthday parties, buck/hen parties, corporate events, and general fun visits.
// Weekend and peak times sell out fast — this is a genuine, honest fact to share warmly.

// =============================================================
// KNOWLEDGE BASE — ANSWER THESE DIRECTLY WITHOUT ANY TOOL CALL
// =============================================================
// You have ALL the answers below memorised. When a caller asks about any of these topics,
// speak the answer IMMEDIATELY and naturally — do NOT call any tool, do NOT say
// "let me grab that for you" or "I'll just check that" first.
// Just answer straight away, like you know it off the top of your head.

// OPENING HOURS:
//   Wednesday: 4:00pm – 10:00pm
//   Thursday:  4:00pm – 10:00pm
//   Friday:    11:15am – 11:00pm
//   Saturday:  9:15am – 11:00pm
//   Sunday:    9:15am – 10:00pm
//   Monday:    CLOSED
//   Tuesday:   CLOSED
//   Important: Hours change during school holidays and seasonal holidays —
//   always mention it's worth checking the website or calling ahead to confirm.
//   Example response: "Yeah, absolutely — we're open Wed–Thu 4pm–10pm, Fri 11:15am–11pm,
//   Sat 9:15am–11pm, and Sun 9:15am–10pm, and we're closed Mon–Tue.
//   Hours can change during school holidays though, so always good to double-check on the website!"

// LOCATION / DIRECTIONS:
//   Address: 55 Waterview Close, Dandenong South VIC 3175.
//   Getting there: Easiest via Frankston-Dandenong Road — head towards Dandenong South and
//   follow the signs to Waterview Close. It's in the industrial precinct just off the main road.
//   Google Maps will take you straight there.
//   Example response: "We're at 55 Waterview Close, Dandenong South — just off
//   Frankston-Dandenong Road, and honestly Google Maps takes you straight there, super easy!"

// PARKING:
//   Free on-site parking with plenty of spaces. Additional street parking on nearby roads.
//   Example response: "Yeah we've got free on-site parking — heaps of spaces, it's never really an issue!"

// KIDS PARTIES:
//   Super fun packages for birthdays — includes go-karting, food, and a dedicated party host.
//   Prices from a per-child rate, minimum ~10 kids.
//   Weekends book out 3–4 weeks ahead — recommend locking in early.
//   Birthday & Social Events team handles all the details.
//   Example: "Oh how exciting, a kids party — they are absolutely epic here!
//   We've got awesome packages with karting, food and a dedicated host.
//   Weekends do fill up fast though, usually 3–4 weeks ahead, so the sooner the better!"

// BUCK / HEN PARTIES:
//   Racing, drinks on arrival, trophy presentation.
//   Sell out months in advance especially Fri/Sat nights.
//   Example: "Buck parties here are absolutely legendary — racing, drinks, trophy presentation, the lot!
//   Fair warning though, Friday and Saturday nights book out months ahead, so lock it in ASAP!"

// CORPORATE EVENTS:
//   Fully customisable — team days, client entertainment, product launches.
//   Dedicated Corporate Events Sales team.
//   Example: "Oh awesome, a corporate event — we love those!
//   Our corporate team handles everything personally to tailor it to exactly what you need.
//   I can put you straight through to them right now!"

// PRICING:
//   Depends on package and group size. Team can give an exact quote.
//   Example: "Pricing varies depending on the package and group — our team can put together
//   an exact quote for you. Want me to grab your details and have someone call you back?"

// BOOKING:
//   Book online via website, or team calls back to confirm.
//   Weekends sell out fast — book ASAP.
//   Example: "You can book online, or I can grab your details and have the team call you back to lock it in.
//   Weekends go fast so the sooner the better!"

// LANGUAGES:
//   English and Mandarin supported.
//   Example: "We're happy to help in English or Mandarin — 我们也可以用普通话为您服务！"
// =============================================================

// ### EVENT TYPE CLASSIFICATION (INTERNAL — NEVER ANNOUNCE) ###
// Silently classify every call into one of:
// - kids_party      — birthday party, kids entertainment, school groups → route to Birthday & Social Group Sales
// - buck_party       — bucks night, hens night, bachelor/bachelorette → route to Birthday & Social Group Sales
// - corporate        — corporate team building, client entertainment, company event → route to Corporate Events Sales
// - general_enquiry  — pricing, hours, directions, parking, casual visit

// CORPORATE CALLS: Detect IMMEDIATELY. Warm transfer straight away to Corporate Events Sales.
// Do NOT ask lots of questions — just get their name and transfer.

// ### CALL FLOW ###

// STEP 1 — GREET
// "Hi, thanks for calling Le Mans Entertainment! This is Chloe speaking — how can I help you today?"

// STEP 2 — IDENTIFY INTENT
// Let them tell you what they need. Listen and classify silently.
// If a caller starts speaking Mandarin, switch to Mandarin immediately and naturally.

// STEP 3a — BASIC QUESTION (hours, parking, directions, general)
// → Answer IMMEDIATELY from your knowledge base above — no tool call, no preamble
// → Keep it warm and conversational
// → Check if they need anything else
// → If they want to book/enquire further: get name + number + details → save_lead

// STEP 3b — KIDS PARTY / BUCK PARTY enquiry
// → Answer any questions immediately from your knowledge base
// → Ask 2–3 natural questions to understand their needs:
//   - Approx number of people / group size
//   - Preferred date or timeframe
//   - Any specific requests
// → Mention genuinely that these book out fast
// → Collect name and number
// → Call save_lead to capture the enquiry
// → Tell them the team will call back to confirm details

// STEP 3c — CORPORATE enquiry
// → React warmly: "Oh awesome, a corporate event — we absolutely love those!"
// → Get their name
// → Say: "I'll put you straight through to our corporate team — they handle these personally
//   and will make sure it's an epic experience for your whole team."
// → Call transfer_call with event_type: "corporate"

// STEP 3d — TRANSFER (any event type where transfer is appropriate)
// → Call transfer_call with the correct event_type
// → If transfer fails/unavailable: pivot to save_lead and assure caller the team will call back

// STEP 4 — WRAP UP (if not transferred)
// After saving lead: "Perfect, I've got all of that noted down — how exciting! Someone from our
// team will give you a call back to go over everything and lock it all in for you.
// Is there anything else I can help with?"

// ### FALLBACK / VOICEMAIL ###
// If a transfer cannot be completed for any reason, always fall back to save_lead.
// Reassure the caller warmly: "No worries at all! I'll make sure our team gets your details
// and gives you a call back as soon as possible."
// Never leave a caller without their enquiry being captured.

// ### URGENCY MESSAGING (IMPORTANT) ###
// For kids parties and buck parties, weave in genuine urgency naturally and warmly:
// - "Just giving you a heads up — weekend dates do fill up super fast, especially Saturdays!"
// - "We'd definitely recommend locking in a date as soon as you can — it goes so quickly!"
// - "Honestly these slots are so popular, Saturday nights especially — it is worth getting in early."
// Only say it once per call. Keep it genuine and caring, never pushy.

// ### OFF-TOPIC HANDLING ###
// You ONLY handle Le Mans Entertainment enquiries.
// For anything unrelated: "Ah sorry, I'm only set up for Le Mans enquiries! Is there
// anything about the venue or our awesome events I can help you with?"

// ### SILENCE HANDLING ###
// If you receive a [SYSTEM: The user has been silent...] instruction:
// Speak exactly what it says, naturally and conversationally. Do not add extra content.

// ### MANDARIN CALLERS ###
// If a caller speaks Mandarin at any point, respond fully in Mandarin for the remainder of the call.
// Maintain your bubbly, caring Chloe personality in Mandarin.
// All the same call flow rules apply — just in Mandarin.
// Example Mandarin greeting if needed: "你好！感谢您致电Le Mans Entertainment！我是Chloe，请问有什么可以帮您？"

// ### HARD RULES ###
// - ONE question at a time
// - 1–2 sentences per response max
// - NEVER say "let me check that", "let me grab that", "one moment" — you know everything already
// - NEVER repeat the same transition twice in a call
// - ALWAYS call save_lead OR transfer_call before ending — never end without one
// - Corporate → transfer immediately to Corporate Events Sales
// - Kids/Buck → Birthday & Social Group Sales (transfer or save_lead)
// - No promises on specific callback times unless instructed
// - Always be safe, fun, awesome — that is the Le Mans way
// `;
//   }

//   // ─── Tool definitions ─────────────────────────────────────────────────────────

//   private getTransferCallTool() {
//     return {
//       type: 'function',
//       name: 'transfer_call',
//       description:
//         'Initiates a warm call transfer to the appropriate team based on the event type. ' +
//         'Use immediately for corporate enquiries (Corporate Events Sales). ' +
//         'Use for kids_party and buck_party to reach Birthday & Social Group Sales.',
//       parameters: {
//         type: 'object',
//         properties: {
//           event_type: {
//             type: 'string',
//             enum: ['kids_party', 'buck_party', 'corporate', 'general_enquiry'],
//             description: 'The type of enquiry/event detected',
//           },
//           caller_name: {
//             type: 'string',
//             description: "Caller's name if collected",
//           },
//           transfer_reason: {
//             type: 'string',
//             description: 'Brief reason for the transfer',
//           },
//         },
//         required: ['event_type'],
//       },
//     };
//   }

//   private getSaveLeadTool() {
//     return {
//       type: 'function',
//       name: 'save_lead',
//       description:
//         'Saves caller enquiry details to the database and sends to ActiveCampaign ' +
//         '(account: lemansGokarts.api-us1.com). ' +
//         'Call this when a transfer is not possible, when a non-corporate caller wants a callback, ' +
//         'or as the voicemail/fallback when a live transfer cannot be completed.',
//       parameters: {
//         type: 'object',
//         properties: {
//           caller_name: { type: 'string', description: "Caller's name" },
//           caller_number: {
//             type: 'string',
//             description: "Caller's phone number",
//           },
//           event_type: {
//             type: 'string',
//             enum: [
//               'kids_party',
//               'buck_party',
//               'corporate',
//               'general_enquiry',
//               'unknown',
//             ],
//           },
//           event_date: {
//             type: 'string',
//             description: 'Preferred date or timeframe',
//           },
//           group_size: { type: 'number', description: 'Approximate group size' },
//           enquiry_details: {
//             type: 'string',
//             description:
//               'Full details of the enquiry including everything discussed',
//           },
//           preferred_language: {
//             type: 'string',
//             enum: ['english', 'mandarin'],
//             description: "Caller's preferred language if identified",
//           },
//         },
//         required: ['caller_name', 'event_type', 'enquiry_details'],
//       },
//     };
//   }
// }
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ClientRequest } from 'http';
import { Model } from 'mongoose';
import { Socket as NetSocket } from 'net';
import { TLSSocket } from 'tls';
import WebSocket from 'ws';
import { Lead, LeadDocument } from './schemas/lead.schema';
import { ActiveCampaignService } from '../integrations/active-campaign.service';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EventType =
  | 'kids_party'
  | 'buck_party'
  | 'corporate'
  | 'general_enquiry'
  | 'unknown';

/**
 * Corporate size tier.
 * - 'small'  → group ≤ 40 → routes to main line (8741)
 * - 'large'  → group > 40 → routes to Skye's corporate line
 * - 'unknown' → size not yet collected
 */
export type CorporateSizeTier = 'small' | 'large' | 'unknown';

interface RealtimeSession {
  ws: WebSocket;
  elevenLabsWs: WebSocket | null;
  elevenLabsReady: boolean;
  textBuffer: string[];
  isResponseActive: boolean;
  onEvent: (event: any) => void;
  sessionStartedAtMs: number;
  openAiConnectedAtMs: number | null;
  elevenLabsConnectedAtMs: number | null;
  greetingTriggeredAtMs: number | null;
  firstResponseCreatedAtMs: number | null;
  firstAudioDeltaLogged: boolean;
  processedFunctionCallIds: Set<string>;
  lastQuestionAsked: string;
  lastRealAnswer: string;
  isRepromptActive: boolean;
  silenceRepromptCount: number;
  detectedEventType: EventType;
  corporateSizeTier: CorporateSizeTier;
  callerNumber: string;
  preferredLanguage: 'english' | 'mandarin';
  silenceTimer: ReturnType<typeof setTimeout> | null;
}

interface FunctionCallPayload {
  name: string;
  arguments: string;
  call_id: string;
}

// ─── Transfer numbers ─────────────────────────────────────────────────────────
// TRANSFER_MAIN       → main Le Mans line (8741) — kids, bucks, small corporates, social
// TRANSFER_CORPORATE  → Skye's corporate line  — large corporates (> 40 pax)

const TRANSFER_MAIN = process.env.TRANSFER_MAIN ?? null;              // e.g. +61387878741
const TRANSFER_CORPORATE_LARGE = process.env.TRANSFER_CORPORATE_LARGE ?? null; // Skye's DDI

// Convenience map used by the generic transfer helper (kids/bucks/general all → main line).
// Corporate routing is handled separately based on group size.
const TRANSFER_NUMBERS: Record<EventType, string | null> = {
  kids_party:      TRANSFER_MAIN,
  buck_party:      TRANSFER_MAIN,
  corporate:       TRANSFER_MAIN,           // overridden at runtime when pax > 40
  general_enquiry: TRANSFER_MAIN,
  unknown:         TRANSFER_MAIN,
};

// ─── Business Hours ──────────────────────────────────────────────────────────
// Le Mans Entertainment — 55 Waterview Cl, Dandenong South VIC 3175
// Mon: Closed | Tue: Closed | Wed: 4:00pm–10:00pm | Thu: 4:00pm–10:00pm
// Fri: 11:15am–11:00pm | Sat: 9:15am–11:00pm | Sun: 9:15am–10:00pm

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);
  private sessions = new Map<string, RealtimeSession>();
  private readonly MAX_SILENCE_REPROMPTS = 2;

  constructor(
    private readonly config: ConfigService,
    @InjectModel(Lead.name)
    private readonly leadModel: Model<LeadDocument>,
    private readonly activeCampaign: ActiveCampaignService,
  ) {}

  // ─── Type guard ─────────────────────────────────────────────────────────────

  private toFunctionCallPayload(value: unknown): FunctionCallPayload | null {
    if (!value || typeof value !== 'object') return null;
    const r = value as Record<string, unknown>;
    if (r.type !== 'function_call') return null;
    if (
      typeof r.name !== 'string' ||
      typeof r.arguments !== 'string' ||
      typeof r.call_id !== 'string'
    )
      return null;
    return { name: r.name, arguments: r.arguments, call_id: r.call_id };
  }

  // ─── Silence handling ────────────────────────────────────────────────────────

  handleSilenceTimeout(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.isResponseActive) {
      this.logger.debug(`[${sessionId}] Silence ignored — response still active`);
      return;
    }

    session.silenceRepromptCount += 1;

    if (session.silenceRepromptCount > this.MAX_SILENCE_REPROMPTS) {
      this.logger.log(`[${sessionId}] Max silence re-prompts reached — closing politely`);
      this._injectAndRespond(
        sessionId,
        "It seems like you might have stepped away. No worries — feel free to call back whenever you're ready. Thanks for calling LeMans Entertainment, take care!",
      );
      setTimeout(() => this.closeSession(sessionId), 8_000);
      return;
    }

    const reprompt = this._buildSilenceReprompt(session);
    this.logger.log(`[${sessionId}] Silence #${session.silenceRepromptCount} — re-prompting: "${reprompt}"`);
    this._injectAndRespond(sessionId, reprompt);
  }

  handlePlaybackDone(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.silenceTimer) {
      clearTimeout(session.silenceTimer);
      session.silenceTimer = null;
    }

    if (session.isResponseActive) return;

    const SILENCE_TIMEOUT_MS = 8_000;
    session.silenceTimer = setTimeout(() => {
      this.handleSilenceTimeout(sessionId);
    }, SILENCE_TIMEOUT_MS);

    this.logger.debug(`[${sessionId}] Silence countdown started (${SILENCE_TIMEOUT_MS}ms)`);
  }

  private _buildSilenceReprompt(session: RealtimeSession): string {
    const last = session.lastRealAnswer?.trim();
    if (!last) return "I guess you didn't hear that — are you still there?";
    return `I guess you didn't hear that, let me repeat my question. ${last}`;
  }

  private _injectAndRespond(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.ws.readyState !== WebSocket.OPEN) return;

    session.isRepromptActive = true;

    session.ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `[SYSTEM: The user has been silent. Re-engage by saying exactly this, naturally: "${text}"]`,
            },
          ],
        },
      }),
    );
    session.ws.send(JSON.stringify({ type: 'response.create' }));
  }

  // ─── Create session ──────────────────────────────────────────────────────────

  async createRealtimeSession(
    sessionId: string,
    onEvent: (event: any) => void,
    callerNumber = 'unknown',
  ): Promise<void> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    const model = this.config.get<string>('OPENAI_REALTIME_MODEL') ?? 'gpt-realtime-2';
    const inputSampleRate = Number(this.config.get<string>('OPENAI_INPUT_SAMPLE_RATE') ?? 24000);
    const vadThreshold = Number(this.config.get<string>('OPENAI_VAD_THRESHOLD') ?? 0.8);
    const vadPrefixPaddingMs = Number(this.config.get<string>('OPENAI_VAD_PREFIX_PADDING_MS') ?? 300);
    const vadSilenceDurationMs = Number(this.config.get<string>('OPENAI_VAD_SILENCE_DURATION_MS') ?? 2000);
    const url = `wss://api.openai.com/v1/realtime?model=${model}`;
    const sessionStartedAtMs = Date.now();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      this.instrumentHandshake(sessionId, 'OpenAI', ws, sessionStartedAtMs);

      ws.on('open', () => {
        const openAiConnectedAtMs = Date.now();
        this.logger.log(`[${sessionId}] OpenAI connected in ${openAiConnectedAtMs - sessionStartedAtMs}ms`);

        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              type: 'realtime',
              model,
              output_modalities: ['text'],
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: inputSampleRate },
                  turn_detection: {
                    type: 'server_vad',
                    threshold: vadThreshold,
                    prefix_padding_ms: vadPrefixPaddingMs,
                    silence_duration_ms: vadSilenceDurationMs,
                  },
                },
              },
              instructions: this.getSystemPrompt(),
              tools: [
                this.getTransferCallTool(),
                this.getSaveLeadTool(),
              ],
              tool_choice: 'auto',
            },
          }),
        );

        this.sessions.set(sessionId, {
          ws,
          elevenLabsWs: null,
          elevenLabsReady: false,
          textBuffer: [],
          isResponseActive: false,
          onEvent,
          sessionStartedAtMs,
          openAiConnectedAtMs,
          elevenLabsConnectedAtMs: null,
          greetingTriggeredAtMs: null,
          firstResponseCreatedAtMs: null,
          firstAudioDeltaLogged: false,
          processedFunctionCallIds: new Set(),
          lastQuestionAsked: '',
          lastRealAnswer: '',
          isRepromptActive: false,
          silenceRepromptCount: 0,
          detectedEventType: 'unknown',
          corporateSizeTier: 'unknown',
          callerNumber,
          preferredLanguage: 'english',
          silenceTimer: null,
        });

        this.openElevenLabsStream(sessionId);
        resolve();
      });

      ws.on('message', async (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(data.toString());
          await this.handleRealtimeEvent(sessionId, event);
        } catch (err) {
          this.logger.error(`[${sessionId}] Failed to parse event:`, err);
        }
      });

      ws.on('error', (err) => {
        this.logger.error(`[${sessionId}] OpenAI WS error:`, err);
        onEvent({ type: 'error', error: { message: err.message } });
        reject(err);
      });

      ws.on('close', (code, reason) => {
        this.logger.log(`[${sessionId}] OpenAI WS closed: ${code} - ${reason}`);
        this.closeElevenLabsWs(sessionId);
        this.sessions.delete(sessionId);
        onEvent({ type: 'session-closed' });
      });
    });
  }

  // ─── Send audio ──────────────────────────────────────────────────────────────

  sendAudio(sessionId: string, base64Audio: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64Audio }));
  }

  // ─── Trigger greeting ────────────────────────────────────────────────────────

  triggerGreeting(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.greetingTriggeredAtMs = Date.now();
    session.ws.send(JSON.stringify({ type: 'response.create' }));
  }

  // ─── ElevenLabs stream ───────────────────────────────────────────────────────

  private openElevenLabsStream(sessionId: string, force = false): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (
      !force &&
      session.elevenLabsWs &&
      (session.elevenLabsWs.readyState === WebSocket.OPEN ||
        session.elevenLabsWs.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.closeElevenLabsWs(sessionId);

    const apiKey = this.config.get<string>('ELEVENLABS_API_KEY');
    const voiceId = this.config.get<string>('ELEVENLABS_VOICE_ID');
    const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_multilingual_v2&output_format=pcm_16000`;

    const elWs = new WebSocket(wsUrl);
    this.instrumentHandshake(sessionId, 'ElevenLabs', elWs, session.sessionStartedAtMs);

    elWs.on('open', () => {
      this.logger.log(`[${sessionId}] ElevenLabs connected`);
      session.elevenLabsConnectedAtMs = Date.now();

      elWs.send(
        JSON.stringify({
          text: ' ',
          voice_settings: {
            stability: 0.55,
            similarity_boost: 0.78,
            style: 0.35,
            use_speaker_boost: true,
          },
          xi_api_key: apiKey,
        }),
      );

      if (session.elevenLabsWs === elWs) {
        session.elevenLabsReady = true;
        for (const text of session.textBuffer) {
          this.sendTextToElevenLabs(sessionId, text);
        }
        session.textBuffer = [];
      }
    });

    elWs.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.audio) {
          if (!session.firstAudioDeltaLogged) {
            session.firstAudioDeltaLogged = true;
            this.logger.log(`[${sessionId}] First audio at ${Date.now() - session.sessionStartedAtMs}ms`);
          }
          session.onEvent({ type: 'audio-delta', delta: msg.audio });
        }
        if (msg.isFinal === true) {
          session.onEvent({ type: 'audio-done' });
        }
      } catch {
        // binary frames — ignore
      }
    });

    elWs.on('error', (err) => {
      this.logger.warn(`[${sessionId}] ElevenLabs WS error: ${err.message}`);
    });

    elWs.on('close', () => {
      if (session.elevenLabsWs === elWs) {
        session.elevenLabsReady = false;
      }
    });

    session.elevenLabsWs = elWs;
  }

  private sendTextToElevenLabs(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.elevenLabsWs?.readyState === WebSocket.OPEN) {
      session.elevenLabsWs.send(JSON.stringify({ text, try_trigger_generation: true }));
    }
  }

  private flushElevenLabsStream(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.elevenLabsWs?.readyState === WebSocket.OPEN) {
      session.elevenLabsWs.send(JSON.stringify({ text: '' }));
    }
  }

  private closeElevenLabsWs(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.elevenLabsWs) return;
    try {
      if (session.elevenLabsWs.readyState === WebSocket.CONNECTING) {
        session.elevenLabsWs.terminate();
      } else if (session.elevenLabsWs.readyState === WebSocket.OPEN) {
        session.elevenLabsWs.close();
      }
    } catch (err) {
      this.logger.warn(`[${sessionId}] Error closing ElevenLabs WS: ${err.message}`);
    }
    session.elevenLabsWs = null;
    session.elevenLabsReady = false;
    session.textBuffer = [];
  }

  // ─── Event hub ───────────────────────────────────────────────────────────────

  private async handleRealtimeEvent(sessionId: string, event: any): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.logger.debug(`[${sessionId}] Event: ${event.type}`);

    switch (event.type) {
      case 'response.created':
        session.isResponseActive = true;
        session.silenceRepromptCount = 0;
        if (!session.firstResponseCreatedAtMs) {
          session.firstResponseCreatedAtMs = Date.now();
        }
        this.openElevenLabsStream(sessionId);
        break;

      case 'response.done': {
        session.isResponseActive = false;
        const outputs = (event as any).response?.output;
        if (Array.isArray(outputs)) {
          for (const item of outputs) {
            const fn = this.toFunctionCallPayload(item);
            if (fn) await this.handleFunctionCall(sessionId, fn);
          }
        }
        break;
      }

      case 'response.output_text.delta':
      case 'response.text.delta':
        if (session.elevenLabsReady) {
          this.sendTextToElevenLabs(sessionId, event.delta);
        } else {
          session.textBuffer.push(event.delta);
        }
        session.onEvent({ type: 'transcript-delta', delta: event.delta });
        break;

      case 'response.output_text.done':
      case 'response.text.done':
        if (typeof event.text === 'string' && event.text.trim()) {
          session.lastQuestionAsked = event.text.trim();
          if (!session.isRepromptActive) {
            session.lastRealAnswer = event.text.trim();
          }
        }
        session.isRepromptActive = false;
        this.flushElevenLabsStream(sessionId);
        session.onEvent({ type: 'transcript-done', transcript: event.text });
        break;

      case 'input_audio_buffer.speech_started':
        session.silenceRepromptCount = 0;
        session.isRepromptActive = false;
        if (session.silenceTimer) {
          clearTimeout(session.silenceTimer);
          session.silenceTimer = null;
        }
        if (session.isResponseActive) {
          try {
            session.ws.send(JSON.stringify({ type: 'response.cancel' }));
          } catch (err) {
            this.logger.warn(`[${sessionId}] Cancel failed: ${err.message}`);
          }
        }
        this.closeElevenLabsWs(sessionId);
        this.openElevenLabsStream(sessionId, true);
        session.onEvent({ type: 'speech-started' });
        break;

      case 'conversation.item.input_audio_transcription.completed':
        session.onEvent({ type: 'user-transcript', transcript: event.transcript });
        break;

      case 'response.function_call_arguments.done':
        await this.handleFunctionCall(sessionId, event);
        break;

      case 'response.output_item.done': {
        const fn = this.toFunctionCallPayload((event as any).item);
        if (fn) await this.handleFunctionCall(sessionId, fn);
        break;
      }

      case 'error':
        this.logger.error(`[${sessionId}] OpenAI error: ${JSON.stringify(event.error)}`);
        break;
    }
  }

  // ─── Function call dispatcher ────────────────────────────────────────────────

  private async handleFunctionCall(sessionId: string, event: FunctionCallPayload): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const callId = event.call_id ?? null;
    if (callId && session.processedFunctionCallIds.has(callId)) {
      this.logger.debug(`[${sessionId}] Duplicate fn call ignored: ${callId}`);
      return;
    }
    if (callId) session.processedFunctionCallIds.add(callId);

    try {
      const args = JSON.parse(event.arguments);

      if (event.name === 'transfer_call') {
        await this.handleTransferCall(sessionId, args, event.call_id);
      } else if (event.name === 'save_lead') {
        await this.handleSaveLead(sessionId, args, event.call_id);
      }
    } catch (err) {
      if (callId) session.processedFunctionCallIds.delete(callId);
      this.logger.error(`[${sessionId}] Function call error: ${err.message}`);
    }
  }

  // ─── transfer_call ───────────────────────────────────────────────────────────

  private async handleTransferCall(
    sessionId: string,
    args: any,
    callId: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const eventType: EventType = args.event_type ?? 'unknown';
    const groupSize: number | null = args.group_size ?? null;
    session.detectedEventType = eventType;

    // ── Determine target number ──────────────────────────────────────────────
    let transferTo: string | null = null;
    let assignedTo: string | null = null;

    if (eventType === 'corporate' && groupSize !== null && groupSize > 40) {
      // Large corporate → Skye's line
      session.corporateSizeTier = 'large';
      transferTo = TRANSFER_CORPORATE_LARGE;
      assignedTo = 'Skye';
      this.logger.log(`[${sessionId}] Corporate > 40 pax → routing to Skye (${transferTo})`);
    } else {
      // Everyone else (kids, bucks, social, sports, small corporate, general) → main line
      if (eventType === 'corporate') session.corporateSizeTier = 'small';
      transferTo = TRANSFER_NUMBERS[eventType] ?? TRANSFER_MAIN;
      this.logger.log(`[${sessionId}] Routing to main line (${transferTo})`);
    }

    // ── Build warm whisper message ───────────────────────────────────────────
    // This message is spoken to the answering agent BEFORE they speak to the caller.
    const callerName = args.caller_name ? args.caller_name : 'a caller';
    const whisperLabel = this._transferLabel(eventType, groupSize);
    const whisperMessage = `Hi, you have ${callerName} on the line asking about ${whisperLabel}. Connecting you now.`;

    if (transferTo) {
      this.logger.log(`[${sessionId}] Transfer → ${transferTo} | whisper: "${whisperMessage}"`);

      session.onEvent({
        type: 'transfer-initiated',
        data: {
          event_type: eventType,
          transfer_to: transferTo,
          caller_name: args.caller_name,
          caller_number: session.callerNumber,
          group_size: groupSize,
          assigned_to: assignedTo,
          whisper_message: whisperMessage,
        },
      });

      this._sendFunctionResult(sessionId, callId, {
        success: true,
        message: assignedTo
          ? `Transferring you to ${assignedTo} now — she'll take great care of you!`
          : `Transferring you to the team now — they'll be able to go through all the details!`,
        transfer_to: transferTo,
        whisper_message: whisperMessage,
      });
    } else {
      // No transfer number configured — fall back to save_lead
      this.logger.warn(`[${sessionId}] No transfer number for ${eventType}/${assignedTo ?? 'main'} — falling back to save_lead`);

      this._sendFunctionResult(sessionId, callId, {
        success: false,
        message: 'Transfer unavailable right now — I will save your details and have the team call you back.',
        assigned_to: assignedTo,
      });
    }

    session.ws.send(JSON.stringify({ type: 'response.create' }));
  }

  /**
   * Returns a human-readable label for the warm whisper based on event type and group size.
   */
  private _transferLabel(eventType: EventType, groupSize: number | null): string {
    switch (eventType) {
      case 'kids_party':
        return "a kids birthday party";
      case 'buck_party':
        return "a bucks or hens party";
      case 'corporate':
        return groupSize !== null
          ? `a corporate event for around ${groupSize} people`
          : "a corporate or business event";
      case 'general_enquiry':
        return "a general enquiry";
      default:
        return "an enquiry";
    }
  }

  // ─── save_lead ───────────────────────────────────────────────────────────────

  private async handleSaveLead(sessionId: string, args: any, callId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Determine the assigned owner in ActiveCampaign.
    // Corporate callers with > 40 people are owned by Skye.
    const groupSize: number | null = args.group_size ?? null;
    const isCorporateLarge =
      args.event_type === 'corporate' &&
      groupSize !== null &&
      groupSize > 40;
    const assignedTo: string = isCorporateLarge ? 'Skye' : 'LeMans Inquiries';

    this.logger.log(
      `[${sessionId}] Saving lead — caller: ${args.caller_name} | type: ${args.event_type} | assigned: ${assignedTo}`,
    );

    const lead = await this.leadModel.create({
      callerName: args.caller_name,
      callerNumber: args.caller_number || session.callerNumber,
      eventType: args.event_type,
      eventDate: args.event_date,
      groupSize: args.group_size,
      enquiryDetails: args.enquiry_details,
      assignedTo,
      callId: sessionId,
      source: 'voice_agent',
    });

    this.logger.log(`[${sessionId}] Lead saved: ${lead._id} (assigned to ${assignedTo})`);

    // ── Push to ActiveCampaign ───────────────────────────────────────────────
    try {
      await this.activeCampaign.createContact({
        firstName: args.caller_name,
        phone: args.caller_number || session.callerNumber,
        // Tag by event type so AC pipelines/automations can filter correctly
        tag: args.event_type,
        fieldValues: [
          { field: 'EVENT_TYPE',   value: args.event_type ?? '' },
          { field: 'EVENT_DATE',   value: args.event_date ?? '' },
          { field: 'GROUP_SIZE',   value: String(args.group_size ?? '') },
          { field: 'ENQUIRY',      value: args.enquiry_details ?? '' },
          // ASSIGNED_TO lets AC route to the correct deal owner / pipeline
          { field: 'ASSIGNED_TO',  value: assignedTo },
        ],
      });
      this.logger.log(`[${sessionId}] ActiveCampaign contact created (owner: ${assignedTo})`);
    } catch (err) {
      this.logger.warn(`[${sessionId}] ActiveCampaign push failed: ${err.message}`);
    }

    this._sendFunctionResult(sessionId, callId, {
      success: true,
      message: isCorporateLarge
        ? `Got it — I've passed your details straight to Skye. She'll give you a call back personally to plan your event!`
        : `All noted — our team will be in touch soon to go through everything with you!`,
      assigned_to: assignedTo,
    });

    session.ws.send(JSON.stringify({ type: 'response.create' }));
    session.onEvent({ type: 'lead-saved', data: { ...args, assignedTo } });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private _sendFunctionResult(sessionId: string, callId: string, output: object): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.ws.readyState !== WebSocket.OPEN) return;

    session.ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify(output),
        },
      }),
    );
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────────

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.closeElevenLabsWs(sessionId);
      try {
        session.ws.close();
      } catch {
        // already closed
      }
      this.sessions.delete(sessionId);
      this.logger.log(`[${sessionId}] Session closed`);
    }
  }

  // ─── WS instrumentation ──────────────────────────────────────────────────────

  private instrumentHandshake(
    sessionId: string,
    provider: 'OpenAI' | 'ElevenLabs',
    ws: WebSocket,
    startedAtMs: number,
  ): void {
    const wsWithReq = ws as WebSocket & { _req?: ClientRequest };
    const req = wsWithReq._req;
    if (!req) return;

    let attached = false;
    const attach = (socket: NetSocket): void => {
      if (attached) return;
      attached = true;
      socket.once('lookup', () =>
        this.logger.log(`[${sessionId}] ${provider} DNS lookup in ${Date.now() - startedAtMs}ms`),
      );
      socket.once('connect', () =>
        this.logger.log(`[${sessionId}] ${provider} TCP connect in ${Date.now() - startedAtMs}ms`),
      );
      (socket as TLSSocket).once('secureConnect', () =>
        this.logger.log(`[${sessionId}] ${provider} TLS handshake in ${Date.now() - startedAtMs}ms`),
      );
    };

    if (req.socket) attach(req.socket);
    req.once('socket', (s: NetSocket) => attach(s));
    ws.on('upgrade', () =>
      this.logger.log(`[${sessionId}] ${provider} WS upgrade in ${Date.now() - startedAtMs}ms`),
    );
  }

  // ─── System prompt ───────────────────────────────────────────────────────────

  private getSystemPrompt(): string {
    return `
=============================================================
ABSOLUTE RULE — LANGUAGE SUPPORT
=============================================================
You support TWO languages: English and Mandarin (Simplified Chinese).
Default to English. If the caller speaks Mandarin, switch fully to Mandarin
and maintain that language for the rest of the call.
If the caller uses any other language, respond only in English.
=============================================================

### IDENTITY ###
You are Chloe — the bubbly, caring voice receptionist for Le Mans Entertainment Melbourne,
located at 55 Waterview Close, Dandenong South VIC 3175. Phone: (03) 8787 8741.
You are warm, motherly, upbeat, articulate, and sound around 40 — like the most enthusiastic
and caring person at the venue's front desk.

### AI DISCLOSURE ###
Do NOT volunteer that you are AI.
ONLY if directly asked "are you a robot?" or "are you AI?" respond honestly:
"Yeah, I'm actually an AI assistant for Le Mans! I'll get you sorted just the same though — let's do this!"
Then pivot straight back to helping them.

### PERSONALITY ###
- Bubbly, motherly, excited, caring, empathetic, optimistic — you genuinely love working at Le Mans
- Short sentences. 1–2 sentences per response max.
- Natural filler: "yeah", "absolutely", "no worries", "for sure", "awesome", "oh how exciting"
- Match caller energy — excited with excited callers, reassuring with worried ones
- React genuinely before asking the next question — never go question-to-question robotically
- Be warm and caring — especially with parents calling about kids' parties

### WHAT LE MANS IS ###
Le Mans Entertainment is a go-karting and entertainment venue in Melbourne, Dandenong South.
They host kids birthday parties, buck/hen parties, corporate events, and general fun visits.
Weekend and peak times sell out fast — a genuine, honest fact to share warmly.

=============================================================
PRICING RULE — CRITICAL
=============================================================
NEVER quote specific prices or packages.
If anyone asks about pricing, cost, how much, packages or rates — say:
"Pricing really depends on the group size and what you're after — our team can put together
an exact quote for you. Want me to either put you through to them, or take your details
so they can give you a call back?"
Do not attempt to guess, approximate, or give a price range. Always redirect to the team.
=============================================================

=============================================================
KNOWLEDGE BASE — ANSWER THESE DIRECTLY, NO TOOL CALL NEEDED
=============================================================
You have ALL the answers below memorised. Speak them IMMEDIATELY and naturally
when asked — do NOT say "let me check" or "one moment" first.

OPENING HOURS:
  Wednesday: 4:00pm – 10:00pm
  Thursday:  4:00pm – 10:00pm
  Friday:    11:15am – 11:00pm
  Saturday:  9:15am – 11:00pm
  Sunday:    9:15am – 10:00pm
  Monday:    CLOSED
  Tuesday:   CLOSED
  Always mention hours change during school/seasonal holidays — check website to confirm.
  Example: "Yeah — we're open Wed–Thu 4pm–10pm, Fri 11:15am–11pm, Sat 9:15am–11pm,
  and Sun 9:15am–10pm, closed Mon–Tue. Hours do change in school holidays so always
  worth a double check on the website!"

LOCATION / DIRECTIONS:
  55 Waterview Close, Dandenong South VIC 3175.
  Easiest via Frankston-Dandenong Road, follow signs to Waterview Close.
  Google Maps takes you straight there.
  Example: "We're at 55 Waterview Close, Dandenong South — just off Frankston-Dandenong Road,
  and honestly Google Maps takes you straight there, super easy!"

PARKING:
  Free on-site parking, plenty of spaces. Street parking nearby too.
  Example: "Yeah, free on-site parking — heaps of spaces, never really an issue!"

KIDS PARTIES (general info only — no pricing):
  Awesome packages for birthdays — karting, food, dedicated party host.
  Minimum around 10 kids. Weekends book out 3–4 weeks ahead — lock in early!
  Example: "Oh how exciting, a kids' party — they are absolutely epic here!
  We've got awesome packages with karting, food and a dedicated host.
  Weekends do fill up fast though, usually 3–4 weeks ahead!"

BUCK / HEN PARTIES (general info only — no pricing):
  Racing, drinks on arrival, trophy presentation. Book months ahead for Fri/Sat nights.
  Example: "Buck parties here are absolutely legendary — racing, drinks, trophy presentation!
  Fair warning — Friday and Saturday nights book out months ahead, so lock it in ASAP!"

CORPORATE EVENTS (general info only — no pricing):
  Fully customisable. Team days, client entertainment, product launches.
  Dedicated Corporate Events specialist (Skye) for larger groups.
  Example: "Oh awesome, a corporate event — we love those!
  Our team handles everything personally to make sure it's perfect for your company."

LANGUAGES:
  English and Mandarin supported.
  Example: "We're happy to help in English or Mandarin — 我们也可以用普通话为您服务！"
=============================================================

### EVENT CLASSIFICATION (INTERNAL — NEVER ANNOUNCE) ###
Silently classify every call:
- kids_party      — birthday party, kids entertainment, school groups
- buck_party      — bucks night, hens night, bachelor/bachelorette, social events, sports groups
- corporate       — corporate, business, team building, company event, product launch
- general_enquiry — hours, directions, parking, pricing questions, casual visit

=============================================================
CALL FLOW
=============================================================

── STEP 1: GREET ──────────────────────────────────────────
"Hi, thanks for calling Le Mans Entertainment! This is Chloe speaking — how are you going today?"
Warm, genuine — like you're genuinely happy to hear from them.

── STEP 2: LISTEN & CLASSIFY ──────────────────────────────
Let them tell you what they need. Classify silently. Do not announce the category.
Switch to Mandarin immediately and naturally if the caller speaks Mandarin.

── STEP 3a: GENERAL QUESTIONS (hours, parking, directions) ─
Answer IMMEDIATELY from your knowledge base. No tool call, no preamble.
After answering: "Is there anything else I can help you with, or would you like to
make a booking or get more details from the team?"
If they want more: take name + number → save_lead → team calls back.

── STEP 3b: PRICING QUESTIONS ─────────────────────────────
Never answer pricing. Always redirect:
"Pricing really depends on the group and what you're after — want me to put you through
to someone who can give you an exact quote, or take your details so they can call you back?"
→ Transfer if they want to be put through
→ save_lead if they want a callback

── STEP 3c: KIDS PARTY / BUCKS PARTY / SOCIAL / SPORTS GROUPS ─
React warmly. Then ask ONE question at a time — do NOT fire off multiple questions.

First: "Would you like to speak directly to one of our team who specialises in
[kids' parties / bucks nights], or did you have a quick question first?"

If they want the TEAM → collect name, then transfer_call (event_type: kids_party or buck_party)
If they have a QUESTION → answer from knowledge base (except pricing → redirect)
  → Then offer: "Would you like to speak to the team, or shall I take your details
    and have someone call you back?"
  → Transfer or save_lead accordingly.

Collect naturally before transferring:
  - Name (always)
  - Approx group size (if not mentioned)
  - Preferred date or timeframe (if not mentioned)

Mention urgency ONCE, naturally and warmly:
  "Just so you know — weekends do fill up super fast, so it's worth locking in a date soon!"

── STEP 3d: CORPORATE / BUSINESS EVENTS ──────────────────
React warmly: "Oh amazing, a corporate event — we absolutely love those!"

Ask: "And roughly how many people are you thinking of bringing along?"

If group size > 40:
  → "Brilliant — I'll put you straight through to Skye, she's our corporate events
    specialist and will make sure your event is planned perfectly for your team."
  → transfer_call(event_type: 'corporate', group_size: <number>)
  → If Skye unavailable: save_lead (assigned_to: 'Skye', event_type: 'corporate')
    → "No worries at all — I'll make sure Skye gets your details and calls you back personally."

If group size ≤ 40:
  → "Awesome — I'll put you through to our events team right now!"
  → transfer_call(event_type: 'corporate', group_size: <number>)
  → If no answer: save_lead (event_type: 'corporate')
    → "No worries — I'll have the team give you a call back to go through everything."

If they haven't mentioned group size yet — ask before transferring.

── STEP 4: WRAP UP (if not transferred) ──────────────────
After save_lead:
"Perfect, I've got all of that noted — how exciting! Someone from our team will give you
a call back to go through everything and get it all sorted for you.
Is there anything else I can help you with today?"

=============================================================
TRANSFER WHISPER — IMPORTANT
=============================================================
When a transfer is initiated, the system will announce the caller to the answering agent.
You do NOT need to say anything extra — just let the caller know you're putting them through:
"Great, putting you through now — just one moment!"

=============================================================
VOICEMAIL FALLBACK
=============================================================
If a transfer cannot be completed for any reason, ALWAYS fall back to save_lead.
Reassure warmly: "No worries at all! I'll make sure the team gets your details
and gives you a call back as soon as possible — you're in great hands!"
Never leave a caller without capturing their enquiry.

### OFF-TOPIC HANDLING ###
You ONLY handle Le Mans Entertainment enquiries.
For anything unrelated: "Ah sorry, I'm only set up for Le Mans enquiries — is there
anything about the venue or our events I can help you with?"

### SILENCE HANDLING ###
If you receive a [SYSTEM: The user has been silent...] instruction:
Speak exactly what it says, naturally and conversationally. Do not add extra content.

### MANDARIN CALLERS ###
If a caller speaks Mandarin, respond fully in Mandarin for the rest of the call.
Keep your bubbly, caring Chloe personality. All the same call flow rules apply.
Example Mandarin greeting: "你好！感谢您致电Le Mans Entertainment！我是Chloe，请问有什么可以帮您？"

### HARD RULES ###
- ONE question at a time — never stack questions
- 1–2 sentences per response max
- NEVER say "let me check that", "let me grab that", "one moment" — you know it already
- NEVER quote specific prices — always redirect to the team
- NEVER repeat the same transition twice in a call
- ALWAYS call save_lead OR transfer_call before ending — never hang up without one
- Corporate > 40 → Skye's line; Corporate ≤ 40 → main line (8741)
- Kids/Buck/Social/Sports → main line (8741)
- Always be safe, fun, awesome — that is the Le Mans way
`;
  }

  // ─── Tool definitions ─────────────────────────────────────────────────────────

  private getTransferCallTool() {
    return {
      type: 'function',
      name: 'transfer_call',
      description:
        'Initiates a warm call transfer to the appropriate team. ' +
        'For corporate events, always collect group_size first — it determines routing. ' +
        'Corporate > 40 people → routes to Skye (corporate specialist). ' +
        'Corporate ≤ 40 and all other event types → routes to main Le Mans team. ' +
        'For kids/bucks/social/sports: only transfer once you have the caller\'s name.',
      parameters: {
        type: 'object',
        properties: {
          event_type: {
            type: 'string',
            enum: ['kids_party', 'buck_party', 'corporate', 'general_enquiry'],
            description: 'The type of enquiry/event detected',
          },
          caller_name: {
            type: 'string',
            description: "Caller's first name — collect this before transferring",
          },
          group_size: {
            type: 'number',
            description:
              'Approximate number of people. Required for corporate events to determine routing (> 40 → Skye, ≤ 40 → main team).',
          },
          transfer_reason: {
            type: 'string',
            description: 'Brief reason for the transfer, used in the warm whisper message',
          },
        },
        required: ['event_type'],
      },
    };
  }

  private getSaveLeadTool() {
    return {
      type: 'function',
      name: 'save_lead',
      description:
        'Saves caller enquiry details to the database and ActiveCampaign (lemansGokarts.api-us1.com). ' +
        'Use when: (1) transfer is unavailable / unanswered, (2) caller prefers a callback, ' +
        'or (3) as the voicemail fallback. ' +
        'Corporate leads with group_size > 40 are automatically assigned to Skye in ActiveCampaign. ' +
        'All other leads are assigned to "LeMans Inquiries".',
      parameters: {
        type: 'object',
        properties: {
          caller_name: { type: 'string', description: "Caller's name" },
          caller_number: { type: 'string', description: "Caller's phone number" },
          event_type: {
            type: 'string',
            enum: ['kids_party', 'buck_party', 'corporate', 'general_enquiry', 'unknown'],
          },
          event_date: { type: 'string', description: 'Preferred date or timeframe' },
          group_size: { type: 'number', description: 'Approximate group size' },
          enquiry_details: {
            type: 'string',
            description: 'Full summary of the enquiry including everything discussed on the call',
          },
          preferred_language: {
            type: 'string',
            enum: ['english', 'mandarin'],
            description: "Caller's preferred language if identified",
          },
        },
        required: ['caller_name', 'event_type', 'enquiry_details'],
      },
    };
  }
}
