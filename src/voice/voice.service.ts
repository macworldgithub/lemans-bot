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
//   silenceRepromptCount: number;
//   detectedEventType: EventType;
//   callerNumber: string;
// }

// interface FunctionCallPayload {
//   name: string;
//   arguments: string;
//   call_id: string;
// }

// // Transfer number map — populate from env or hardcode for POC
// const TRANSFER_NUMBERS: Record<EventType, string | null> = {
//   kids_party: process.env.TRANSFER_KIDS_PARTY ?? null,
//   buck_party: process.env.TRANSFER_BUCK_PARTY ?? null,
//   corporate: process.env.TRANSFER_CORPORATE ?? null,
//   general_enquiry: process.env.TRANSFER_GENERAL ?? null,
//   unknown: process.env.TRANSFER_GENERAL ?? null,
// };

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

//   private _buildSilenceReprompt(session: RealtimeSession): string {
//     const last = session.lastQuestionAsked?.trim();
//     if (!last) {
//       return "I guess you didn't hear that — are you still there?";
//     }
//     return `I guess you didn't hear that, let me repeat my question. ${last}`;
//   }

//   private _injectAndRespond(sessionId: string, text: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session || session.ws.readyState !== WebSocket.OPEN) return;

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
//     const model = 'gpt-4o-mini-realtime-preview';
//     const url = `wss://api.openai.com/v1/realtime?model=${model}`;
//     const sessionStartedAtMs = Date.now();

//     return new Promise((resolve, reject) => {
//       const ws = new WebSocket(url, {
//         headers: {
//           Authorization: `Bearer ${apiKey}`,
//           'OpenAI-Beta': 'realtime=v1',
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
//               modalities: ['text'],
//               instructions: this.getSystemPrompt(),
//               input_audio_format: 'pcm16',
//               turn_detection: {
//                 type: 'server_vad',
//                 threshold: 0.8,
//                 prefix_padding_ms: 300,
//                 silence_duration_ms: 2000,
//               },
//               tools: [
//                 this.getTransferCallTool(),
//                 this.getSaveLeadTool(),
//                 this.getAnswerFaqTool(),
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
//           silenceRepromptCount: 0,
//           detectedEventType: 'unknown',
//           callerNumber,
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
//     const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_flash_v2_5&output_format=pcm_16000`;

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
//             stability: 0.45,
//             similarity_boost: 0.75,
//             speed: 1.1,
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

//       case 'response.text.delta':
//         if (session.elevenLabsReady) {
//           this.sendTextToElevenLabs(sessionId, event.delta);
//         } else {
//           session.textBuffer.push(event.delta);
//         }
//         session.onEvent({ type: 'transcript-delta', delta: event.delta });
//         break;

//       case 'response.text.done':
//         if (typeof event.text === 'string' && event.text.trim()) {
//           session.lastQuestionAsked = event.text.trim();
//         }
//         this.flushElevenLabsStream(sessionId);
//         session.onEvent({ type: 'transcript-done', transcript: event.text });
//         break;

//       case 'input_audio_buffer.speech_started':
//         session.silenceRepromptCount = 0;
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
//       } else if (event.name === 'answer_faq') {
//         await this.handleAnswerFaq(sessionId, args, event.call_id);
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
//       // Transfer number not configured — fall back to lead capture
//       this.logger.warn(
//         `[${sessionId}] No transfer number for ${eventType} — saving lead instead`,
//       );

//       this._sendFunctionResult(sessionId, callId, {
//         success: false,
//         message:
//           'Transfer unavailable right now — I will save your details instead.',
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

//     // Push to ActiveCampaign
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

//   // ─── answer_faq ──────────────────────────────────────────────────────────────

//   private async handleAnswerFaq(
//     sessionId: string,
//     args: any,
//     callId: string,
//   ): Promise<void> {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     const answer = this.resolveFaq(args.question_category);
//     this.logger.log(
//       `[${sessionId}] FAQ: ${args.question_category} → ${answer.substring(0, 80)}`,
//     );

//     this._sendFunctionResult(sessionId, callId, {
//       success: true,
//       answer,
//     });

//     session.ws.send(JSON.stringify({ type: 'response.create' }));
//   }

//   // ─── FAQ knowledge base ──────────────────────────────────────────────────────

//   private resolveFaq(category: string): string {
//     const kb: Record<string, string> = {
//       opening_hours:
//         'LeMans Entertainment is open 7 days a week. Monday to Friday 10am–10pm, Saturday and Sunday 9am–11pm. Public holidays may vary.',
//       directions:
//         'We are located at [ADDRESS]. Easiest access is via [MAIN ROAD]. Use the [LANDMARK] as your reference point.',
//       parking:
//         'Free parking is available on-site with over 100 spaces. There is also street parking available on nearby roads.',
//       kids_party:
//         'Our kids party packages start from $XX per child with a minimum of 10 kids. Packages include go-karting, food and a dedicated party host. Weekends book out fast so we recommend booking at least 3–4 weeks in advance.',
//       buck_party:
//         'Buck party packages are super popular and typically include racing, drinks on arrival, and a trophy presentation. Spots genuinely sell out months ahead, especially Friday and Saturday nights. Worth locking in ASAP.',
//       corporate:
//         'Our corporate packages are fully customisable — we do team building days, client entertainment, product launches and more. Our corporate sales team handles these personally to tailor the experience.',
//       pricing:
//         'Pricing depends on the package and group size. Our team can give you an exact quote based on your requirements. Would you like me to connect you with someone?',
//       booking:
//         'You can book online at our website or our team can take your details and call you back to confirm. Weekend and peak times sell out quickly — we recommend booking as soon as you can.',
//     };

//     return (
//       kb[category] ??
//       'That is a great question. Let me get the right person to help you with that.'
//     );
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
// ABSOLUTE RULE — ENGLISH ONLY
// =============================================================
// You MUST speak and respond in English at all times, no matter what.
// If the caller uses another language, respond only in English.
// =============================================================

// ### IDENTITY ###
// You are Alex — the friendly voice receptionist for LeMans Entertainment Melbourne.
// You answer the main enquiries line. You're warm, professional, and upbeat — like
// the best person at the venue's front desk.

// ### AI DISCLOSURE ###
// Do NOT volunteer that you are AI.
// ONLY if directly asked "are you a robot?" or "are you AI?" respond honestly:
// "Yeah, I'm actually an AI assistant for LeMans. I'll get you sorted just the same though!"
// Then pivot straight back to helping them.

// ### PERSONALITY ###
// - Friendly, upbeat, professional — like you love working at LeMans
// - Short sentences. 1–2 sentences per response.
// - Natural filler: "yeah", "absolutely", "no worries", "for sure"
// - Match caller energy — excited with excited callers, reassuring with worried ones
// - React genuinely before asking the next question — never go question-to-question

// ### WHAT LEMANS IS ###
// LeMans Entertainment is a go-karting and entertainment venue in Melbourne.
// They host kids parties, buck/hen parties, corporate events, and general fun visits.
// Weekend and peak times sell out fast — this is a genuine, honest fact to share.

// ### EVENT TYPE CLASSIFICATION (INTERNAL — NEVER ANNOUNCE) ###
// Silently classify every call into one of:
// - kids_party      — birthday party, kids entertainment, school groups
// - buck_party       — bucks night, hens night, bachelor/bachelorette
// - corporate        — corporate team building, client entertainment, company event
// - general_enquiry  — pricing, hours, directions, parking, casual visit

// CORPORATE CALLS: Detect IMMEDIATELY. Warm transfer straight away to the sales
// mobile. Do NOT ask lots of questions — just get their name and transfer.

// ### CALL FLOW ###

// STEP 1 — GREET
// "Hi, thanks for calling LeMans Entertainment! This is Alex speaking — how can I help you today?"

// STEP 2 — IDENTIFY INTENT
// Let them tell you what they need. Listen and classify silently.

// STEP 3a — BASIC QUESTION (hours, parking, directions, general)
// → Call answer_faq with the appropriate question_category
// → Answer naturally from the result
// → Check if they need anything else
// → If they want to book/enquire further: get name + number + details → save_lead

// STEP 3b — KIDS PARTY / BUCK PARTY enquiry
// → Ask 2–3 natural questions to understand their needs:
//   - Approx number of people / group size
//   - Preferred date or timeframe
//   - Any specific requests
// → Mention genuinely that these book out fast: "Just so you know, weekends especially
//   sell out pretty quickly — worth locking something in sooner rather than later."
// → Collect name and number
// → Call save_lead to capture the enquiry
// → Tell them the team will call back to confirm details

// STEP 3c — CORPORATE enquiry
// → React warmly: "Oh nice, a corporate event — we love those!"
// → Get their name
// → Say: "I'll put you straight through to our corporate team who handle these personally."
// → Call transfer_call with event_type: "corporate"

// STEP 3d — TRANSFER (any event type where transfer is appropriate)
// → Call transfer_call with the correct event_type
// → If transfer fails/unavailable: pivot to save_lead

// STEP 4 — WRAP UP (if not transferred)
// After saving lead: "Perfect, I've got all that. Someone from our team will give you a
// call back [today/shortly] to go over everything. Is there anything else I can help with?"

// ### URGENCY MESSAGING (IMPORTANT) ###
// For kids parties and buck parties, weave in genuine urgency naturally:
// - "Just giving you a heads up — [weekend dates/peak periods] do sell out pretty quickly."
// - "We'd definitely recommend locking in a date as soon as you can."
// - "Honestly these slots go fast, especially Saturday nights."
// Only say it once per call. Keep it genuine, not pushy.

// ### OFF-TOPIC HANDLING ###
// You ONLY handle LeMans Entertainment enquiries.
// For anything unrelated: "Ah sorry, I'm only set up for LeMans enquiries. Is there
// anything about the venue or events I can help you with?"

// ### SILENCE HANDLING ###
// If you receive a [SYSTEM: The user has been silent...] instruction:
// Speak exactly what it says, naturally and conversationally. Do not add extra content.

// ### HARD RULES ###
// - ONE question at a time
// - 1–2 sentences per response max
// - NEVER repeat the same transition twice in a call
// - ALWAYS call save_lead OR transfer_call before ending — never end without one
// - Corporate → transfer immediately
// - No promises on specific callback times unless instructed
// `;
//   }

//   // ─── Tool definitions ─────────────────────────────────────────────────────────

//   private getTransferCallTool() {
//     return {
//       type: 'function',
//       name: 'transfer_call',
//       description:
//         'Initiates a warm call transfer to the appropriate team based on the event type. Use immediately for corporate enquiries.',
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
//         'Saves caller enquiry details to the database and sends to ActiveCampaign. Call this when a transfer is not possible or when a non-corporate caller wants a callback.',
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
//         },
//         required: ['caller_name', 'event_type', 'enquiry_details'],
//       },
//     };
//   }

//   private getAnswerFaqTool() {
//     return {
//       type: 'function',
//       name: 'answer_faq',
//       description:
//         'Retrieves the answer to a common FAQ about LeMans Entertainment from the knowledge base.',
//       parameters: {
//         type: 'object',
//         properties: {
//           question_category: {
//             type: 'string',
//             enum: [
//               'opening_hours',
//               'directions',
//               'parking',
//               'kids_party',
//               'buck_party',
//               'corporate',
//               'pricing',
//               'booking',
//             ],
//             description: 'The category of the FAQ question',
//           },
//         },
//         required: ['question_category'],
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
  silenceRepromptCount: number;
  detectedEventType: EventType;
  callerNumber: string;
  /**
   * Set to true once save_lead or transfer_call has been dispatched.
   * The gateway uses this to apply a shorter silence timeout for the
   * final wrap-up turn (the bot is closing out, not waiting for a
   * meaningful answer — no need for the full 10-second wait).
   */
  isInWrapUp: boolean;
}

interface FunctionCallPayload {
  name: string;
  arguments: string;
  call_id: string;
}

// Transfer number map — populate from env or hardcode for POC
const TRANSFER_NUMBERS: Record<EventType, string | null> = {
  kids_party: process.env.TRANSFER_KIDS_PARTY ?? null,
  buck_party: process.env.TRANSFER_BUCK_PARTY ?? null,
  corporate: process.env.TRANSFER_CORPORATE ?? null,
  general_enquiry: process.env.TRANSFER_GENERAL ?? null,
  unknown: process.env.TRANSFER_GENERAL ?? null,
};

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
      this.logger.debug(
        `[${sessionId}] Silence ignored — response still active`,
      );
      return;
    }

    session.silenceRepromptCount += 1;

    if (session.silenceRepromptCount > this.MAX_SILENCE_REPROMPTS) {
      this.logger.log(
        `[${sessionId}] Max silence re-prompts reached — closing politely`,
      );
      this._injectAndRespond(
        sessionId,
        "It seems like you might have stepped away. No worries — feel free to call back whenever you're ready. Thanks for calling LeMans Entertainment, take care!",
      );
      setTimeout(() => this.closeSession(sessionId), 8_000);
      return;
    }

    const reprompt = this._buildSilenceReprompt(session);
    this.logger.log(
      `[${sessionId}] Silence #${session.silenceRepromptCount} — re-prompting: "${reprompt}"`,
    );
    this._injectAndRespond(sessionId, reprompt);
  }

  private _buildSilenceReprompt(session: RealtimeSession): string {
    const last = session.lastQuestionAsked?.trim();
    if (!last) {
      return "I guess you didn't hear that — are you still there?";
    }
    return `I guess you didn't hear that, let me repeat my question. ${last}`;
  }

  private _injectAndRespond(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.ws.readyState !== WebSocket.OPEN) return;

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
    const model = 'gpt-4o-mini-realtime-preview';
    const url = `wss://api.openai.com/v1/realtime?model=${model}`;
    const sessionStartedAtMs = Date.now();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      this.instrumentHandshake(sessionId, 'OpenAI', ws, sessionStartedAtMs);

      ws.on('open', () => {
        const openAiConnectedAtMs = Date.now();
        this.logger.log(
          `[${sessionId}] OpenAI connected in ${openAiConnectedAtMs - sessionStartedAtMs}ms`,
        );

        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              modalities: ['text'],
              instructions: this.getSystemPrompt(),
              input_audio_format: 'pcm16',
              turn_detection: {
                type: 'server_vad',
                threshold: 0.8,
                prefix_padding_ms: 300,
                silence_duration_ms: 2000,
              },
              tools: [
                this.getTransferCallTool(),
                this.getSaveLeadTool(),
                this.getAnswerFaqTool(),
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
          silenceRepromptCount: 0,
          detectedEventType: 'unknown',
          callerNumber,
          isInWrapUp: false,
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
        this.logger.log(
          `[${sessionId}] OpenAI WS closed: ${code} - ${reason}`,
        );
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
    session.ws.send(
      JSON.stringify({ type: 'input_audio_buffer.append', audio: base64Audio }),
    );
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
    const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_flash_v2_5&output_format=pcm_16000`;

    const elWs = new WebSocket(wsUrl);
    this.instrumentHandshake(
      sessionId,
      'ElevenLabs',
      elWs,
      session.sessionStartedAtMs,
    );

    elWs.on('open', () => {
      this.logger.log(`[${sessionId}] ElevenLabs connected`);
      session.elevenLabsConnectedAtMs = Date.now();

      elWs.send(
        JSON.stringify({
          text: ' ',
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.75,
            speed: 1.1,
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
            this.logger.log(
              `[${sessionId}] First audio at ${Date.now() - session.sessionStartedAtMs}ms`,
            );
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
      session.elevenLabsWs.send(
        JSON.stringify({ text, try_trigger_generation: true }),
      );
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
      this.logger.warn(
        `[${sessionId}] Error closing ElevenLabs WS: ${err.message}`,
      );
    }
    session.elevenLabsWs = null;
    session.elevenLabsReady = false;
    session.textBuffer = [];
  }

  // ─── Event hub ───────────────────────────────────────────────────────────────

  private async handleRealtimeEvent(
    sessionId: string,
    event: any,
  ): Promise<void> {
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

      case 'response.text.delta':
        if (session.elevenLabsReady) {
          this.sendTextToElevenLabs(sessionId, event.delta);
        } else {
          session.textBuffer.push(event.delta);
        }
        session.onEvent({ type: 'transcript-delta', delta: event.delta });
        break;

      case 'response.text.done':
        if (typeof event.text === 'string' && event.text.trim()) {
          session.lastQuestionAsked = event.text.trim();
        }
        this.flushElevenLabsStream(sessionId);
        // Tell the gateway whether the upcoming silence wait should use the
        // short wrap-up timeout or the normal 10-second conversation timeout.
        session.onEvent({
          type: 'response-type',
          isWrapUp: session.isInWrapUp,
        });
        session.onEvent({ type: 'transcript-done', transcript: event.text });
        break;

      case 'input_audio_buffer.speech_started':
        session.silenceRepromptCount = 0;
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
        session.onEvent({
          type: 'user-transcript',
          transcript: event.transcript,
        });
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
        this.logger.error(
          `[${sessionId}] OpenAI error: ${JSON.stringify(event.error)}`,
        );
        break;
    }
  }

  // ─── Function call dispatcher ────────────────────────────────────────────────

  private async handleFunctionCall(
    sessionId: string,
    event: FunctionCallPayload,
  ): Promise<void> {
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
      } else if (event.name === 'answer_faq') {
        await this.handleAnswerFaq(sessionId, args, event.call_id);
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
    session.detectedEventType = eventType;

    // Mark the session as being in wrap-up so the NEXT bot turn (the
    // farewell/confirmation message) uses the shorter silence timeout.
    session.isInWrapUp = true;

    this.logger.log(
      `[${sessionId}] Transfer requested — event_type: ${eventType}`,
    );

    const transferTo = TRANSFER_NUMBERS[eventType];

    if (transferTo) {
      this.logger.log(`[${sessionId}] Transferring to ${transferTo}`);
      session.onEvent({
        type: 'transfer-initiated',
        data: {
          event_type: eventType,
          transfer_to: transferTo,
          caller_name: args.caller_name,
          caller_number: session.callerNumber,
        },
      });

      this._sendFunctionResult(sessionId, callId, {
        success: true,
        message: `Transferring to the right team now.`,
        transfer_to: transferTo,
      });
    } else {
      // Transfer number not configured — fall back to lead capture
      this.logger.warn(
        `[${sessionId}] No transfer number for ${eventType} — saving lead instead`,
      );

      this._sendFunctionResult(sessionId, callId, {
        success: false,
        message:
          'Transfer unavailable right now — I will save your details instead.',
      });
    }

    session.ws.send(JSON.stringify({ type: 'response.create' }));
  }

  // ─── save_lead ───────────────────────────────────────────────────────────────

  private async handleSaveLead(
    sessionId: string,
    args: any,
    callId: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Mark the session as being in wrap-up so the NEXT bot turn (the
    // "someone will call you back" confirmation) uses the shorter silence timeout.
    session.isInWrapUp = true;

    this.logger.log(
      `[${sessionId}] Saving lead for: ${args.caller_name} | ${args.event_type}`,
    );

    const lead = await this.leadModel.create({
      callerName: args.caller_name,
      callerNumber: args.caller_number || session.callerNumber,
      eventType: args.event_type,
      eventDate: args.event_date,
      groupSize: args.group_size,
      enquiryDetails: args.enquiry_details,
      callId: sessionId,
      source: 'voice_agent',
    });

    this.logger.log(`[${sessionId}] Lead saved: ${lead._id}`);

    // Push to ActiveCampaign
    try {
      await this.activeCampaign.createContact({
        firstName: args.caller_name,
        phone: args.caller_number || session.callerNumber,
        tag: args.event_type,
        fieldValues: [
          { field: 'EVENT_TYPE', value: args.event_type },
          { field: 'EVENT_DATE', value: args.event_date ?? '' },
          { field: 'GROUP_SIZE', value: String(args.group_size ?? '') },
          { field: 'ENQUIRY', value: args.enquiry_details ?? '' },
        ],
      });
      this.logger.log(`[${sessionId}] ActiveCampaign contact created`);
    } catch (err) {
      this.logger.warn(
        `[${sessionId}] ActiveCampaign push failed: ${err.message}`,
      );
    }

    this._sendFunctionResult(sessionId, callId, {
      success: true,
      message: 'Lead saved. Our team will be in touch soon.',
    });

    session.ws.send(JSON.stringify({ type: 'response.create' }));
    session.onEvent({ type: 'lead-saved', data: args });
  }

  // ─── answer_faq ──────────────────────────────────────────────────────────────

  private async handleAnswerFaq(
    sessionId: string,
    args: any,
    callId: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const answer = this.resolveFaq(args.question_category);
    this.logger.log(
      `[${sessionId}] FAQ: ${args.question_category} → ${answer.substring(0, 80)}`,
    );

    this._sendFunctionResult(sessionId, callId, {
      success: true,
      answer,
    });

    session.ws.send(JSON.stringify({ type: 'response.create' }));
  }

  // ─── FAQ knowledge base ──────────────────────────────────────────────────────

  private resolveFaq(category: string): string {
    const kb: Record<string, string> = {
      opening_hours:
        'LeMans Entertainment is open 7 days a week. Monday to Friday 10am–10pm, Saturday and Sunday 9am–11pm. Public holidays may vary.',
      directions:
        'We are located at [ADDRESS]. Easiest access is via [MAIN ROAD]. Use the [LANDMARK] as your reference point.',
      parking:
        'Free parking is available on-site with over 100 spaces. There is also street parking available on nearby roads.',
      kids_party:
        'Our kids party packages start from $XX per child with a minimum of 10 kids. Packages include go-karting, food and a dedicated party host. Weekends book out fast so we recommend booking at least 3–4 weeks in advance.',
      buck_party:
        'Buck party packages are super popular and typically include racing, drinks on arrival, and a trophy presentation. Spots genuinely sell out months ahead, especially Friday and Saturday nights. Worth locking in ASAP.',
      corporate:
        'Our corporate packages are fully customisable — we do team building days, client entertainment, product launches and more. Our corporate sales team handles these personally to tailor the experience.',
      pricing:
        'Pricing depends on the package and group size. Our team can give you an exact quote based on your requirements. Would you like me to connect you with someone?',
      booking:
        'You can book online at our website or our team can take your details and call you back to confirm. Weekend and peak times sell out quickly — we recommend booking as soon as you can.',
    };

    return (
      kb[category] ??
      'That is a great question. Let me get the right person to help you with that.'
    );
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private _sendFunctionResult(
    sessionId: string,
    callId: string,
    output: object,
  ): void {
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
        this.logger.log(
          `[${sessionId}] ${provider} DNS lookup in ${Date.now() - startedAtMs}ms`,
        ),
      );
      socket.once('connect', () =>
        this.logger.log(
          `[${sessionId}] ${provider} TCP connect in ${Date.now() - startedAtMs}ms`,
        ),
      );
      (socket as TLSSocket).once('secureConnect', () =>
        this.logger.log(
          `[${sessionId}] ${provider} TLS handshake in ${Date.now() - startedAtMs}ms`,
        ),
      );
    };

    if (req.socket) attach(req.socket);
    req.once('socket', (s: NetSocket) => attach(s));
    ws.on('upgrade', () =>
      this.logger.log(
        `[${sessionId}] ${provider} WS upgrade in ${Date.now() - startedAtMs}ms`,
      ),
    );
  }

  // ─── System prompt ───────────────────────────────────────────────────────────

  private getSystemPrompt(): string {
    return `
=============================================================
ABSOLUTE RULE — ENGLISH ONLY
=============================================================
You MUST speak and respond in English at all times, no matter what.
If the caller uses another language, respond only in English.
=============================================================

### IDENTITY ###
You are Alex — the friendly voice receptionist for LeMans Entertainment Melbourne.
You answer the main enquiries line. You're warm, professional, and upbeat — like
the best person at the venue's front desk.

### AI DISCLOSURE ###
Do NOT volunteer that you are AI.
ONLY if directly asked "are you a robot?" or "are you AI?" respond honestly:
"Yeah, I'm actually an AI assistant for LeMans. I'll get you sorted just the same though!"
Then pivot straight back to helping them.

### PERSONALITY ###
- Friendly, upbeat, professional — like you love working at LeMans
- Short sentences. 1–2 sentences per response.
- Natural filler: "yeah", "absolutely", "no worries", "for sure"
- Match caller energy — excited with excited callers, reassuring with worried ones
- React genuinely before asking the next question — never go question-to-question

### WHAT LEMANS IS ###
LeMans Entertainment is a go-karting and entertainment venue in Melbourne.
They host kids parties, buck/hen parties, corporate events, and general fun visits.
Weekend and peak times sell out fast — this is a genuine, honest fact to share.

### EVENT TYPE CLASSIFICATION (INTERNAL — NEVER ANNOUNCE) ###
Silently classify every call into one of:
- kids_party      — birthday party, kids entertainment, school groups
- buck_party       — bucks night, hens night, bachelor/bachelorette
- corporate        — corporate team building, client entertainment, company event
- general_enquiry  — pricing, hours, directions, parking, casual visit

CORPORATE CALLS: Detect IMMEDIATELY. Warm transfer straight away to the sales
mobile. Do NOT ask lots of questions — just get their name and transfer.

### CALL FLOW ###

STEP 1 — GREET
"Hi, thanks for calling LeMans Entertainment! This is Alex speaking — how can I help you today?"

STEP 2 — IDENTIFY INTENT
Let them tell you what they need. Listen and classify silently.

STEP 3a — BASIC QUESTION (hours, parking, directions, general)
→ Call answer_faq with the appropriate question_category
→ Answer naturally from the result
→ Check if they need anything else
→ If they want to book/enquire further: get name + number + details → save_lead

STEP 3b — KIDS PARTY / BUCK PARTY enquiry
→ Ask 2–3 natural questions to understand their needs:
  - Approx number of people / group size
  - Preferred date or timeframe
  - Any specific requests
→ Mention genuinely that these book out fast: "Just so you know, weekends especially
  sell out pretty quickly — worth locking something in sooner rather than later."
→ Collect name and number
→ Call save_lead to capture the enquiry
→ Tell them the team will call back to confirm details

STEP 3c — CORPORATE enquiry
→ React warmly: "Oh nice, a corporate event — we love those!"
→ Get their name
→ Say: "I'll put you straight through to our corporate team who handle these personally."
→ Call transfer_call with event_type: "corporate"

STEP 3d — TRANSFER (any event type where transfer is appropriate)
→ Call transfer_call with the correct event_type
→ If transfer fails/unavailable: pivot to save_lead

STEP 4 — WRAP UP (if not transferred)
After saving lead: "Perfect, I've got all that. Someone from our team will give you a
call back [today/shortly] to go over everything. Is there anything else I can help with?"

### URGENCY MESSAGING (IMPORTANT) ###
For kids parties and buck parties, weave in genuine urgency naturally:
- "Just giving you a heads up — [weekend dates/peak periods] do sell out pretty quickly."
- "We'd definitely recommend locking in a date as soon as you can."
- "Honestly these slots go fast, especially Saturday nights."
Only say it once per call. Keep it genuine, not pushy.

### OFF-TOPIC HANDLING ###
You ONLY handle LeMans Entertainment enquiries.
For anything unrelated: "Ah sorry, I'm only set up for LeMans enquiries. Is there
anything about the venue or events I can help you with?"

### SILENCE HANDLING ###
If you receive a [SYSTEM: The user has been silent...] instruction:
Speak exactly what it says, naturally and conversationally. Do not add extra content.

### HARD RULES ###
- ONE question at a time
- 1–2 sentences per response max
- NEVER repeat the same transition twice in a call
- ALWAYS call save_lead OR transfer_call before ending — never end without one
- Corporate → transfer immediately
- No promises on specific callback times unless instructed
`;
  }

  // ─── Tool definitions ─────────────────────────────────────────────────────────

  private getTransferCallTool() {
    return {
      type: 'function',
      name: 'transfer_call',
      description:
        'Initiates a warm call transfer to the appropriate team based on the event type. Use immediately for corporate enquiries.',
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
            description: "Caller's name if collected",
          },
          transfer_reason: {
            type: 'string',
            description: 'Brief reason for the transfer',
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
        'Saves caller enquiry details to the database and sends to ActiveCampaign. Call this when a transfer is not possible or when a non-corporate caller wants a callback.',
      parameters: {
        type: 'object',
        properties: {
          caller_name: { type: 'string', description: "Caller's name" },
          caller_number: {
            type: 'string',
            description: "Caller's phone number",
          },
          event_type: {
            type: 'string',
            enum: [
              'kids_party',
              'buck_party',
              'corporate',
              'general_enquiry',
              'unknown',
            ],
          },
          event_date: {
            type: 'string',
            description: 'Preferred date or timeframe',
          },
          group_size: { type: 'number', description: 'Approximate group size' },
          enquiry_details: {
            type: 'string',
            description:
              'Full details of the enquiry including everything discussed',
          },
        },
        required: ['caller_name', 'event_type', 'enquiry_details'],
      },
    };
  }

  private getAnswerFaqTool() {
    return {
      type: 'function',
      name: 'answer_faq',
      description:
        'Retrieves the answer to a common FAQ about LeMans Entertainment from the knowledge base.',
      parameters: {
        type: 'object',
        properties: {
          question_category: {
            type: 'string',
            enum: [
              'opening_hours',
              'directions',
              'parking',
              'kids_party',
              'buck_party',
              'corporate',
              'pricing',
              'booking',
            ],
            description: 'The category of the FAQ question',
          },
        },
        required: ['question_category'],
      },
    };
  }
}