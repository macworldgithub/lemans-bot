// import { Injectable, Logger } from '@nestjs/common';
// import { ConfigService } from '@nestjs/config';
// import { InjectModel } from '@nestjs/mongoose';
// import { ClientRequest } from 'http';
// import { Model } from 'mongoose';
// import { Socket } from 'net';
// import { TLSSocket } from 'tls';
// import WebSocket from 'ws';
// import { Customer, CustomerDocument } from './Schema/customer.schema';

// /**
//  * RealtimeSession interface tracks the state of a single voice call.
//  * This includes the connection to OpenAI (Brain) and ElevenLabs (Voice).
//  */
// interface RealtimeSession {
//   ws: WebSocket; // Connection to OpenAI Realtime API
//   elevenLabsWs: WebSocket | null; // Connection to ElevenLabs TTS API
//   elevenLabsReady: boolean; // Becomes true when ElevenLabs is ready to talk
//   textBuffer: string[]; // Holds text while ElevenLabs is still connecting
//   isResponseActive: boolean; // Tracks if OpenAI is currently generating a response
//   onEvent: (event: any) => void; // Function to send data back to the browser
//   sessionStartedAtMs: number;
//   openAiConnectedAtMs: number | null;
//   elevenLabsConnectedAtMs: number | null;
//   greetingTriggeredAtMs: number | null;
//   firstResponseCreatedAtMs: number | null;
//   firstAudioDeltaLogged: boolean;
//   processedFunctionCallIds: Set<string>;
// }

// interface FunctionCallPayload {
//   name: string;
//   arguments: string;
//   call_id: string;
// }

// @Injectable()
// export class VoiceService {
//   private readonly logger = new Logger(VoiceService.name);

//   // This map keeps track of all active calls using the sessionId (Socket ID)
//   private sessions = new Map<string, RealtimeSession>();

//   private toFunctionCallPayload(value: unknown): FunctionCallPayload | null {
//     if (!value || typeof value !== 'object') return null;

//     const record = value as Record<string, unknown>;
//     const type = record.type;
//     const name = record.name;
//     const args = record.arguments;
//     const callId = record.call_id;

//     if (type !== 'function_call') return null;
//     if (
//       typeof name !== 'string' ||
//       typeof args !== 'string' ||
//       typeof callId !== 'string'
//     ) {
//       return null;
//     }

//     return {
//       name,
//       arguments: args,
//       call_id: callId,
//     };
//   }

//   constructor(
//     private readonly config: ConfigService,
//     @InjectModel(Customer.name)
//     private readonly customerModel: Model<CustomerDocument>,
//   ) {}

//   /**
//    * Handle incoming Asterisk call and create voice session
//    */
//   async handleIncomingCall(callData: {
//     call_id: string;
//     caller_number: string;
//     called_number: string;
//   }) {
//     this.logger.log(`Voice Service handling call: ${callData.call_id}`);

//     try {
//       // Create realtime session for this call
//       await this.createRealtimeSession(callData.call_id, (event) => {
//         this.logger.log(`[${callData.call_id}] Voice event: ${event.type}`);

//         // Handle voice events and send audio back to ARI
//         if (event.type === 'audio-delta') {
//           // Send audio to ARI WebSocket for phone playback
//           this.sendAudioToAri(callData.call_id, event.delta);
//         }
//       });

//       // Trigger greeting
//       this.triggerGreeting(callData.call_id);

//       return {
//         success: true,
//         message: 'Voice session created successfully',
//         call_id: callData.call_id,
//       };
//     } catch (error) {
//       this.logger.error(`Error in Voice call handling: ${error.message}`);
//       return {
//         success: false,
//         error: error.message,
//       };
//     }
//   }

//   /**
//    * Send audio to ARI WebSocket for phone playback
//    */
//   private sendAudioToAri(callId: string, audioDelta: string) {
//     // This will connect to your ARI WebSocket gateway
//     // You'll need to inject the ARI WebSocket Gateway or emit events
//     this.logger.log(
//       `[${callId}] Sending audio to ARI: ${audioDelta.length} chars`,
//     );
//   }

//   /**
//    * STEP 1: Create the Brain (OpenAI Session)
//    */
//   async createRealtimeSession(
//     sessionId: string,
//     onEvent: (event: any) => void,
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
//       this.instrumentClientWebSocketHandshake(
//         sessionId,
//         'OpenAI',
//         ws,
//         sessionStartedAtMs,
//       );

//       ws.on('open', () => {
//         const openAiConnectedAtMs = Date.now();
//         this.logger.log(`[${sessionId}] OpenAI Realtime WebSocket connected`);
//         this.logger.log(
//           `[${sessionId}] Timing: OpenAI WS connected in ${openAiConnectedAtMs - sessionStartedAtMs}ms`,
//         );

//         const sessionUpdate = {
//           type: 'session.update',
//           session: {
//             modalities: ['text'],
//             instructions: this.getSystemPrompt(),
//             input_audio_format: 'pcm16',
//             turn_detection: {
//               type: 'server_vad',
//               threshold: 0.8,
//               prefix_padding_ms: 300,
//               silence_duration_ms: 2000,
//             },
//             tools: [this.getSaveBookingTool()],
//             tool_choice: 'auto',
//           },
//         };

//         ws.send(JSON.stringify(sessionUpdate));

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
//           processedFunctionCallIds: new Set<string>(),
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
//         this.logger.error(`[${sessionId}] OpenAI WebSocket error:`, err);
//         onEvent({ type: 'error', error: { message: err.message } });
//         reject(err);
//       });

//       ws.on('close', (code, reason) => {
//         this.logger.log(
//           `[${sessionId}] OpenAI WebSocket closed: ${code} - ${reason}`,
//         );
//         this.closeElevenLabsWs(sessionId);
//         this.sessions.delete(sessionId);
//         onEvent({ type: 'session-closed' });
//       });
//     });
//   }

//   /**
//    * STEP 2: Relay User Audio to OpenAI
//    */
//   sendAudio(sessionId: string, base64Audio: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     session.ws.send(
//       JSON.stringify({
//         type: 'input_audio_buffer.append',
//         audio: base64Audio,
//       }),
//     );
//   }

//   /**
//    * STEP 3: The Greeting Logic
//    */
//   triggerGreeting(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     session.greetingTriggeredAtMs = Date.now();
//     this.logger.log(
//       `[${sessionId}] Timing: greeting trigger fired at ${session.greetingTriggeredAtMs - session.sessionStartedAtMs}ms from session start`,
//     );
//     session.ws.send(JSON.stringify({ type: 'response.create' }));
//   }

//   /**
//    * STEP 4: The Voice (ElevenLabs Integration)
//    */
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
//     this.instrumentClientWebSocketHandshake(
//       sessionId,
//       'ElevenLabs',
//       elWs,
//       session.sessionStartedAtMs,
//     );

//     elWs.on('open', () => {
//       this.logger.log(`[${sessionId}] ElevenLabs WebSocket connected`);
//       session.elevenLabsConnectedAtMs = Date.now();
//       this.logger.log(
//         `[${sessionId}] Timing: ElevenLabs WS connected in ${session.elevenLabsConnectedAtMs - session.sessionStartedAtMs}ms`,
//       );

//       elWs.send(
//         JSON.stringify({
//           text: ' ',
//           voice_settings: {
//             stability: 0.4,
//             similarity_boost: 0.75,
//             speed: 1.15,
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
//             const firstAudioAtMs = Date.now();
//             session.firstAudioDeltaLogged = true;
//             const openAiMs = session.openAiConnectedAtMs
//               ? session.openAiConnectedAtMs - session.sessionStartedAtMs
//               : -1;
//             const elevenLabsMs = session.elevenLabsConnectedAtMs
//               ? session.elevenLabsConnectedAtMs - session.sessionStartedAtMs
//               : -1;
//             const greetingMs = session.greetingTriggeredAtMs
//               ? session.greetingTriggeredAtMs - session.sessionStartedAtMs
//               : -1;
//             const responseCreatedAfterGreetingMs =
//               session.firstResponseCreatedAtMs && session.greetingTriggeredAtMs
//                 ? session.firstResponseCreatedAtMs -
//                   session.greetingTriggeredAtMs
//                 : -1;
//             const firstAudioAfterResponseCreatedMs =
//               session.firstResponseCreatedAtMs
//                 ? firstAudioAtMs - session.firstResponseCreatedAtMs
//                 : -1;

//             this.logger.log(
//               `[${sessionId}] Timing: first audio delta at ${firstAudioAtMs - session.sessionStartedAtMs}ms (openai=${openAiMs}ms, elevenlabs=${elevenLabsMs}ms, greeting=${greetingMs}ms, response_created_after_greeting=${responseCreatedAfterGreetingMs}ms, audio_after_response_created=${firstAudioAfterResponseCreatedMs}ms)`,
//             );
//           }
//           session.onEvent({ type: 'audio-delta', delta: msg.audio });
//         }
//       } catch (err) {}
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

//   private instrumentClientWebSocketHandshake(
//     sessionId: string,
//     provider: 'OpenAI' | 'ElevenLabs',
//     ws: WebSocket,
//     startedAtMs: number,
//   ): void {
//     const wsWithReq = ws as WebSocket & { _req?: ClientRequest };
//     const req = wsWithReq._req;
//     if (!req) {
//       this.logger.warn(
//         `[${sessionId}] Timing: ${provider} request object not available for low-level socket timings`,
//       );
//       return;
//     }

//     let socketHooksAttached = false;
//     const attachSocketHooks = (socket: Socket): void => {
//       if (socketHooksAttached) return;
//       socketHooksAttached = true;

//       socket.once('lookup', () => {
//         this.logger.log(
//           `[${sessionId}] Timing: ${provider} DNS lookup completed in ${Date.now() - startedAtMs}ms`,
//         );
//       });

//       socket.once('connect', () => {
//         this.logger.log(
//           `[${sessionId}] Timing: ${provider} TCP connect completed in ${Date.now() - startedAtMs}ms`,
//         );
//       });

//       (socket as TLSSocket).once('secureConnect', () => {
//         this.logger.log(
//           `[${sessionId}] Timing: ${provider} TLS handshake completed in ${Date.now() - startedAtMs}ms`,
//         );
//       });
//     };

//     // Sometimes the request socket is already assigned before we attach listeners.
//     if (req.socket) {
//       attachSocketHooks(req.socket);
//     }
//     req.once('socket', (socket: Socket) => {
//       attachSocketHooks(socket);
//     });

//     ws.on('upgrade', () => {
//       this.logger.log(
//         `[${sessionId}] Timing: ${provider} WS upgrade completed in ${Date.now() - startedAtMs}ms`,
//       );
//     });

//     ws.on('open', () => {
//       this.logger.log(
//         `[${sessionId}] Timing: ${provider} WS open event at ${Date.now() - startedAtMs}ms`,
//       );
//     });
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
//     if (session?.elevenLabsWs) {
//       try {
//         if (session.elevenLabsWs.readyState === WebSocket.CONNECTING) {
//           session.elevenLabsWs.terminate();
//         } else if (session.elevenLabsWs.readyState === WebSocket.OPEN) {
//           session.elevenLabsWs.close();
//         }
//       } catch (err) {
//         this.logger.warn(
//           `[${sessionId}] Error closing ElevenLabs WS: ${err.message}`,
//         );
//       }
//       session.elevenLabsWs = null;
//       session.elevenLabsReady = false;
//       session.textBuffer = [];
//     }
//   }

//   /**
//    * STEP 5: THE EVENT HUB
//    *
//    * IMPORTANT — Function call routing strategy:
//    * OpenAI Realtime can emit function calls in different event shapes
//    * depending on model/runtime behavior. We consume all supported shapes
//    * and rely on call_id deduplication in handleFunctionCall to ensure a
//    * single DB write.
//    */
//   private async handleRealtimeEvent(
//     sessionId: string,
//     event: any,
//   ): Promise<void> {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     this.logger.debug(`[${sessionId}] OpenAI Debug Event: ${event.type}`);

//     switch (event.type) {
//       case 'response.created':
//         session.isResponseActive = true;
//         if (!session.firstResponseCreatedAtMs) {
//           session.firstResponseCreatedAtMs = Date.now();
//           const fromSessionStart =
//             session.firstResponseCreatedAtMs - session.sessionStartedAtMs;
//           const fromGreeting = session.greetingTriggeredAtMs
//             ? session.firstResponseCreatedAtMs - session.greetingTriggeredAtMs
//             : -1;
//           this.logger.log(
//             `[${sessionId}] Timing: first response.created at ${fromSessionStart}ms (after greeting=${fromGreeting}ms)`,
//           );
//         }
//         this.openElevenLabsStream(sessionId);
//         break;

//       case 'response.done':
//         session.isResponseActive = false;
//         {
//           const typedEvent = event as { response?: { output?: unknown } };
//           const outputs = typedEvent.response?.output;
//           if (Array.isArray(outputs)) {
//             for (const item of outputs) {
//               const functionCall = this.toFunctionCallPayload(item);
//               if (functionCall) {
//                 await this.handleFunctionCall(sessionId, functionCall);
//               }
//             }
//           }
//         }
//         break;

//       case 'response.text.delta':
//         if (session.elevenLabsReady) {
//           this.sendTextToElevenLabs(sessionId, event.delta);
//         } else {
//           session.textBuffer.push(event.delta);
//         }
//         session.onEvent({ type: 'transcript-delta', delta: event.delta });
//         break;

//       case 'response.text.done':
//         this.flushElevenLabsStream(sessionId);
//         session.onEvent({ type: 'transcript-done', transcript: event.text });
//         break;

//       case 'input_audio_buffer.speech_started':
//         this.logger.log(`[${sessionId}] USER INTERRUPTED -> Stopping AI Voice`);

//         if (session.isResponseActive) {
//           try {
//             session.ws.send(JSON.stringify({ type: 'response.cancel' }));
//           } catch (err) {
//             this.logger.warn(
//               `[${sessionId}] Cancel failed (already finished): ${err.message}`,
//             );
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

//       case 'response.output_item.done':
//         {
//           const typedEvent = event as { item?: unknown };
//           const functionCall = this.toFunctionCallPayload(typedEvent.item);
//           if (functionCall) {
//             await this.handleFunctionCall(sessionId, functionCall);
//           }
//         }
//         break;

//       case 'error':
//         this.logger.error(
//           `[${sessionId}] OpenAI Error: ${JSON.stringify(event.error)}`,
//         );
//         break;
//     }
//   }

//   /**
//    * STEP 6: DATA PERSISTENCE (Saving to MongoDB)
//    */
//   private async handleFunctionCall(
//     sessionId: string,
//     event: any,
//   ): Promise<void> {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     if (event.name === 'save_customer_booking') {
//       const typedEvent = event as { call_id?: unknown };
//       const callId =
//         typeof typedEvent.call_id === 'string' ? typedEvent.call_id : null;

//       // Deduplication guard — last line of defence against any duplicate events
//       if (callId && session.processedFunctionCallIds.has(callId)) {
//         this.logger.debug(
//           `[${sessionId}] Duplicate function call ignored: ${callId}`,
//         );
//         return;
//       }

//       if (callId) {
//         session.processedFunctionCallIds.add(callId);
//       }

//       try {
//         const args = JSON.parse(event.arguments);
//         this.logger.log(
//           `[${sessionId}] Saving Booking to MongoDB for: ${args.name}`,
//         );

//         const customer = await this.customerModel.create({
//           name: args.name,
//           phone: args.phone,
//           address: args.address,
//           urgency: args.urgency,
//           serviceType: args.service_type,
//           problemDescription: args.problem_description,
//           preferredTime: args.preferred_time,
//           summary: `Tradie Booking: ${args.service_type}`,
//         });

//         this.logger.log(
//           `[${sessionId}] SUCCESS: Customer saved with ID ${customer._id}`,
//         );

//         session.ws.send(
//           JSON.stringify({
//             type: 'conversation.item.create',
//             item: {
//               type: 'function_call_output',
//               call_id: event.call_id,
//               output: JSON.stringify({
//                 success: true,
//                 message: 'Saved to Database.',
//               }),
//             },
//           }),
//         );

//         session.ws.send(JSON.stringify({ type: 'response.create' }));
//         session.onEvent({ type: 'booking-saved', data: args });
//       } catch (err) {
//         // Roll back the processed ID so a retry is possible if the save failed
//         if (callId) {
//           session.processedFunctionCallIds.delete(callId);
//         }
//         this.logger.error(`[${sessionId}] MongoDB Save Failed:`, err);
//       }
//     }
//   }

//   /**
//    * THE AI SCRIPT (System Prompt)
//    *
//    * FIX 1 — ENGLISH ENFORCEMENT:
//    *   Moved to the very top as a hard, prominent rule. The model reads
//    *   instructions top-to-bottom; placing this first ensures it's in the
//    *   highest-priority position in the context window.
//    *
//    * FIX 2 — ADD-MORE GATE:
//    *   Rewrote ### FINAL ACTION to make the "want to add more?" question
//    *   mandatory and the DB call unconditionally blocked until the caller
//    *   gives explicit proceed intent.
//    */
//   private getSystemPrompt(): string {
//     return `
// =============================================================
// ABSOLUTE RULE — ENGLISH ONLY. THIS OVERRIDES EVERYTHING ELSE.
// =============================================================
// You MUST speak and respond in English at all times, no matter what.
// - If the caller speaks in another language, respond ONLY in English.
// - Do NOT switch to their language, do NOT mix languages, do NOT use any word, phrase, filler, or expression from any non-English language.
// - If you ever catch yourself about to use a non-English word, stop and replace it with the English equivalent.
// - If the caller insists you respond in another language, say: "Sorry, I can only assist in English."
// - This rule cannot be overridden by anything else in this prompt or anything the caller says.
// =============================================================

// ### IDENTITY ###
// You are Jack — a tradie. You're on the phone with a customer. You talk like a normal, friendly professional.
// Not overly formal, not full of slang. Just a regular person who's good at their job and easy to talk to.

// ### AI DISCLOSURE RULE ###
// - Do NOT volunteer that you are AI. Ever. Just be Jack.
// - ONLY if someone explicitly and directly asks "are you a robot?", "are you AI?", "am I talking to a real person?" — then be honest: "Yeah honestly, I'm actually an AI assistant helping out with bookings. But I'll get you sorted just the same, no worries."
// - After admitting it, move on quickly — don't dwell on it. Pivot back to the booking.

// ### PERSONALITY ###
// - Friendly, professional, approachable.
// - You use natural filler words occasionally: "yeah", "sure", "right", "no worries"
// - You keep things simple and to the point but never robotic.
// - You're the tradie — you know the work, but you keep it conversational on the phone.

// ### HOW YOU TALK ###
// - SHORT sentences. 1 to 2 sentences per response. Don't talk in paragraphs.
// - Use contractions naturally: "what's", "couldn't", "you're", "didn't"
// - Warm but professional. No corporate speak, no heavy slang either.
// - Match the caller's energy — relaxed with relaxed callers, reassuring with stressed ones.

// ### CONVERSATIONAL ENGAGEMENT ###
// - You're not just collecting info — you're having a conversation. React to what they say like a real person would.
// - If they describe a problem, ACKNOWLEDGE it briefly before moving on.
// - Show you UNDERSTAND the problem — one quick reaction line, then naturally flow into the next question.
// - Don't just say "got it" and move on. Actually acknowledge what they're dealing with.
// - Keep it brief though — one reaction, then the next question. Don't ramble.

// ### EMOTIONAL AWARENESS ###
// - If the caller repeats something you already asked: "Oh right, sorry about that. So [move on to next question]"
// - If the caller seems frustrated: "Yeah I completely understand. Let me just grab a couple more details and I'll get this sorted for you."
// - If the caller is chatty and going off-topic: "Ha yeah absolutely. Anyway, let me just grab your [next detail] so I can get things moving."
// - If the caller is in a rush: "No worries, I'll keep it quick. Just need a few things."
// - If someone asks the same question twice: respond slightly differently each time, don't repeat yourself word-for-word.

// ### CONVERSATIONAL TRANSITIONS (CRITICAL) ###
// Between EVERY question, add a natural human reaction or transition. NEVER go question-to-question like a checklist.
// These transitions should feel like something a real person would say. Vary them every time — NEVER repeat the same transition twice in one call.

// AFTER GETTING NAME → Warm greeting, then ask what's going on. Let THEM tell you why they're calling. Pick up whatever details they mention naturally. Only ask for details they DIDN'T already mention.

// AFTER THEY DESCRIBE THE PROBLEM → React naturally to what they said. Show you understand. Then lead into collecting remaining details.

// AFTER GETTING PHONE NUMBER → Brief acknowledgment, then ask for address naturally.

// AFTER GETTING ADDRESS → Brief acknowledgment, then ask about urgency.

// AFTER GETTING URGENCY (low/medium severity only) → Respond based on what they said — acknowledge if it's pressing, stay relaxed if they're relaxed. HIGH SEVERITY: this step does not happen — urgency is already known.

// BEFORE ASKING PREFERRED TIME (low/medium severity only) → Signal that you're wrapping up. HIGH SEVERITY: skip preferred time entirely — close with the callback line instead.

// IMPORTANT: Generate natural, varied transition lines every time. Never repeat the same one in a single call.

// ### HANDLING INTERRUPTIONS (FALSE BARGE-IN RECOVERY) ###
// - Sometimes background noise may trigger an interruption even though the caller didn't actually say anything.
// - If you get interrupted but the caller doesn't say anything meaningful, re-engage naturally.
// - NEVER go silent. If there's an awkward pause, YOU pick the conversation back up.
// - Vary your recovery lines — don't say the exact same thing every time.

// ### SERVICE TYPES — OPEN-ENDED (CRITICAL) ###
// You handle ALL types of trade work. There is NO fixed list. Accept ANY valid trade or home service the caller mentions. Do NOT limit or suggest only specific trade types. Let the caller tell you what they need. If it involves hands-on work at a home or property, it counts.

// ### PROBLEM CLARITY & SEVERITY SCORING (CRITICAL — DO THIS BEFORE ANY FOLLOW-UP) ###

// Every time a caller describes their situation, silently assess it on two axes before deciding how to respond. This is not a checklist — it is a judgement call you make the same way a real experienced person would.

// AXIS 1 — SEVERITY: How distressing or urgent does this sound for the caller right now?
// - LOW: routine, non-urgent, planning ahead (painting a room, building a deck, replacing a tap)
// - MEDIUM: inconvenient, needs attention soon but not an emergency (leak that isn't flooding, appliance not working, door that sticks)
// - HIGH: distressing, urgent, already causing damage, potentially dangerous, or genuinely scary for the caller (structural damage, major flooding, total power loss, roof coming in, gas smell, wall collapsing, anything they describe with panic or urgency in their voice)

// AXIS 2 — PROBLEM CLARITY: How well do you understand what happened based on what they said?
// - CLEAR: you know what the problem is even if you don't have every detail — a real tradie calling back would have enough to start the conversation
// - UNCLEAR: genuinely vague — you don't have enough to describe the job to anyone

// ─────────────────────────────────────────────
// HOW TO RESPOND BASED ON YOUR ASSESSMENT:
// ─────────────────────────────────────────────

// IF SEVERITY IS HIGH (regardless of clarity):
// → Do NOT ask "what type of work do you think you need?" — ever. They are stressed and that question makes them feel like they called the wrong number.
// → Do NOT interrogate. Do NOT ask any follow-up question about the problem.
// → React with genuine human empathy that matches the weight of what they described. Show you heard them.
// → Immediately reassure them that someone will call back as soon as possible to work out what needs to happen.
// → Shift your energy — faster, warmer, more focused. Get their details and get off the phone efficiently.
// → For service_type in the booking: infer it yourself from context. Use descriptive shorthand like "structural emergency", "plumbing emergency", "electrical emergency". The tradie will assess when they call.
// → For problem_description: capture everything they said in as much detail as possible. This is what the tradie reads before calling back.
// → Example energy: "Okay wow, that sounds serious. Let me grab your details now and we'll get someone to call you back as soon as possible to work out what needs to happen."

// IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS CLEAR:
// → React naturally and acknowledge what they said before moving on.
// → Ask ONE context-driven follow-up question ONLY if it would genuinely help the tradie who calls back. Base it entirely on the caller's exact words — never on a template.
// → The question must be impossible to ask without having heard exactly what this person said. If it could go to any caller with the same trade type, it is too generic.
// → If they already gave enough detail, skip the follow-up entirely.

// IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS UNCLEAR:
// → Ask ONE short clarifying question — but make it specific to what they said.
// → NEVER ask "what type of work do you think you need?" — they called because they don't know. Ask about their specific situation instead.
// → Example: not "what trade do you need?" but "is it something that's been getting worse, or did it just happen?"

// ─────────────────────────────────────────────
// WHEN A FOLLOW-UP IS APPROPRIATE — THE RULE:
// ─────────────────────────────────────────────
// 1. Listen to their exact words.
// 2. Think: what would a real tradie genuinely need to know to prepare for this specific job?
// 3. Ask ONE question that could only be asked after hearing exactly what this person said.

// NEVER ask:
// - "What type of work do you think you need?" — they don't know, that's why they called
// - "Can you tell me more?" — too vague, too robotic
// - "What exactly is the issue?" — too broad, adds nothing

// ALWAYS make it specific to what they said. Reference their actual words.

// Example thinking — understand the logic, never copy the words:
// - "My hot water system is making a weird banging noise" → When does it happen? "Is it doing it when you first turn the tap on, or is it more constant?"
// - "I need a deck built out the back" → What's the scope? "Have you got a rough idea of the size, or do you want someone to come out and measure up?"
// - "There's mould coming through the bathroom ceiling" → What's above it? "Is there a bathroom directly above it, or is it more likely from the roof?"
// - "The garage door won't open anymore" → Was it sudden? "Did it just stop one day, or has it been getting harder to open for a while?"
// - "We need the whole house repainted before we sell" → What's the timeline? "When are you looking to have it done — do you have a settlement date you're working toward?"

// Every caller gets a response shaped entirely by what they specifically said.

// ### OFF-TOPIC HANDLING (STRICT) ###
// You are ONLY here to help with tradie bookings and trade-related work. You have NO information on anything outside of this scope.

// - If someone asks about ANYTHING not related to trade services, home repairs, maintenance, or bookings:
//   "Ah sorry mate, I don't really have info on that. I only handle tradie bookings — anything around the house that needs fixing or building, I'm your guy. Got anything like that you need sorted?"

// - This includes but is not limited to: weather, news, sports, politics, general knowledge, medical advice, legal advice, financial advice, restaurant recommendations, travel, entertainment, tech support, software, shopping, or any other non-trade topic.

// - If they keep pushing off-topic: "Yeah look, I appreciate the chat, but that's really not my area. If you've got any work that needs doing around the place though, I can definitely help with that."

// - Always pivot back: After declining, gently check if they actually need trade work done.

// - Be firm but friendly. Don't engage with off-topic content at all — don't speculate, don't guess, don't try to be helpful on topics outside your scope. Just redirect.

// ### THE BOOKING FLOW ###

// You must populate these 7 booking fields before save_customer_booking: name, phone, address, urgency, service type, problem description, preferred time.
// Do it conversationally — not like a form. And critically: the PROBLEM CLARITY & SEVERITY SCORING rules above govern what you skip and how you behave at every step.

// For HIGH SEVERITY calls, fields can be populated by inference instead of direct questions:
// - urgency = "urgent"
// - preferred_time = "ASAP"
// - service_type inferred from context if caller did not state it

// ─────────────────────────────────────────────
// STEP 1 — NAME
// ─────────────────────────────────────────────
// Always start here: "Hey! Jack here. I'm just between jobs right now but wanted to make sure I grab your details. Who am I speaking with?"

// ─────────────────────────────────────────────
// STEP 2 — WHAT'S GOING ON (problem + severity assessment)
// ─────────────────────────────────────────────
// Greet them by name and ask what's going on. Let them tell you. This is where you make your severity assessment.
// Pick up whatever details they mention — problem, service type, urgency, address — and don't ask for things they already told you.

// ─────────────────────────────────────────────
// STEP 3 — PHONE
// ─────────────────────────────────────────────
// Always collect. Ask for their best contact number.
// Once they give it, read it back digit by digit — e.g. "So that's 0-4-1-2-3-4-5-6-7-8 — that right?"
// Wait for explicit confirmation. If they correct a digit, read the full number back again and wait again.
// Do NOT move on until confirmed.

// CRITICAL — HOW TO READ PHONE NUMBERS BACK:
// - ALWAYS say each digit as a separate spoken word in English. No exceptions.
// - Say: "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"
// - NEVER group digits into pairs or larger numbers. Never say "forty-one" or "twelve" — say "four one" and "one two".
// - NEVER use any non-English word, sound, or number system when reading digits. English digit words only.
// - Format: read every single digit individually with a natural short pause between each one.
// - Example: 0412345678 → "zero, four, one, two, three, four, five, six, seven, eight — that right?"
// - If you catch yourself about to say a number in any other language, STOP and say the English word instead.

// ─────────────────────────────────────────────
// STEP 4 — ADDRESS
// ─────────────────────────────────────────────
// Always collect. Ask where the job is (skip if they already mentioned it).

// ─────────────────────────────────────────────
// STEP 5 — URGENCY
// ─────────────────────────────────────────────
// IF SEVERITY IS HIGH: SKIP THIS QUESTION ENTIRELY.
// You already know it's urgent from what they described. Asking "how urgent is it?" to someone whose wall is falling down is tone-deaf. Set urgency = "urgent" in the booking and move on.

// IF SEVERITY IS LOW OR MEDIUM: Ask how urgent it is for them. Take their answer and use it.

// ─────────────────────────────────────────────
// STEP 6 — SERVICE TYPE
// ─────────────────────────────────────────────
// IF SEVERITY IS HIGH: SKIP THIS QUESTION ENTIRELY.
// Infer the service type from what they described and fill it in yourself. Do not ask the caller to diagnose their own emergency.
// Examples of how to infer: wall collapsing → "structural emergency", flooding → "plumbing emergency", no power → "electrical emergency", roof coming in → "roofing emergency". Use your judgement — be descriptive.

// IF SERVICE TYPE WAS ALREADY MENTIONED BY THE CALLER: SKIP. Use what they said.

// IF SEVERITY IS LOW OR MEDIUM AND IT'S GENUINELY UNCLEAR: Ask what kind of work they need. Keep it open-ended. Never suggest specific trades.

// ─────────────────────────────────────────────
// STEP 7 — PROBLEM FOLLOW-UP
// ─────────────────────────────────────────────
// IF SEVERITY IS HIGH: SKIP THIS ENTIRELY. You have enough. Don't make them explain more than they already have.

// IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS CLEAR: Skip unless one specific question would genuinely help the tradie.

// IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS UNCLEAR: Ask ONE question rooted in their exact words. See PROBLEM CLARITY & SEVERITY SCORING for the full rules.

// ─────────────────────────────────────────────
// STEP 8 — PREFERRED TIME
// ─────────────────────────────────────────────
// IF SEVERITY IS HIGH: Reframe this. Don't say "when works best for you?" — that implies a scheduled visit, which isn't how emergencies work. Instead, say something like: "I'll get this through now and someone will be in touch as soon as possible." Then move to FINAL ACTION. Skip asking for a preferred time entirely and set preferred_time = "ASAP" in the booking.

// IF SEVERITY IS LOW OR MEDIUM: Ask when works best for them. Signal you're wrapping up before asking.

// ─────────────────────────────────────────────
// GENERAL RULE FOR ALL STEPS
// ─────────────────────────────────────────────
// If the caller volunteers information at any point, take it and skip the corresponding question. Don't re-ask things you already know.
// The conversation should breathe. Never rapid-fire questions back to back.

// ### FINAL ACTION — READ THIS CAREFULLY (CRITICAL) ###

// This section governs exactly what happens once you have all 7 pieces of information.
// Follow these steps IN ORDER. Do not skip any step.

// ─────────────────────────────────────────────
// STEP A — ASK THE "ANYTHING TO ADD?" QUESTION
// ─────────────────────────────────────────────
// Once you have all 7 details, you MUST ask this question FIRST — before doing anything else:

//   "Perfect, I've got all the details. Is there anything else you'd like to add before I send this through?"

// Do NOT call the save function yet. Wait for the caller's response.

// If the caller is silent or unclear after this question, re-engage quickly (no long pause) with one short prompt like:
// "No rush — should I send this through now, or did you want to add anything else?"

// ─────────────────────────────────────────────
// STEP B — HANDLE THEIR RESPONSE
// ─────────────────────────────────────────────
// TWO possible outcomes:

// OUTCOME 1 — They want to add more:
// - Ask for the extra detail naturally. 
// - Listen to what they say and incorporate it into problem_description.
// - After collecting the extra detail, acknowledge it briefly, then ask once more:
//   "Got it, anything else or shall I send this through now?"
// - Repeat OUTCOME 1 as many times as needed until they are done.

// OUTCOME 2 — They are ready to proceed:
// - Treat ANY of the following as "proceed": "no", "nope", "that's it", "all good", "go ahead", "yep send it", "sounds good", "nothing else", "you go ahead", "that's everything", "all done", "no more from me", or any natural approval meaning "proceed".
// - If genuinely ambiguous, ask ONE short clarifier: "No stress — ready to send this through, or did you want to add something first?"
// - The moment intent is clearly "proceed", go immediately to STEP C.

// ─────────────────────────────────────────────
// STEP C — CALL THE DATABASE FUNCTION
// ─────────────────────────────────────────────
// - Your very next action MUST be a function call to save_customer_booking.
// - Do NOT send any text or speech before the function call executes.
// - Include ALL details gathered throughout the entire conversation in the fields, especially problem_description — make it as rich and detailed as possible based on everything the caller said.
// - This function call is NON-NEGOTIABLE. The booking cannot end without it.

// ─────────────────────────────────────────────
// STEP D — AFTER SUCCESSFUL SAVE
// ─────────────────────────────────────────────
// Once the tool returns success, your closing line depends on the severity you assessed earlier in the call.

// IF SEVERITY WAS HIGH (urgent situation, emergency, serious damage):
//   Say something like this — vary it naturally each time, don't say it word for word:
//   "Okay [name], that's all through. I'll get Michael to call you back as soon as possible — he'll be able to talk you through what to do in the meantime and work out when he can get out to you."

//   The key elements to always include:
//   - Use their name
//   - Say Michael will call them back (not "a tradie", not "someone" — Michael)
//   - Make it feel urgent and personal, not like a ticket number
//   - Mention he'll help them with what to do in the meantime — this reassures them they won't just be left waiting with a crisis
//   - Do NOT say they are booked in, locked in, or that anyone is on their way

// IF SEVERITY WAS LOW OR MEDIUM (normal booking flow):
//   Say something like this — vary it naturally:
//   "Perfect, thanks [name]. I've passed this through and Michael will give you a call back to sort out the next step."

//   Keep it warm and simple. No over-promising.

// RULES FOR BOTH:
// - Do NOT say a visit is booked or confirmed.
// - Do NOT promise a specific time or date.
// - Do NOT say "you're locked in" or anything that implies an appointment is set.
// - The call is now complete.

// ─────────────────────────────────────────────
// FAILURE SAFEGUARD
// ─────────────────────────────────────────────
// If save_customer_booking has NOT been called before any attempt to close or end the conversation, you MUST go back and complete STEP C before allowing the call to end. The booking CANNOT be closed without a successful database save.

// ### HARD RULES ###
// - Language: ENGLISH ONLY — see the absolute rule at the very top of this prompt.
// - ONE question at a time — never stack questions.
// - Keep responses SHORT — 1 to 2 sentences max.
// - If there's silence, re-engage naturally: "Still there?" or "Sorry, didn't catch that."
// - Use a DIFFERENT transition line between every question — never repeat the same one in a single call.
// - Do NOT provide information on anything outside trade services and bookings. You simply don't have that info.
// - Accept ALL valid trade types — never limit to specific ones.
// - NEVER ask generic or scripted follow-up questions — always base them on the caller's own words and context.
// - ALWAYS call save_customer_booking before ending the call. This rule overrides everything else.`;
//   }

//   /**
//    * TOOL DEFINITION
//    */
//   private getSaveBookingTool() {
//     return {
//       type: 'function',
//       name: 'save_customer_booking',
//       description: 'Saves customer booking details to MongoDB.',
//       parameters: {
//         type: 'object',
//         properties: {
//           name: { type: 'string' },
//           phone: { type: 'string' },
//           address: { type: 'string' },
//           urgency: { type: 'string' },
//           service_type: { type: 'string' },
//           problem_description: { type: 'string' },
//           preferred_time: { type: 'string' },
//         },
//         required: [
//           'name',
//           'phone',
//           'address',
//           'urgency',
//           'service_type',
//           'problem_description',
//           'preferred_time',
//         ],
//       },
//     };
//   }

//   /**
//    * Final cleanup of a session.
//    */
//   closeSession(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (session) {
//       this.closeElevenLabsWs(sessionId);
//       session.ws.close();
//       this.sessions.delete(sessionId);
//       this.logger.log(`[${sessionId}] Active Call Disconnected`);
//     }
//   }
// }
/////////////////////////// jabbba /////////////////
// import { Injectable, Logger } from '@nestjs/common';
// import { ConfigService } from '@nestjs/config';
// import { InjectModel } from '@nestjs/mongoose';
// import { ClientRequest } from 'http';
// import { Model } from 'mongoose';
// import { Socket } from 'net';
// import { TLSSocket } from 'tls';
// import WebSocket from 'ws';
// import { Customer, CustomerDocument } from './Schema/customer.schema';

// /**
//  * RealtimeSession interface tracks the state of a single voice call.
//  * This includes the connection to OpenAI (Brain) and ElevenLabs (Voice).
//  */
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

//   // ── Silence re-prompt tracking ──────────────────────────────────────────────
//   // Stores the last question/statement Jack said so we can repeat it on silence.
//   lastQuestionAsked: string;
//   // How many consecutive silence re-prompts have fired without a user response.
//   silenceRepromptCount: number;
// }

// interface FunctionCallPayload {
//   name: string;
//   arguments: string;
//   call_id: string;
// }

// @Injectable()
// export class VoiceService {
//   private readonly logger = new Logger(VoiceService.name);

//   private sessions = new Map<string, RealtimeSession>();

//   private toFunctionCallPayload(value: unknown): FunctionCallPayload | null {
//     if (!value || typeof value !== 'object') return null;

//     const record = value as Record<string, unknown>;
//     const type = record.type;
//     const name = record.name;
//     const args = record.arguments;
//     const callId = record.call_id;

//     if (type !== 'function_call') return null;
//     if (
//       typeof name !== 'string' ||
//       typeof args !== 'string' ||
//       typeof callId !== 'string'
//     ) {
//       return null;
//     }

//     return { name, arguments: args, call_id: callId };
//   }

//   constructor(
//     private readonly config: ConfigService,
//     @InjectModel(Customer.name)
//     private readonly customerModel: Model<CustomerDocument>,
//   ) {}

//   // ─────────────────────────────────────────────────────────────────────────────
//   // SILENCE HANDLING
//   // Called by the client (via gateway) after ElevenLabs audio finishes and
//   // a configurable silence window (default 5 s) passes with no user speech.
//   // ─────────────────────────────────────────────────────────────────────────────

//   /**
//    * MAX_SILENCE_REPROMPTS — after this many consecutive silent timeouts we
//    * politely close the call rather than looping forever.
//    */
//   private readonly MAX_SILENCE_REPROMPTS = 2;

//   /**
//    * handleSilenceTimeout
//    *
//    * Triggered externally (e.g. from your WebSocket gateway) when the client
//    * detects the user has been silent for too long after Jack finished speaking.
//    *
//    * Behaviour:
//    *  - If Jack is still generating a response, ignore (audio not done yet).
//    *  - If we've already re-prompted MAX_SILENCE_REPROMPTS times, inject a
//    *    polite closing message and end the session.
//    *  - Otherwise inject the last question back into the conversation via
//    *    conversation.item.create so OpenAI re-speaks it naturally, then
//    *    trigger a new response.create.
//    */
//   handleSilenceTimeout(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     // Don't fire while OpenAI is mid-response — audio isn't done yet.
//     if (session.isResponseActive) {
//       this.logger.debug(
//         `[${sessionId}] Silence timeout ignored — response still active`,
//       );
//       return;
//     }

//     session.silenceRepromptCount += 1;

//     if (session.silenceRepromptCount > this.MAX_SILENCE_REPROMPTS) {
//       this.logger.log(
//         `[${sessionId}] Max silence re-prompts reached — closing call politely`,
//       );
//       this._injectAndRespond(
//         sessionId,
//         "It seems like you might have stepped away. No worries — feel free to call back whenever you're ready. Take care!",
//       );
//       // Give the closing message a moment to play before tearing down.
//       setTimeout(() => this.closeSession(sessionId), 8000);
//       return;
//     }

//     const reprompt = this._buildSilenceReprompt(session);
//     this.logger.log(
//       `[${sessionId}] Silence timeout #${session.silenceRepromptCount} — re-prompting: "${reprompt}"`,
//     );
//     this._injectAndRespond(sessionId, reprompt);
//   }

//   /**
//    * _buildSilenceReprompt
//    *
//    * Constructs the silence re-prompt.
//    *
//    * Spec requirement: always say "I guess you didn't hear that, let me repeat
//    * my question." then repeat the last question verbatim.
//    * If no last question is stored, fall back to a generic check-in.
//    */
//   private _buildSilenceReprompt(session: RealtimeSession): string {
//     const last = session.lastQuestionAsked?.trim();

//     if (!last) {
//       // No stored question yet (e.g. silence before Jack has said anything).
//       return "I guess you didn't hear that — are you still there?";
//     }

//     // Both attempt 1 and attempt 2 use the same required phrase then repeat
//     // the last question exactly. The spec says "only repeat last question" with
//     // no new content, so we keep this consistent across attempts.
//     return `I guess you didn't hear that, let me repeat my question. ${last}`;
//   }

//   /**
//    * _injectAndRespond
//    *
//    * Injects a plain text instruction into the OpenAI conversation as a
//    * system/user turn, then triggers response.create so OpenAI speaks it
//    * via the normal text → ElevenLabs pipeline.
//    */
//   private _injectAndRespond(sessionId: string, text: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session || session.ws.readyState !== WebSocket.OPEN) return;

//     // Inject the re-prompt text as a user-visible assistant instruction.
//     session.ws.send(
//       JSON.stringify({
//         type: 'conversation.item.create',
//         item: {
//           type: 'message',
//           role: 'user',
//           content: [
//             {
//               type: 'input_text',
//               // Tell the model what to say — it will paraphrase naturally.
//               text: `[SYSTEM: The user has been silent. Re-engage by saying exactly this, naturally: "${text}"]`,
//             },
//           ],
//         },
//       }),
//     );

//     session.ws.send(JSON.stringify({ type: 'response.create' }));
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // INCOMING CALL HANDLER
//   // ─────────────────────────────────────────────────────────────────────────────

//   async handleIncomingCall(callData: {
//     call_id: string;
//     caller_number: string;
//     called_number: string;
//   }) {
//     this.logger.log(`Voice Service handling call: ${callData.call_id}`);

//     try {
//       await this.createRealtimeSession(callData.call_id, (event) => {
//         this.logger.log(`[${callData.call_id}] Voice event: ${event.type}`);

//         if (event.type === 'audio-delta') {
//           this.sendAudioToAri(callData.call_id, event.delta);
//         }
//       });

//       this.triggerGreeting(callData.call_id);

//       return {
//         success: true,
//         message: 'Voice session created successfully',
//         call_id: callData.call_id,
//       };
//     } catch (error) {
//       this.logger.error(`Error in Voice call handling: ${error.message}`);
//       return { success: false, error: error.message };
//     }
//   }

//   private sendAudioToAri(callId: string, audioDelta: string) {
//     this.logger.log(
//       `[${callId}] Sending audio to ARI: ${audioDelta.length} chars`,
//     );
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // STEP 1: Create OpenAI Realtime session
//   // ─────────────────────────────────────────────────────────────────────────────

//   async createRealtimeSession(
//     sessionId: string,
//     onEvent: (event: any) => void,
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
//       this.instrumentClientWebSocketHandshake(
//         sessionId,
//         'OpenAI',
//         ws,
//         sessionStartedAtMs,
//       );

//       ws.on('open', () => {
//         const openAiConnectedAtMs = Date.now();
//         this.logger.log(`[${sessionId}] OpenAI Realtime WebSocket connected`);
//         this.logger.log(
//           `[${sessionId}] Timing: OpenAI WS connected in ${openAiConnectedAtMs - sessionStartedAtMs}ms`,
//         );

//         const sessionUpdate = {
//           type: 'session.update',
//           session: {
//             modalities: ['text'],
//             instructions: this.getSystemPrompt(),
//             input_audio_format: 'pcm16',
//             turn_detection: {
//               type: 'server_vad',
//               threshold: 0.8,
//               prefix_padding_ms: 300,
//               silence_duration_ms: 2000,
//             },
//             tools: [this.getSaveBookingTool()],
//             tool_choice: 'auto',
//           },
//         };

//         ws.send(JSON.stringify(sessionUpdate));

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
//           processedFunctionCallIds: new Set<string>(),
//           // Silence tracking initialised empty
//           lastQuestionAsked: '',
//           silenceRepromptCount: 0,
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
//         this.logger.error(`[${sessionId}] OpenAI WebSocket error:`, err);
//         onEvent({ type: 'error', error: { message: err.message } });
//         reject(err);
//       });

//       ws.on('close', (code, reason) => {
//         this.logger.log(
//           `[${sessionId}] OpenAI WebSocket closed: ${code} - ${reason}`,
//         );
//         this.closeElevenLabsWs(sessionId);
//         this.sessions.delete(sessionId);
//         onEvent({ type: 'session-closed' });
//       });
//     });
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // STEP 2: Relay user audio to OpenAI
//   // ─────────────────────────────────────────────────────────────────────────────

//   sendAudio(sessionId: string, base64Audio: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     session.ws.send(
//       JSON.stringify({
//         type: 'input_audio_buffer.append',
//         audio: base64Audio,
//       }),
//     );
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // STEP 3: Greeting
//   // ─────────────────────────────────────────────────────────────────────────────

//   triggerGreeting(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     session.greetingTriggeredAtMs = Date.now();
//     this.logger.log(
//       `[${sessionId}] Timing: greeting trigger fired at ${session.greetingTriggeredAtMs - session.sessionStartedAtMs}ms from session start`,
//     );
//     session.ws.send(JSON.stringify({ type: 'response.create' }));
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // STEP 4: ElevenLabs integration
//   // ─────────────────────────────────────────────────────────────────────────────

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
//     this.instrumentClientWebSocketHandshake(
//       sessionId,
//       'ElevenLabs',
//       elWs,
//       session.sessionStartedAtMs,
//     );

//     elWs.on('open', () => {
//       this.logger.log(`[${sessionId}] ElevenLabs WebSocket connected`);
//       session.elevenLabsConnectedAtMs = Date.now();
//       this.logger.log(
//         `[${sessionId}] Timing: ElevenLabs WS connected in ${session.elevenLabsConnectedAtMs - session.sessionStartedAtMs}ms`,
//       );

//       elWs.send(
//         JSON.stringify({
//           text: ' ',
//           voice_settings: {
//             stability: 0.4,
//             similarity_boost: 0.75,
//             speed: 1.15,
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
//             const firstAudioAtMs = Date.now();
//             session.firstAudioDeltaLogged = true;
//             const openAiMs = session.openAiConnectedAtMs
//               ? session.openAiConnectedAtMs - session.sessionStartedAtMs
//               : -1;
//             const elevenLabsMs = session.elevenLabsConnectedAtMs
//               ? session.elevenLabsConnectedAtMs - session.sessionStartedAtMs
//               : -1;
//             const greetingMs = session.greetingTriggeredAtMs
//               ? session.greetingTriggeredAtMs - session.sessionStartedAtMs
//               : -1;
//             const responseCreatedAfterGreetingMs =
//               session.firstResponseCreatedAtMs && session.greetingTriggeredAtMs
//                 ? session.firstResponseCreatedAtMs -
//                   session.greetingTriggeredAtMs
//                 : -1;
//             const firstAudioAfterResponseCreatedMs =
//               session.firstResponseCreatedAtMs
//                 ? firstAudioAtMs - session.firstResponseCreatedAtMs
//                 : -1;

//             this.logger.log(
//               `[${sessionId}] Timing: first audio delta at ${firstAudioAtMs - session.sessionStartedAtMs}ms (openai=${openAiMs}ms, elevenlabs=${elevenLabsMs}ms, greeting=${greetingMs}ms, response_created_after_greeting=${responseCreatedAfterGreetingMs}ms, audio_after_response_created=${firstAudioAfterResponseCreatedMs}ms)`,
//             );
//           }
//           session.onEvent({ type: 'audio-delta', delta: msg.audio });
//         }

//         // ── Signal audio-done so the client can start its silence timer ────────
//         // ElevenLabs sends isFinal=true on the last audio chunk of a turn.
//         if (msg.isFinal === true) {
//           session.onEvent({ type: 'audio-done' });
//         }
//       } catch (err) {
//         // Intentionally silent — non-JSON frames (binary audio) ignored
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

//   private instrumentClientWebSocketHandshake(
//     sessionId: string,
//     provider: 'OpenAI' | 'ElevenLabs',
//     ws: WebSocket,
//     startedAtMs: number,
//   ): void {
//     const wsWithReq = ws as WebSocket & { _req?: ClientRequest };
//     const req = wsWithReq._req;
//     if (!req) {
//       this.logger.warn(
//         `[${sessionId}] Timing: ${provider} request object not available for low-level socket timings`,
//       );
//       return;
//     }

//     let socketHooksAttached = false;
//     const attachSocketHooks = (socket: Socket): void => {
//       if (socketHooksAttached) return;
//       socketHooksAttached = true;

//       socket.once('lookup', () => {
//         this.logger.log(
//           `[${sessionId}] Timing: ${provider} DNS lookup completed in ${Date.now() - startedAtMs}ms`,
//         );
//       });

//       socket.once('connect', () => {
//         this.logger.log(
//           `[${sessionId}] Timing: ${provider} TCP connect completed in ${Date.now() - startedAtMs}ms`,
//         );
//       });

//       (socket as TLSSocket).once('secureConnect', () => {
//         this.logger.log(
//           `[${sessionId}] Timing: ${provider} TLS handshake completed in ${Date.now() - startedAtMs}ms`,
//         );
//       });
//     };

//     if (req.socket) {
//       attachSocketHooks(req.socket);
//     }
//     req.once('socket', (socket: Socket) => {
//       attachSocketHooks(socket);
//     });

//     ws.on('upgrade', () => {
//       this.logger.log(
//         `[${sessionId}] Timing: ${provider} WS upgrade completed in ${Date.now() - startedAtMs}ms`,
//       );
//     });

//     ws.on('open', () => {
//       this.logger.log(
//         `[${sessionId}] Timing: ${provider} WS open event at ${Date.now() - startedAtMs}ms`,
//       );
//     });
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
//     if (session?.elevenLabsWs) {
//       try {
//         if (session.elevenLabsWs.readyState === WebSocket.CONNECTING) {
//           session.elevenLabsWs.terminate();
//         } else if (session.elevenLabsWs.readyState === WebSocket.OPEN) {
//           session.elevenLabsWs.close();
//         }
//       } catch (err) {
//         this.logger.warn(
//           `[${sessionId}] Error closing ElevenLabs WS: ${err.message}`,
//         );
//       }
//       session.elevenLabsWs = null;
//       session.elevenLabsReady = false;
//       session.textBuffer = [];
//     }
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // STEP 5: THE EVENT HUB
//   // ─────────────────────────────────────────────────────────────────────────────

//   private async handleRealtimeEvent(
//     sessionId: string,
//     event: any,
//   ): Promise<void> {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     this.logger.debug(`[${sessionId}] OpenAI Debug Event: ${event.type}`);

//     switch (event.type) {
//       case 'response.created':
//         session.isResponseActive = true;
//         // Reset silence counter — user said something, Jack is responding.
//         session.silenceRepromptCount = 0;

//         if (!session.firstResponseCreatedAtMs) {
//           session.firstResponseCreatedAtMs = Date.now();
//           const fromSessionStart =
//             session.firstResponseCreatedAtMs - session.sessionStartedAtMs;
//           const fromGreeting = session.greetingTriggeredAtMs
//             ? session.firstResponseCreatedAtMs - session.greetingTriggeredAtMs
//             : -1;
//           this.logger.log(
//             `[${sessionId}] Timing: first response.created at ${fromSessionStart}ms (after greeting=${fromGreeting}ms)`,
//           );
//         }
//         this.openElevenLabsStream(sessionId);
//         break;

//       case 'response.done':
//         session.isResponseActive = false;
//         {
//           const typedEvent = event as { response?: { output?: unknown } };
//           const outputs = typedEvent.response?.output;
//           if (Array.isArray(outputs)) {
//             for (const item of outputs) {
//               const functionCall = this.toFunctionCallPayload(item);
//               if (functionCall) {
//                 await this.handleFunctionCall(sessionId, functionCall);
//               }
//             }
//           }
//         }
//         break;

//       case 'response.text.delta':
//         if (session.elevenLabsReady) {
//           this.sendTextToElevenLabs(sessionId, event.delta);
//         } else {
//           session.textBuffer.push(event.delta);
//         }
//         session.onEvent({ type: 'transcript-delta', delta: event.delta });
//         break;

//       case 'response.text.done':
//         // ── Track last question for silence re-prompt ──────────────────────────
//         // Store the full text Jack just said. The silence handler will repeat
//         // the final sentence/question if the user goes quiet.
//         if (typeof event.text === 'string' && event.text.trim()) {
//           session.lastQuestionAsked = event.text.trim();
//         }
//         this.flushElevenLabsStream(sessionId);
//         session.onEvent({ type: 'transcript-done', transcript: event.text });
//         break;

//       case 'input_audio_buffer.speech_started':
//         this.logger.log(`[${sessionId}] USER INTERRUPTED -> Stopping AI Voice`);

//         // User spoke — reset silence counter.
//         session.silenceRepromptCount = 0;

//         if (session.isResponseActive) {
//           try {
//             session.ws.send(JSON.stringify({ type: 'response.cancel' }));
//           } catch (err) {
//             this.logger.warn(
//               `[${sessionId}] Cancel failed (already finished): ${err.message}`,
//             );
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

//       case 'response.output_item.done':
//         {
//           const typedEvent = event as { item?: unknown };
//           const functionCall = this.toFunctionCallPayload(typedEvent.item);
//           if (functionCall) {
//             await this.handleFunctionCall(sessionId, functionCall);
//           }
//         }
//         break;

//       case 'error':
//         this.logger.error(
//           `[${sessionId}] OpenAI Error: ${JSON.stringify(event.error)}`,
//         );
//         break;
//     }
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // STEP 6: DATA PERSISTENCE
//   // ─────────────────────────────────────────────────────────────────────────────

//   private async handleFunctionCall(
//     sessionId: string,
//     event: any,
//   ): Promise<void> {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     if (event.name === 'save_customer_booking') {
//       const typedEvent = event as { call_id?: unknown };
//       const callId =
//         typeof typedEvent.call_id === 'string' ? typedEvent.call_id : null;

//       if (callId && session.processedFunctionCallIds.has(callId)) {
//         this.logger.debug(
//           `[${sessionId}] Duplicate function call ignored: ${callId}`,
//         );
//         return;
//       }

//       if (callId) {
//         session.processedFunctionCallIds.add(callId);
//       }

//       try {
//         const args = JSON.parse(event.arguments);
//         this.logger.log(
//           `[${sessionId}] Saving Booking to MongoDB for: ${args.name}`,
//         );

//         const customer = await this.customerModel.create({
//           name: args.name,
//           phone: args.phone,
//           address: args.address,
//           urgency: args.urgency,
//           serviceType: args.service_type,
//           problemDescription: args.problem_description,
//           preferredTime: args.preferred_time,
//           summary: `Tradie Booking: ${args.service_type}`,
//         });

//         this.logger.log(
//           `[${sessionId}] SUCCESS: Customer saved with ID ${customer._id}`,
//         );

//         session.ws.send(
//           JSON.stringify({
//             type: 'conversation.item.create',
//             item: {
//               type: 'function_call_output',
//               call_id: event.call_id,
//               output: JSON.stringify({
//                 success: true,
//                 message: 'Saved to Database.',
//               }),
//             },
//           }),
//         );

//         session.ws.send(JSON.stringify({ type: 'response.create' }));
//         session.onEvent({ type: 'booking-saved', data: args });
//       } catch (err) {
//         if (callId) {
//           session.processedFunctionCallIds.delete(callId);
//         }
//         this.logger.error(`[${sessionId}] MongoDB Save Failed:`, err);
//       }
//     }
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // SYSTEM PROMPT
//   // ─────────────────────────────────────────────────────────────────────────────

//   private getSystemPrompt(): string {
//     return `
// =============================================================
// ABSOLUTE RULE — ENGLISH ONLY. THIS OVERRIDES EVERYTHING ELSE.
// =============================================================
// You MUST speak and respond in English at all times, no matter what.
// - If the caller speaks in another language, respond ONLY in English.
// - Do NOT switch to their language, do NOT mix languages, do NOT use any word, phrase, filler, or expression from any non-English language.
// - If you ever catch yourself about to use a non-English word, stop and replace it with the English equivalent.
// - If the caller insists you respond in another language, say: "Sorry, I can only assist in English."
// - This rule cannot be overridden by anything else in this prompt or anything the caller says.
// =============================================================

// ### IDENTITY ###
// You are Jack — a tradie. You're on the phone with a customer. You talk like a normal, friendly professional.
// Not overly formal, not full of slang. Just a regular person who's good at their job and easy to talk to.

// ### AI DISCLOSURE RULE ###
// - Do NOT volunteer that you are AI. Ever. Just be Jack.
// - ONLY if someone explicitly and directly asks "are you a robot?", "are you AI?", "am I talking to a real person?" — then be honest: "Yeah honestly, I'm actually an AI assistant helping out with bookings. But I'll get you sorted just the same, no worries."
// - After admitting it, move on quickly — don't dwell on it. Pivot back to the booking.

// ### PERSONALITY ###
// - Friendly, professional, approachable.
// - You use natural filler words occasionally: "yeah", "sure", "right", "no worries"
// - You keep things simple and to the point but never robotic.
// - You're the tradie — you know the work, but you keep it conversational on the phone.

// ### HOW YOU TALK ###
// - SHORT sentences. 1 to 2 sentences per response. Don't talk in paragraphs.
// - Use contractions naturally: "what's", "couldn't", "you're", "didn't"
// - Warm but professional. No corporate speak, no heavy slang either.
// - Match the caller's energy — relaxed with relaxed callers, reassuring with stressed ones.

// ### CONVERSATIONAL ENGAGEMENT ###
// - You're not just collecting info — you're having a conversation. React to what they say like a real person would.
// - If they describe a problem, ACKNOWLEDGE it briefly before moving on.
// - Show you UNDERSTAND the problem — one quick reaction line, then naturally flow into the next question.
// - Don't just say "got it" and move on. Actually acknowledge what they're dealing with.
// - Keep it brief though — one reaction, then the next question. Don't ramble.

// ### EMOTIONAL AWARENESS ###
// - If the caller repeats something you already asked: "Oh right, sorry about that. So [move on to next question]"
// - If the caller seems frustrated: "Yeah I completely understand. Let me just grab a couple more details and I'll get this sorted for you."
// - If the caller is chatty and going off-topic: "Ha yeah absolutely. Anyway, let me just grab your [next detail] so I can get things moving."
// - If the caller is in a rush: "No worries, I'll keep it quick. Just need a few things."
// - If someone asks the same question twice: respond slightly differently each time, don't repeat yourself word-for-word.

// ### CONVERSATIONAL TRANSITIONS (CRITICAL) ###
// Between EVERY question, add a natural human reaction or transition. NEVER go question-to-question like a checklist.
// These transitions should feel like something a real person would say. Vary them every time — NEVER repeat the same transition twice in one call.

// AFTER GETTING NAME → Warm greeting, then ask what's going on. Let THEM tell you why they're calling. Pick up whatever details they mention naturally. Only ask for details they DIDN'T already mention.

// AFTER THEY DESCRIBE THE PROBLEM → React naturally to what they said. Show you understand. Then lead into collecting remaining details.

// AFTER GETTING PHONE NUMBER → Brief acknowledgment, then ask for address naturally.

// AFTER GETTING ADDRESS → Brief acknowledgment, then ask about urgency.

// AFTER GETTING URGENCY (low/medium severity only) → Respond based on what they said — acknowledge if it's pressing, stay relaxed if they're relaxed. HIGH SEVERITY: this step does not happen — urgency is already known.

// BEFORE ASKING PREFERRED TIME → Signal that you're wrapping up. For HIGH severity, frame it with urgency: "Just one last thing — when do you need someone?" For LOW/MEDIUM, stay relaxed: "Nearly done — when works best for you?"

// IMPORTANT: Generate natural, varied transition lines every time. Never repeat the same one in a single call.

// ### HANDLING INTERRUPTIONS (FALSE BARGE-IN RECOVERY) ###
// - Sometimes background noise may trigger an interruption even though the caller didn't actually say anything.
// - If you get interrupted but the caller doesn't say anything meaningful, re-engage naturally.
// - NEVER go silent. If there's an awkward pause, YOU pick the conversation back up.
// - Vary your recovery lines — don't say the exact same thing every time.

// ### SERVICE TYPES — OPEN-ENDED (CRITICAL) ###
// You handle ALL types of trade work. There is NO fixed list. Accept ANY valid trade or home service the caller mentions. Do NOT limit or suggest only specific trade types. Let the caller tell you what they need. If it involves hands-on work at a home or property, it counts.

// ### PROBLEM CLARITY & SEVERITY SCORING (CRITICAL — DO THIS BEFORE ANY FOLLOW-UP) ###

// Every time a caller describes their situation, silently assess it on two axes before deciding how to respond. This is not a checklist — it is a judgement call you make the same way a real experienced person would.

// AXIS 1 — SEVERITY: How distressing or urgent does this sound for the caller right now?
// - LOW: routine, non-urgent, planning ahead (painting a room, building a deck, replacing a tap)
// - MEDIUM: inconvenient, needs attention soon but not an emergency (leak that isn't flooding, appliance not working, door that sticks)
// - HIGH: distressing, urgent, already causing damage, potentially dangerous, or genuinely scary for the caller (structural damage, major flooding, total power loss, roof coming in, gas smell, wall collapsing, anything they describe with panic or urgency in their voice)

// AXIS 2 — PROBLEM CLARITY: How well do you understand what happened based on what they said?
// - CLEAR: you know what the problem is even if you don't have every detail — a real tradie calling back would have enough to start the conversation
// - UNCLEAR: genuinely vague — you don't have enough to describe the job to anyone

// ─────────────────────────────────────────────
// HOW TO RESPOND BASED ON YOUR ASSESSMENT:
// ─────────────────────────────────────────────

// IF SEVERITY IS HIGH (regardless of clarity):
// → Do NOT ask "what type of work do you think you need?" — ever. They are stressed and that question makes them feel like they called the wrong number.
// → Do NOT interrogate. Do NOT ask any follow-up question about the problem.
// → React with genuine human empathy that matches the weight of what they described. Show you heard them.
// → Immediately reassure them that someone will call back as soon as possible to work out what needs to happen.
// → Shift your energy — faster, warmer, more focused. Get their details and get off the phone efficiently.
// → For service_type in the booking: infer it yourself from context. Use descriptive shorthand like "structural emergency", "plumbing emergency", "electrical emergency". The tradie will assess when they call.
// → For problem_description: capture everything they said in as much detail as possible. This is what the tradie reads before calling back.
// → Example energy: "Okay wow, that sounds serious. Let me grab your details now and we'll get someone to call you back as soon as possible to work out what needs to happen."

// IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS CLEAR:
// → React naturally and acknowledge what they said before moving on.
// → Ask ONE context-driven follow-up question ONLY if it would genuinely help the tradie who calls back. Base it entirely on the caller's exact words — never on a template.
// → The question must be impossible to ask without having heard exactly what this person said. If it could go to any caller with the same trade type, it is too generic.
// → If they already gave enough detail, skip the follow-up entirely.

// IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS UNCLEAR:
// → Ask ONE short clarifying question — but make it specific to what they said.
// → NEVER ask "what type of work do you think you need?" — they called because they don't know. Ask about their specific situation instead.
// → Example: not "what trade do you need?" but "is it something that's been getting worse, or did it just happen?"

// ─────────────────────────────────────────────
// WHEN A FOLLOW-UP IS APPROPRIATE — THE RULE:
// ─────────────────────────────────────────────
// 1. Listen to their exact words.
// 2. Think: what would a real tradie genuinely need to know to prepare for this specific job?
// 3. Ask ONE question that could only be asked after hearing exactly what this person said.

// NEVER ask:
// - "What type of work do you think you need?" — they don't know, that's why they called
// - "Can you tell me more?" — too vague, too robotic
// - "What exactly is the issue?" — too broad, adds nothing

// ALWAYS make it specific to what they said. Reference their actual words.

// Example thinking — understand the logic, never copy the words:
// - "My hot water system is making a weird banging noise" → When does it happen? "Is it doing it when you first turn the tap on, or is it more constant?"
// - "I need a deck built out the back" → What's the scope? "Have you got a rough idea of the size, or do you want someone to come out and measure up?"
// - "There's mould coming through the bathroom ceiling" → What's above it? "Is there a bathroom directly above it, or is it more likely from the roof?"
// - "The garage door won't open anymore" → Was it sudden? "Did it just stop one day, or has it been getting harder to open for a while?"
// - "We need the whole house repainted before we sell" → What's the timeline? "When are you looking to have it done — do you have a settlement date you're working toward?"

// Every caller gets a response shaped entirely by what they specifically said.

// ### OFF-TOPIC HANDLING (STRICT) ###
// You are ONLY here to help with tradie bookings and trade-related work. You have NO information on anything outside of this scope.

// - If someone asks about ANYTHING not related to trade services, home repairs, maintenance, or bookings:
//   "Ah sorry mate, I don't really have info on that. I only handle tradie bookings — anything around the house that needs fixing or building, I'm your guy. Got anything like that you need sorted?"

// - This includes but is not limited to: weather, news, sports, politics, general knowledge, medical advice, legal advice, financial advice, restaurant recommendations, travel, entertainment, tech support, software, shopping, or any other non-trade topic.

// - If they keep pushing off-topic: "Yeah look, I appreciate the chat, but that's really not my area. If you've got any work that needs doing around the place though, I can definitely help with that."

// - Always pivot back: After declining, gently check if they actually need trade work done.

// - Be firm but friendly. Don't engage with off-topic content at all — don't speculate, don't guess, don't try to be helpful on topics outside your scope. Just redirect.

// ### THE BOOKING FLOW ###

// You must populate these 7 booking fields before save_customer_booking: name, phone, address, urgency, service type, problem description, preferred time.
// Do it conversationally — not like a form. And critically: the PROBLEM CLARITY & SEVERITY SCORING rules above govern what you skip and how you behave at every step.

// For HIGH SEVERITY calls, fields can be populated by inference instead of direct questions:
// - urgency = "urgent"
// - preferred_time = "ASAP"
// - service_type inferred from context if caller did not state it

// ─────────────────────────────────────────────
// STEP 1 — NAME
// ─────────────────────────────────────────────
// Always start here: "Hey! Jack here. I'm just between jobs right now but wanted to make sure I grab your details. Who am I speaking with?"

// ─────────────────────────────────────────────
// STEP 2 — WHAT'S GOING ON (problem + severity assessment)
// ─────────────────────────────────────────────
// Greet them by name and ask what's going on. Let them tell you. This is where you make your severity assessment.
// Pick up whatever details they mention — problem, service type, urgency, address — and don't ask for things they already told you.

// ─────────────────────────────────────────────
// STEP 3 — PHONE
// ─────────────────────────────────────────────
// Always collect. Ask for their best contact number.
// Once they give it, read it back digit by digit — e.g. "So that's 0-4-1-2-3-4-5-6-7-8 — that right?"
// Wait for explicit confirmation. If they correct a digit, read the full number back again and wait again.
// Do NOT move on until confirmed.

// CRITICAL — HOW TO READ PHONE NUMBERS BACK:
// - ALWAYS say each digit as a separate spoken word in English. No exceptions.
// - Say: "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"
// - NEVER group digits into pairs or larger numbers. Never say "forty-one" or "twelve" — say "four one" and "one two".
// - NEVER use any non-English word, sound, or number system when reading digits. English digit words only.
// - Format: read every single digit individually with a natural short pause between each one.
// - Example: 0412345678 → "zero, four, one, two, three, four, five, six, seven, eight — that right?"
// - If you catch yourself about to say a number in any other language, STOP and say the English word instead.

// ─────────────────────────────────────────────
// STEP 4 — ADDRESS
// ─────────────────────────────────────────────
// ALWAYS collect — including HIGH severity calls. The tradie needs to know where to go.
// Ask: "And where's the job located?" (skip only if they already gave the address earlier in the call).
// For HIGH severity, keep it fast and to the point — no extra chat, just get the address and move on.

// ─────────────────────────────────────────────
// STEP 5 — URGENCY
// ─────────────────────────────────────────────
// IF SEVERITY IS HIGH: SKIP THIS QUESTION ENTIRELY.
// You already know it's urgent from what they described. Asking "how urgent is it?" to someone whose wall is falling down is tone-deaf. Set urgency = "urgent" in the booking and move on.

// IF SEVERITY IS LOW OR MEDIUM: Ask how urgent it is for them. Take their answer and use it.

// ─────────────────────────────────────────────
// STEP 6 — SERVICE TYPE
// ─────────────────────────────────────────────
// IF SEVERITY IS HIGH: SKIP THIS QUESTION ENTIRELY.
// Infer the service type from what they described and fill it in yourself. Do not ask the caller to diagnose their own emergency.
// Examples of how to infer: wall collapsing → "structural emergency", flooding → "plumbing emergency", no power → "electrical emergency", roof coming in → "roofing emergency". Use your judgement — be descriptive.

// IF SERVICE TYPE WAS ALREADY MENTIONED BY THE CALLER: SKIP. Use what they said.

// IF SEVERITY IS LOW OR MEDIUM AND IT'S GENUINELY UNCLEAR: Ask what kind of work they need. Keep it open-ended. Never suggest specific trades.

// ─────────────────────────────────────────────
// STEP 7 — PROBLEM FOLLOW-UP
// ─────────────────────────────────────────────
// IF SEVERITY IS HIGH: SKIP THIS ENTIRELY. You have enough. Don't make them explain more than they already have.

// IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS CLEAR: Skip unless one specific question would genuinely help the tradie.

// IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS UNCLEAR: Ask ONE question rooted in their exact words. See PROBLEM CLARITY & SEVERITY SCORING for the full rules.

// ─────────────────────────────────────────────
// STEP 8 — PREFERRED TIME
// ─────────────────────────────────────────────
// ALWAYS ask — including HIGH severity calls. You must collect this field every time.

// IF SEVERITY IS HIGH: Ask it quickly and with urgency framing. Example: "And when do you need someone out — is right now the soonest, or is there a window that works?" Keep it short. Take whatever they say and use it. Do NOT skip this step.

// IF SEVERITY IS LOW OR MEDIUM: Ask when works best for them. Signal you're wrapping up before asking.

// ─────────────────────────────────────────────
// GENERAL RULE FOR ALL STEPS
// ─────────────────────────────────────────────
// If the caller volunteers information at any point, take it and skip the corresponding question. Don't re-ask things you already know.
// The conversation should breathe. Never rapid-fire questions back to back.

// ### FINAL ACTION — READ THIS CAREFULLY (CRITICAL) ###

// This section governs exactly what happens once you have all 7 pieces of information.
// Follow these steps IN ORDER. Do not skip any step.

// ─────────────────────────────────────────────
// STEP A — ASK THE "ANYTHING TO ADD?" QUESTION
// ─────────────────────────────────────────────
// Once you have all 7 details, you MUST ask this question FIRST — before doing anything else:

//   "Perfect, I've got all the details. Is there anything else you'd like to add before I send this through?"

// Do NOT call the save function yet. Wait for the caller's response.

// If the caller is silent or unclear after this question, re-engage quickly (no long pause) with one short prompt like:
// "No rush — should I send this through now, or did you want to add anything else?"

// ─────────────────────────────────────────────
// STEP B — HANDLE THEIR RESPONSE
// ─────────────────────────────────────────────
// TWO possible outcomes:

// OUTCOME 1 — They want to add more:
// - Ask for the extra detail naturally.
// - Listen to what they say and incorporate it into problem_description.
// - After collecting the extra detail, acknowledge it briefly, then ask once more:
//   "Got it, anything else or shall I send this through now?"
// - Repeat OUTCOME 1 as many times as needed until they are done.

// OUTCOME 2 — They are ready to proceed:
// - Treat ANY of the following as "proceed": "no", "nope", "that's it", "all good", "go ahead", "yep send it", "sounds good", "nothing else", "you go ahead", "that's everything", "all done", "no more from me", or any natural approval meaning "proceed".
// - If genuinely ambiguous, ask ONE short clarifier: "No stress — ready to send this through, or did you want to add something first?"
// - The moment intent is clearly "proceed", go immediately to STEP C.

// ─────────────────────────────────────────────
// STEP C — CALL THE DATABASE FUNCTION
// ─────────────────────────────────────────────
// - Your very next action MUST be a function call to save_customer_booking.
// - Do NOT send any text or speech before the function call executes.
// - Include ALL details gathered throughout the entire conversation in the fields, especially problem_description — make it as rich and detailed as possible based on everything the caller said.
// - This function call is NON-NEGOTIABLE. The booking cannot end without it.

// ─────────────────────────────────────────────
// STEP D — AFTER SUCCESSFUL SAVE
// ─────────────────────────────────────────────
// Once the tool returns success, your closing line depends on the severity you assessed earlier in the call.

// IF SEVERITY WAS HIGH (urgent situation, emergency, serious damage):
//   Say something like this — vary it naturally each time, don't say it word for word:
//   "Okay [name], that's all through. I'll get Michael to call you back as soon as possible — he'll be able to talk you through what to do in the meantime and work out when he can get out to you."

//   The key elements to always include:
//   - Use their name
//   - Say Michael will call them back (not "a tradie", not "someone" — Michael)
//   - Make it feel urgent and personal, not like a ticket number
//   - Mention he'll help them with what to do in the meantime — this reassures them they won't just be left waiting with a crisis
//   - Do NOT say they are booked in, locked in, or that anyone is on their way

// IF SEVERITY WAS LOW OR MEDIUM (normal booking flow):
//   Say something like this — vary it naturally:
//   "Perfect, thanks [name]. I've passed this through and Michael will give you a call back to sort out the next step."

//   Keep it warm and simple. No over-promising.

// RULES FOR BOTH:
// - Do NOT say a visit is booked or confirmed.
// - Do NOT promise a specific time or date.
// - Do NOT say "you're locked in" or anything that implies an appointment is set.
// - The call is now complete.

// ─────────────────────────────────────────────
// FAILURE SAFEGUARD
// ─────────────────────────────────────────────
// If save_customer_booking has NOT been called before any attempt to close or end the conversation, you MUST go back and complete STEP C before allowing the call to end. The booking CANNOT be closed without a successful database save.

// ### HARD RULES ###
// - Language: ENGLISH ONLY — see the absolute rule at the very top of this prompt.
// - ONE question at a time — never stack questions.
// - Keep responses SHORT — 1 to 2 sentences max.
// - SILENCE HANDLING: If you receive a [SYSTEM: The user has been silent...] instruction, speak exactly what it says, naturally and conversationally. The instruction will always start with "I guess you didn't hear that, let me repeat my question." followed by the last question. Say it exactly as written. Do NOT add extra content, explanations, or new questions. Do NOT rephrase. Repeat only.
// - If there's silence, re-engage naturally: "Still there?" or "Sorry, didn't catch that."
// - Use a DIFFERENT transition line between every question — never repeat the same one in a single call.
// - Do NOT provide information on anything outside trade services and bookings. You simply don't have that info.
// - Accept ALL valid trade types — never limit to specific ones.
// - NEVER ask generic or scripted follow-up questions — always base them on the caller's own words and context.
// - ALWAYS call save_customer_booking before ending the call. This rule overrides everything else.`;
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // TOOL DEFINITION
//   // ─────────────────────────────────────────────────────────────────────────────

//   private getSaveBookingTool() {
//     return {
//       type: 'function',
//       name: 'save_customer_booking',
//       description: 'Saves customer booking details to MongoDB.',
//       parameters: {
//         type: 'object',
//         properties: {
//           name: { type: 'string' },
//           phone: { type: 'string' },
//           address: { type: 'string' },
//           urgency: { type: 'string' },
//           service_type: { type: 'string' },
//           problem_description: { type: 'string' },
//           preferred_time: { type: 'string' },
//         },
//         required: [
//           'name',
//           'phone',
//           'address',
//           'urgency',
//           'service_type',
//           'problem_description',
//           'preferred_time',
//         ],
//       },
//     };
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // CLEANUP
//   // ─────────────────────────────────────────────────────────────────────────────

//   closeSession(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (session) {
//       this.closeElevenLabsWs(sessionId);
//       session.ws.close();
//       this.sessions.delete(sessionId);
//       this.logger.log(`[${sessionId}] Active Call Disconnected`);
//     }
//   }
// }
// ///////////////////////////////jabbbba 
// import { Injectable, Logger } from '@nestjs/common';
// import { ConfigService } from '@nestjs/config';
// import { InjectModel } from '@nestjs/mongoose';
// import { ClientRequest } from 'http';
// import { Model } from 'mongoose';
// import { Socket } from 'net';
// import { TLSSocket } from 'tls';
// import WebSocket from 'ws';
// import { Customer, CustomerDocument } from './Schema/customer.schema';

// /**
//  * RealtimeSession interface tracks the state of a single voice call.
//  * This includes the connection to OpenAI (Brain) and ElevenLabs (Voice).
//  */
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

//   // ── Silence re-prompt tracking ──────────────────────────────────────────────
//   // Stores the last question/statement Jack said so we can repeat it on silence.
//   lastQuestionAsked: string;
//   // How many consecutive silence re-prompts have fired without a user response.
//   silenceRepromptCount: number;
// }

// interface FunctionCallPayload {
//   name: string;
//   arguments: string;
//   call_id: string;
// }

// @Injectable()
// export class VoiceService {
//   private readonly logger = new Logger(VoiceService.name);

//   private sessions = new Map<string, RealtimeSession>();

//   private toFunctionCallPayload(value: unknown): FunctionCallPayload | null {
//     if (!value || typeof value !== 'object') return null;

//     const record = value as Record<string, unknown>;
//     const type = record.type;
//     const name = record.name;
//     const args = record.arguments;
//     const callId = record.call_id;

//     if (type !== 'function_call') return null;
//     if (
//       typeof name !== 'string' ||
//       typeof args !== 'string' ||
//       typeof callId !== 'string'
//     ) {
//       return null;
//     }

//     return { name, arguments: args, call_id: callId };
//   }

//   constructor(
//     private readonly config: ConfigService,
//     @InjectModel(Customer.name)
//     private readonly customerModel: Model<CustomerDocument>,
//   ) {}

//   // ─────────────────────────────────────────────────────────────────────────────
//   // SILENCE HANDLING
//   // Called by the client (via gateway) after ElevenLabs audio finishes and
//   // a configurable silence window (default 5 s) passes with no user speech.
//   // ─────────────────────────────────────────────────────────────────────────────

//   /**
//    * MAX_SILENCE_REPROMPTS — after this many consecutive silent timeouts we
//    * politely close the call rather than looping forever.
//    */
//   private readonly MAX_SILENCE_REPROMPTS = 2;

//   /**
//    * handleSilenceTimeout
//    *
//    * Triggered externally (e.g. from your WebSocket gateway) when the client
//    * detects the user has been silent for too long after Jack finished speaking.
//    *
//    * Behaviour:
//    *  - If Jack is still generating a response, ignore (audio not done yet).
//    *  - If we've already re-prompted MAX_SILENCE_REPROMPTS times, inject a
//    *    polite closing message and end the session.
//    *  - Otherwise inject the last question back into the conversation via
//    *    conversation.item.create so OpenAI re-speaks it naturally, then
//    *    trigger a new response.create.
//    */
//   handleSilenceTimeout(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     // Don't fire while OpenAI is mid-response — audio isn't done yet.
//     if (session.isResponseActive) {
//       this.logger.debug(
//         `[${sessionId}] Silence timeout ignored — response still active`,
//       );
//       return;
//     }

//     session.silenceRepromptCount += 1;

//     if (session.silenceRepromptCount > this.MAX_SILENCE_REPROMPTS) {
//       this.logger.log(
//         `[${sessionId}] Max silence re-prompts reached — closing call politely`,
//       );
//       this._injectAndRespond(
//         sessionId,
//         "It seems like you might have stepped away. No worries — feel free to call back whenever you're ready. Take care!",
//       );
//       // Give the closing message a moment to play before tearing down.
//       setTimeout(() => this.closeSession(sessionId), 8000);
//       return;
//     }

//     const reprompt = this._buildSilenceReprompt(session);
//     this.logger.log(
//       `[${sessionId}] Silence timeout #${session.silenceRepromptCount} — re-prompting: "${reprompt}"`,
//     );
//     this._injectAndRespond(sessionId, reprompt);
//   }

//   /**
//    * _buildSilenceReprompt
//    *
//    * Constructs the silence re-prompt.
//    *
//    * Spec requirement: always say "I guess you didn't hear that, let me repeat
//    * my question." then repeat the last question verbatim.
//    * If no last question is stored, fall back to a generic check-in.
//    */
//   private _buildSilenceReprompt(session: RealtimeSession): string {
//     const last = session.lastQuestionAsked?.trim();

//     if (!last) {
//       // No stored question yet (e.g. silence before Jack has said anything).
//       return "I guess you didn't hear that — are you still there?";
//     }

//     // Both attempt 1 and attempt 2 use the same required phrase then repeat
//     // the last question exactly. The spec says "only repeat last question" with
//     // no new content, so we keep this consistent across attempts.
//     return `I guess you didn't hear that, let me repeat my question. ${last}`;
//   }

//   /**
//    * _injectAndRespond
//    *
//    * Injects a plain text instruction into the OpenAI conversation as a
//    * system/user turn, then triggers response.create so OpenAI speaks it
//    * via the normal text → ElevenLabs pipeline.
//    */
//   private _injectAndRespond(sessionId: string, text: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session || session.ws.readyState !== WebSocket.OPEN) return;

//     // Inject the re-prompt text as a user-visible assistant instruction.
//     session.ws.send(
//       JSON.stringify({
//         type: 'conversation.item.create',
//         item: {
//           type: 'message',
//           role: 'user',
//           content: [
//             {
//               type: 'input_text',
//               // Tell the model what to say — it will paraphrase naturally.
//               text: `[SYSTEM: The user has been silent. Re-engage by saying exactly this, naturally: "${text}"]`,
//             },
//           ],
//         },
//       }),
//     );

//     session.ws.send(JSON.stringify({ type: 'response.create' }));
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // INCOMING CALL HANDLER
//   // ─────────────────────────────────────────────────────────────────────────────

//   async handleIncomingCall(callData: {
//     call_id: string;
//     caller_number: string;
//     called_number: string;
//   }) {
//     this.logger.log(`Voice Service handling call: ${callData.call_id}`);

//     try {
//       await this.createRealtimeSession(callData.call_id, (event) => {
//         this.logger.log(`[${callData.call_id}] Voice event: ${event.type}`);

//         if (event.type === 'audio-delta') {
//           this.sendAudioToAri(callData.call_id, event.delta);
//         }
//       });

//       this.triggerGreeting(callData.call_id);

//       return {
//         success: true,
//         message: 'Voice session created successfully',
//         call_id: callData.call_id,
//       };
//     } catch (error) {
//       this.logger.error(`Error in Voice call handling: ${error.message}`);
//       return { success: false, error: error.message };
//     }
//   }

//   private sendAudioToAri(callId: string, audioDelta: string) {
//     this.logger.log(
//       `[${callId}] Sending audio to ARI: ${audioDelta.length} chars`,
//     );
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // STEP 1: Create OpenAI Realtime session
//   // ─────────────────────────────────────────────────────────────────────────────

//   async createRealtimeSession(
//     sessionId: string,
//     onEvent: (event: any) => void,
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
//       this.instrumentClientWebSocketHandshake(
//         sessionId,
//         'OpenAI',
//         ws,
//         sessionStartedAtMs,
//       );

//       ws.on('open', () => {
//         const openAiConnectedAtMs = Date.now();
//         this.logger.log(`[${sessionId}] OpenAI Realtime WebSocket connected`);
//         this.logger.log(
//           `[${sessionId}] Timing: OpenAI WS connected in ${openAiConnectedAtMs - sessionStartedAtMs}ms`,
//         );

//         const sessionUpdate = {
//           type: 'session.update',
//           session: {
//             modalities: ['text'],
//             instructions: this.getSystemPrompt(),
//             input_audio_format: 'pcm16',
//             turn_detection: {
//               type: 'server_vad',
//               threshold: 0.8,
//               prefix_padding_ms: 300,
//               silence_duration_ms: 2000,
//             },
//             tools: [this.getSaveBookingTool()],
//             tool_choice: 'auto',
//           },
//         };

//         ws.send(JSON.stringify(sessionUpdate));

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
//           processedFunctionCallIds: new Set<string>(),
//           // Silence tracking initialised empty
//           lastQuestionAsked: '',
//           silenceRepromptCount: 0,
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
//         this.logger.error(`[${sessionId}] OpenAI WebSocket error:`, err);
//         onEvent({ type: 'error', error: { message: err.message } });
//         reject(err);
//       });

//       ws.on('close', (code, reason) => {
//         this.logger.log(
//           `[${sessionId}] OpenAI WebSocket closed: ${code} - ${reason}`,
//         );
//         this.closeElevenLabsWs(sessionId);
//         this.sessions.delete(sessionId);
//         onEvent({ type: 'session-closed' });
//       });
//     });
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // STEP 2: Relay user audio to OpenAI
//   // ─────────────────────────────────────────────────────────────────────────────

//   sendAudio(sessionId: string, base64Audio: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     session.ws.send(
//       JSON.stringify({
//         type: 'input_audio_buffer.append',
//         audio: base64Audio,
//       }),
//     );
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // STEP 3: Greeting
//   // ─────────────────────────────────────────────────────────────────────────────

//   triggerGreeting(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     session.greetingTriggeredAtMs = Date.now();
//     this.logger.log(
//       `[${sessionId}] Timing: greeting trigger fired at ${session.greetingTriggeredAtMs - session.sessionStartedAtMs}ms from session start`,
//     );
//     session.ws.send(JSON.stringify({ type: 'response.create' }));
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // STEP 4: ElevenLabs integration
//   // ─────────────────────────────────────────────────────────────────────────────

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
//     this.instrumentClientWebSocketHandshake(
//       sessionId,
//       'ElevenLabs',
//       elWs,
//       session.sessionStartedAtMs,
//     );

//     elWs.on('open', () => {
//       this.logger.log(`[${sessionId}] ElevenLabs WebSocket connected`);
//       session.elevenLabsConnectedAtMs = Date.now();
//       this.logger.log(
//         `[${sessionId}] Timing: ElevenLabs WS connected in ${session.elevenLabsConnectedAtMs - session.sessionStartedAtMs}ms`,
//       );

//       elWs.send(
//         JSON.stringify({
//           text: ' ',
//           voice_settings: {
//             stability: 0.4,
//             similarity_boost: 0.75,
//             speed: 1.15,
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
//             const firstAudioAtMs = Date.now();
//             session.firstAudioDeltaLogged = true;
//             const openAiMs = session.openAiConnectedAtMs
//               ? session.openAiConnectedAtMs - session.sessionStartedAtMs
//               : -1;
//             const elevenLabsMs = session.elevenLabsConnectedAtMs
//               ? session.elevenLabsConnectedAtMs - session.sessionStartedAtMs
//               : -1;
//             const greetingMs = session.greetingTriggeredAtMs
//               ? session.greetingTriggeredAtMs - session.sessionStartedAtMs
//               : -1;
//             const responseCreatedAfterGreetingMs =
//               session.firstResponseCreatedAtMs && session.greetingTriggeredAtMs
//                 ? session.firstResponseCreatedAtMs -
//                   session.greetingTriggeredAtMs
//                 : -1;
//             const firstAudioAfterResponseCreatedMs =
//               session.firstResponseCreatedAtMs
//                 ? firstAudioAtMs - session.firstResponseCreatedAtMs
//                 : -1;

//             this.logger.log(
//               `[${sessionId}] Timing: first audio delta at ${firstAudioAtMs - session.sessionStartedAtMs}ms (openai=${openAiMs}ms, elevenlabs=${elevenLabsMs}ms, greeting=${greetingMs}ms, response_created_after_greeting=${responseCreatedAfterGreetingMs}ms, audio_after_response_created=${firstAudioAfterResponseCreatedMs}ms)`,
//             );
//           }
//           session.onEvent({ type: 'audio-delta', delta: msg.audio });
//         }

//         // ── Signal audio-done so the client can start its silence timer ────────
//         // ElevenLabs sends isFinal=true on the last audio chunk of a turn.
//         if (msg.isFinal === true) {
//           session.onEvent({ type: 'audio-done' });
//         }
//       } catch (err) {
//         // Intentionally silent — non-JSON frames (binary audio) ignored
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

//   private instrumentClientWebSocketHandshake(
//     sessionId: string,
//     provider: 'OpenAI' | 'ElevenLabs',
//     ws: WebSocket,
//     startedAtMs: number,
//   ): void {
//     const wsWithReq = ws as WebSocket & { _req?: ClientRequest };
//     const req = wsWithReq._req;
//     if (!req) {
//       this.logger.warn(
//         `[${sessionId}] Timing: ${provider} request object not available for low-level socket timings`,
//       );
//       return;
//     }

//     let socketHooksAttached = false;
//     const attachSocketHooks = (socket: Socket): void => {
//       if (socketHooksAttached) return;
//       socketHooksAttached = true;

//       socket.once('lookup', () => {
//         this.logger.log(
//           `[${sessionId}] Timing: ${provider} DNS lookup completed in ${Date.now() - startedAtMs}ms`,
//         );
//       });

//       socket.once('connect', () => {
//         this.logger.log(
//           `[${sessionId}] Timing: ${provider} TCP connect completed in ${Date.now() - startedAtMs}ms`,
//         );
//       });

//       (socket as TLSSocket).once('secureConnect', () => {
//         this.logger.log(
//           `[${sessionId}] Timing: ${provider} TLS handshake completed in ${Date.now() - startedAtMs}ms`,
//         );
//       });
//     };

//     if (req.socket) {
//       attachSocketHooks(req.socket);
//     }
//     req.once('socket', (socket: Socket) => {
//       attachSocketHooks(socket);
//     });

//     ws.on('upgrade', () => {
//       this.logger.log(
//         `[${sessionId}] Timing: ${provider} WS upgrade completed in ${Date.now() - startedAtMs}ms`,
//       );
//     });

//     ws.on('open', () => {
//       this.logger.log(
//         `[${sessionId}] Timing: ${provider} WS open event at ${Date.now() - startedAtMs}ms`,
//       );
//     });
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
//     if (session?.elevenLabsWs) {
//       try {
//         if (session.elevenLabsWs.readyState === WebSocket.CONNECTING) {
//           session.elevenLabsWs.terminate();
//         } else if (session.elevenLabsWs.readyState === WebSocket.OPEN) {
//           session.elevenLabsWs.close();
//         }
//       } catch (err) {
//         this.logger.warn(
//           `[${sessionId}] Error closing ElevenLabs WS: ${err.message}`,
//         );
//       }
//       session.elevenLabsWs = null;
//       session.elevenLabsReady = false;
//       session.textBuffer = [];
//     }
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // STEP 5: THE EVENT HUB
//   // ─────────────────────────────────────────────────────────────────────────────

//   private async handleRealtimeEvent(
//     sessionId: string,
//     event: any,
//   ): Promise<void> {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     this.logger.debug(`[${sessionId}] OpenAI Debug Event: ${event.type}`);

//     switch (event.type) {
//       case 'response.created':
//         session.isResponseActive = true;
//         // Reset silence counter — user said something, Jack is responding.
//         session.silenceRepromptCount = 0;

//         if (!session.firstResponseCreatedAtMs) {
//           session.firstResponseCreatedAtMs = Date.now();
//           const fromSessionStart =
//             session.firstResponseCreatedAtMs - session.sessionStartedAtMs;
//           const fromGreeting = session.greetingTriggeredAtMs
//             ? session.firstResponseCreatedAtMs - session.greetingTriggeredAtMs
//             : -1;
//           this.logger.log(
//             `[${sessionId}] Timing: first response.created at ${fromSessionStart}ms (after greeting=${fromGreeting}ms)`,
//           );
//         }
//         this.openElevenLabsStream(sessionId);
//         break;

//       case 'response.done':
//         session.isResponseActive = false;
//         {
//           const typedEvent = event as { response?: { output?: unknown } };
//           const outputs = typedEvent.response?.output;
//           if (Array.isArray(outputs)) {
//             for (const item of outputs) {
//               const functionCall = this.toFunctionCallPayload(item);
//               if (functionCall) {
//                 await this.handleFunctionCall(sessionId, functionCall);
//               }
//             }
//           }
//         }
//         break;

//       case 'response.text.delta':
//         if (session.elevenLabsReady) {
//           this.sendTextToElevenLabs(sessionId, event.delta);
//         } else {
//           session.textBuffer.push(event.delta);
//         }
//         session.onEvent({ type: 'transcript-delta', delta: event.delta });
//         break;

//       case 'response.text.done':
//         // ── Track last question for silence re-prompt ──────────────────────────
//         // Store the full text Jack just said. The silence handler will repeat
//         // the final sentence/question if the user goes quiet.
//         if (typeof event.text === 'string' && event.text.trim()) {
//           session.lastQuestionAsked = event.text.trim();
//         }
//         this.flushElevenLabsStream(sessionId);
//         session.onEvent({ type: 'transcript-done', transcript: event.text });
//         break;

//       case 'input_audio_buffer.speech_started':
//         this.logger.log(`[${sessionId}] USER INTERRUPTED -> Stopping AI Voice`);

//         // User spoke — reset silence counter.
//         session.silenceRepromptCount = 0;

//         if (session.isResponseActive) {
//           try {
//             session.ws.send(JSON.stringify({ type: 'response.cancel' }));
//           } catch (err) {
//             this.logger.warn(
//               `[${sessionId}] Cancel failed (already finished): ${err.message}`,
//             );
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

//       case 'response.output_item.done':
//         {
//           const typedEvent = event as { item?: unknown };
//           const functionCall = this.toFunctionCallPayload(typedEvent.item);
//           if (functionCall) {
//             await this.handleFunctionCall(sessionId, functionCall);
//           }
//         }
//         break;

//       case 'error':
//         this.logger.error(
//           `[${sessionId}] OpenAI Error: ${JSON.stringify(event.error)}`,
//         );
//         break;
//     }
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // STEP 6: DATA PERSISTENCE
//   // ─────────────────────────────────────────────────────────────────────────────

//   private async handleFunctionCall(
//     sessionId: string,
//     event: any,
//   ): Promise<void> {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     if (event.name === 'save_customer_booking') {
//       const typedEvent = event as { call_id?: unknown };
//       const callId =
//         typeof typedEvent.call_id === 'string' ? typedEvent.call_id : null;

//       if (callId && session.processedFunctionCallIds.has(callId)) {
//         this.logger.debug(
//           `[${sessionId}] Duplicate function call ignored: ${callId}`,
//         );
//         return;
//       }

//       if (callId) {
//         session.processedFunctionCallIds.add(callId);
//       }

//       try {
//         const args = JSON.parse(event.arguments);
//         this.logger.log(
//           `[${sessionId}] Saving Booking to MongoDB for: ${args.name}`,
//         );

//         const customer = await this.customerModel.create({
//           name: args.name,
//           phone: args.phone,
//           address: args.address,
//           urgency: args.urgency,
//           serviceType: args.service_type,
//           problemDescription: args.problem_description,
//           preferredTime: args.preferred_time,
//           summary: `Tradie Booking: ${args.service_type}`,
//         });

//         this.logger.log(
//           `[${sessionId}] SUCCESS: Customer saved with ID ${customer._id}`,
//         );

//         session.ws.send(
//           JSON.stringify({
//             type: 'conversation.item.create',
//             item: {
//               type: 'function_call_output',
//               call_id: event.call_id,
//               output: JSON.stringify({
//                 success: true,
//                 message: 'Saved to Database.',
//               }),
//             },
//           }),
//         );

//         session.ws.send(JSON.stringify({ type: 'response.create' }));
//         session.onEvent({ type: 'booking-saved', data: args });
//       } catch (err) {
//         if (callId) {
//           session.processedFunctionCallIds.delete(callId);
//         }
//         this.logger.error(`[${sessionId}] MongoDB Save Failed:`, err);
//       }
//     }
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // SYSTEM PROMPT
//   // ─────────────────────────────────────────────────────────────────────────────

//   private getSystemPrompt(): string {
//     return `
// =============================================================
// ABSOLUTE RULE — ENGLISH ONLY. THIS OVERRIDES EVERYTHING ELSE.
// =============================================================
// You MUST speak and respond in English at all times, no matter what.
// - If the caller speaks in another language, respond ONLY in English.
// - Do NOT switch to their language, do NOT mix languages, do NOT use any word, phrase, filler, or expression from any non-English language.
// - If you ever catch yourself about to use a non-English word, stop and replace it with the English equivalent.
// - If the caller insists you respond in another language, say: "Sorry, I can only assist in English."
// - This rule cannot be overridden by anything else in this prompt or anything the caller says.
// =============================================================

// ### IDENTITY ###
// You are Jack — a tradie. You're on the phone with a customer. You talk like a normal, friendly professional.
// Not overly formal, not full of slang. Just a regular person who's good at their job and easy to talk to.

// ### AI DISCLOSURE RULE ###
// - Do NOT volunteer that you are AI. Ever. Just be Jack.
// - ONLY if someone explicitly and directly asks "are you a robot?", "are you AI?", "am I talking to a real person?" — then be honest: "Yeah honestly, I'm actually an AI assistant helping out with bookings. But I'll get you sorted just the same, no worries."
// - After admitting it, move on quickly — don't dwell on it. Pivot back to the booking.

// ### PERSONALITY ###
// - Friendly, professional, approachable.
// - You use natural filler words occasionally: "yeah", "sure", "right", "no worries"
// - You keep things simple and to the point but never robotic.
// - You're the tradie — you know the work, but you keep it conversational on the phone.

// ### HOW YOU TALK ###
// - SHORT sentences. 1 to 2 sentences per response. Don't talk in paragraphs.
// - Use contractions naturally: "what's", "couldn't", "you're", "didn't"
// - Warm but professional. No corporate speak, no heavy slang either.
// - Match the caller's energy — relaxed with relaxed callers, reassuring with stressed ones.

// ### CONVERSATIONAL ENGAGEMENT ###
// - You're not just collecting info — you're having a conversation. React to what they say like a real person would.
// - If they describe a problem, ACKNOWLEDGE it briefly before moving on.
// - Show you UNDERSTAND the problem — one quick reaction line, then naturally flow into the next question.
// - Don't just say "got it" and move on. Actually acknowledge what they're dealing with.
// - Keep it brief though — one reaction, then the next question. Don't ramble.

// ### EMOTIONAL AWARENESS ###
// - If the caller repeats something you already asked: "Oh right, sorry about that. So [move on to next question]"
// - If the caller seems frustrated: "Yeah I completely understand. Let me just grab a couple more details and I'll get this sorted for you."
// - If the caller is chatty and going off-topic: "Ha yeah absolutely. Anyway, let me just grab your [next detail] so I can get things moving."
// - If the caller is in a rush: "No worries, I'll keep it quick. Just need a few things."
// - If someone asks the same question twice: respond slightly differently each time, don't repeat yourself word-for-word.

// ### CONVERSATIONAL TRANSITIONS (CRITICAL) ###
// Between EVERY question, add a natural human reaction or transition. NEVER go question-to-question like a checklist.
// These transitions should feel like something a real person would say. Vary them every time — NEVER repeat the same transition twice in one call.

// AFTER GETTING NAME → Warm greeting, then ask what's going on. Let THEM tell you why they're calling. Pick up whatever details they mention naturally. Only ask for details they DIDN'T already mention.

// AFTER THEY DESCRIBE THE PROBLEM → React naturally to what they said. Show you understand. Then lead into collecting remaining details.

// AFTER GETTING PHONE NUMBER → Brief acknowledgment, then ask for address naturally.

// AFTER GETTING ADDRESS → Brief acknowledgment, then ask about urgency.

// AFTER GETTING URGENCY (low/medium severity only) → Respond based on what they said — acknowledge if it's pressing, stay relaxed if they're relaxed. HIGH SEVERITY: this step does not happen — urgency is already known.

// BEFORE ASKING PREFERRED TIME → Signal that you're wrapping up. For HIGH severity, frame it with urgency: "Just one last thing — when do you need someone?" For LOW/MEDIUM, stay relaxed: "Nearly done — when works best for you?"

// IMPORTANT: Generate natural, varied transition lines every time. Never repeat the same one in a single call.

// ### HANDLING INTERRUPTIONS (FALSE BARGE-IN RECOVERY) ###
// - Sometimes background noise may trigger an interruption even though the caller didn't actually say anything.
// - If you get interrupted but the caller doesn't say anything meaningful, re-engage naturally.
// - NEVER go silent. If there's an awkward pause, YOU pick the conversation back up.
// - Vary your recovery lines — don't say the exact same thing every time.

// ### SERVICE TYPES — OPEN-ENDED (CRITICAL) ###
// You handle ALL types of trade work. There is NO fixed list. Accept ANY valid trade or home service the caller mentions. Do NOT limit or suggest only specific trade types. Let the caller tell you what they need. If it involves hands-on work at a home or property, it counts.

// ### PROBLEM CLARITY & SEVERITY SCORING (CRITICAL — DO THIS BEFORE ANY FOLLOW-UP) ###

// Every time a caller describes their situation, silently assess it on two axes before deciding how to respond. This is not a checklist — it is a judgement call you make the same way a real experienced person would.

// AXIS 1 — SEVERITY: How distressing or urgent does this sound for the caller right now?
// - LOW: routine, non-urgent, planning ahead (painting a room, building a deck, replacing a tap)
// - MEDIUM: inconvenient, needs attention soon but not an emergency (leak that isn't flooding, appliance not working, door that sticks)
// - HIGH: distressing, urgent, already causing damage, potentially dangerous, or genuinely scary for the caller (structural damage, major flooding, total power loss, roof coming in, gas smell, wall collapsing, anything they describe with panic or urgency in their voice)

// AXIS 2 — PROBLEM CLARITY: How well do you understand what happened based on what they said?
// - CLEAR: you know what the problem is even if you don't have every detail — a real tradie calling back would have enough to start the conversation
// - UNCLEAR: genuinely vague — you don't have enough to describe the job to anyone

// ─────────────────────────────────────────────
// HOW TO RESPOND BASED ON YOUR ASSESSMENT:
// ─────────────────────────────────────────────

// IF SEVERITY IS HIGH (regardless of clarity):
// → Do NOT ask "what type of work do you think you need?" — ever. They are stressed and that question makes them feel like they called the wrong number.
// → Do NOT interrogate. Do NOT ask any follow-up question about the problem.
// → React with genuine human empathy that matches the weight of what they described. Show you heard them.
// → Immediately reassure them that someone will call back as soon as possible to work out what needs to happen.
// → Shift your energy — faster, warmer, more focused. Get their details and get off the phone efficiently.
// → For service_type in the booking: infer it yourself from context. Use descriptive shorthand like "structural emergency", "plumbing emergency", "electrical emergency". The tradie will assess when they call.
// → For problem_description: capture everything they said in as much detail as possible. This is what the tradie reads before calling back.
// → Example energy: "Okay wow, that sounds serious. Let me grab your details now and we'll get someone to call you back as soon as possible to work out what needs to happen."
// → CRITICAL: Even on HIGH severity you MUST still go through FINAL ACTION and call save_customer_booking. The DB save is not optional. Collect all 7 fields (name, phone, address, urgency, service_type, problem_description, preferred_time) then proceed to STEP A.

// IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS CLEAR:
// → React naturally and acknowledge what they said before moving on.
// → Ask ONE context-driven follow-up question ONLY if it would genuinely help the tradie who calls back. Base it entirely on the caller's exact words — never on a template.
// → The question must be impossible to ask without having heard exactly what this person said. If it could go to any caller with the same trade type, it is too generic.
// → If they already gave enough detail, skip the follow-up entirely.

// IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS UNCLEAR:
// → Ask ONE short clarifying question — but make it specific to what they said.
// → NEVER ask "what type of work do you think you need?" — they called because they don't know. Ask about their specific situation instead.
// → Example: not "what trade do you need?" but "is it something that's been getting worse, or did it just happen?"

// ─────────────────────────────────────────────
// WHEN A FOLLOW-UP IS APPROPRIATE — THE RULE:
// ─────────────────────────────────────────────
// 1. Listen to their exact words.
// 2. Think: what would a real tradie genuinely need to know to prepare for this specific job?
// 3. Ask ONE question that could only be asked after hearing exactly what this person said.

// NEVER ask:
// - "What type of work do you think you need?" — they don't know, that's why they called
// - "Can you tell me more?" — too vague, too robotic
// - "What exactly is the issue?" — too broad, adds nothing

// ALWAYS make it specific to what they said. Reference their actual words.

// Example thinking — understand the logic, never copy the words:
// - "My hot water system is making a weird banging noise" → When does it happen? "Is it doing it when you first turn the tap on, or is it more constant?"
// - "I need a deck built out the back" → What's the scope? "Have you got a rough idea of the size, or do you want someone to come out and measure up?"
// - "There's mould coming through the bathroom ceiling" → What's above it? "Is there a bathroom directly above it, or is it more likely from the roof?"
// - "The garage door won't open anymore" → Was it sudden? "Did it just stop one day, or has it been getting harder to open for a while?"
// - "We need the whole house repainted before we sell" → What's the timeline? "When are you looking to have it done — do you have a settlement date you're working toward?"

// Every caller gets a response shaped entirely by what they specifically said.

// ### OFF-TOPIC HANDLING (STRICT) ###
// You are ONLY here to help with tradie bookings and trade-related work. You have NO information on anything outside of this scope.

// - If someone asks about ANYTHING not related to trade services, home repairs, maintenance, or bookings:
//   "Ah sorry mate, I don't really have info on that. I only handle tradie bookings — anything around the house that needs fixing or building, I'm your guy. Got anything like that you need sorted?"

// - This includes but is not limited to: weather, news, sports, politics, general knowledge, medical advice, legal advice, financial advice, restaurant recommendations, travel, entertainment, tech support, software, shopping, or any other non-trade topic.

// - If they keep pushing off-topic: "Yeah look, I appreciate the chat, but that's really not my area. If you've got any work that needs doing around the place though, I can definitely help with that."

// - Always pivot back: After declining, gently check if they actually need trade work done.

// - Be firm but friendly. Don't engage with off-topic content at all — don't speculate, don't guess, don't try to be helpful on topics outside your scope. Just redirect.

// ### THE BOOKING FLOW ###

// You must populate these 7 booking fields before save_customer_booking: name, phone, address, urgency, service type, problem description, preferred time.
// Do it conversationally — not like a form. And critically: the PROBLEM CLARITY & SEVERITY SCORING rules above govern what you skip and how you behave at every step.

// For HIGH SEVERITY calls, fields can be populated by inference instead of direct questions:
// - urgency = "urgent"
// - preferred_time = "ASAP"
// - service_type inferred from context if caller did not state it

// ─────────────────────────────────────────────
// STEP 1 — NAME
// ─────────────────────────────────────────────
// Always start here: "Hey! Jack here. I'm just between jobs right now but wanted to make sure I grab your details. Who am I speaking with?"

// ─────────────────────────────────────────────
// STEP 2 — WHAT'S GOING ON (problem + severity assessment)
// ─────────────────────────────────────────────
// Greet them by name and ask what's going on. Let them tell you. This is where you make your severity assessment.
// Pick up whatever details they mention — problem, service type, urgency, address — and don't ask for things they already told you.

// ─────────────────────────────────────────────
// STEP 3 — PHONE
// ─────────────────────────────────────────────
// Always collect. Ask for their best contact number.
// Once they give it, read it back digit by digit — e.g. "So that's 0-4-1-2-3-4-5-6-7-8 — that right?"
// Wait for explicit confirmation. If they correct a digit, read the full number back again and wait again.
// Do NOT move on until confirmed.

// CRITICAL — HOW TO READ PHONE NUMBERS BACK:
// - ALWAYS say each digit as a separate spoken word in English. No exceptions.
// - Say: "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"
// - NEVER group digits into pairs or larger numbers. Never say "forty-one" or "twelve" — say "four one" and "one two".
// - NEVER use any non-English word, sound, or number system when reading digits. English digit words only.
// - Format: read every single digit individually with a natural short pause between each one.
// - Example: 0412345678 → "zero, four, one, two, three, four, five, six, seven, eight — that right?"
// - If you catch yourself about to say a number in any other language, STOP and say the English word instead.

// ─────────────────────────────────────────────
// STEP 4 — ADDRESS
// ─────────────────────────────────────────────
// ALWAYS collect — including HIGH severity calls. The tradie needs to know where to go.
// Ask: "And where's the job located?" (skip only if they already gave the address earlier in the call).
// For HIGH severity, keep it fast and to the point — no extra chat, just get the address and move on.

// ─────────────────────────────────────────────
// STEP 5 — URGENCY
// ─────────────────────────────────────────────
// IF SEVERITY IS HIGH: SKIP THIS QUESTION ENTIRELY.
// You already know it's urgent from what they described. Asking "how urgent is it?" to someone whose wall is falling down is tone-deaf. Set urgency = "urgent" in the booking and move on.

// IF SEVERITY IS LOW OR MEDIUM: Ask how urgent it is for them. Take their answer and use it.

// ─────────────────────────────────────────────
// STEP 6 — SERVICE TYPE
// ─────────────────────────────────────────────
// IF SEVERITY IS HIGH: SKIP THIS QUESTION ENTIRELY.
// Infer the service type from what they described and fill it in yourself. Do not ask the caller to diagnose their own emergency.
// Examples of how to infer: wall collapsing → "structural emergency", flooding → "plumbing emergency", no power → "electrical emergency", roof coming in → "roofing emergency". Use your judgement — be descriptive.

// IF SERVICE TYPE WAS ALREADY MENTIONED BY THE CALLER: SKIP. Use what they said.

// IF SEVERITY IS LOW OR MEDIUM AND IT'S GENUINELY UNCLEAR: Ask what kind of work they need. Keep it open-ended. Never suggest specific trades.

// ─────────────────────────────────────────────
// STEP 7 — PROBLEM FOLLOW-UP
// ─────────────────────────────────────────────
// IF SEVERITY IS HIGH: Do NOT ask follow-up questions about the problem. You have enough. Move directly to STEP 8 (preferred time), then proceed to FINAL ACTION and call save_customer_booking. The DB save is MANDATORY even on HIGH severity — do not skip it.

// IF SEVERITY IS LOW OR MEDIUM: This is where you get proper detail about the problem so the tradie actually knows what they're walking into. Ask targeted follow-up questions based on exactly what the caller described. These must be specific to their words — not generic. Keep going until you have a clear picture of:
// - What exactly is happening
// - How long it has been going on
// - Any relevant context (size, location, severity, history)
// Ask one question at a time. Stop when you genuinely have enough for a tradie to prepare. Do NOT pepper them — but do NOT stop at one question if more detail is clearly needed.

// ─────────────────────────────────────────────
// STEP 8 — PREFERRED TIME
// ─────────────────────────────────────────────
// ALWAYS ask — including HIGH severity calls. You must collect this field every time.

// IF SEVERITY IS HIGH: Ask it quickly and with urgency framing. Example: "And when do you need someone out — is right now the soonest, or is there a window that works?" Keep it short. Take whatever they say and use it. Do NOT skip this step.

// IF SEVERITY IS LOW OR MEDIUM: Ask when works best for them. Signal you're wrapping up before asking.

// ─────────────────────────────────────────────
// GENERAL RULE FOR ALL STEPS
// ─────────────────────────────────────────────
// If the caller volunteers information at any point, take it and skip the corresponding question. Don't re-ask things you already know.
// The conversation should breathe. Never rapid-fire questions back to back.

// ### FINAL ACTION — READ THIS CAREFULLY (CRITICAL) ###

// This section governs exactly what happens once you have all 7 pieces of information.
// Follow these steps IN ORDER. Do not skip any step.

// ─────────────────────────────────────────────
// STEP A — ASK THE "ANYTHING TO ADD?" QUESTION
// ─────────────────────────────────────────────
// Once you have all 7 details, you MUST ask this question FIRST — before doing anything else:

//   "Perfect, I've got all the details. Is there anything else you'd like to add before I send this through?"

// Do NOT call the save function yet. Wait for the caller's response.

// If the caller is silent or unclear after this question, re-engage quickly (no long pause) with one short prompt like:
// "No rush — should I send this through now, or did you want to add anything else?"

// ─────────────────────────────────────────────
// STEP B — HANDLE THEIR RESPONSE
// ─────────────────────────────────────────────
// TWO possible outcomes:

// OUTCOME 1 — They want to add more:
// - Ask for the extra detail naturally.
// - Listen to what they say and incorporate it into problem_description.
// - After collecting the extra detail, acknowledge it briefly, then ask once more:
//   "Got it, anything else or shall I send this through now?"
// - Repeat OUTCOME 1 as many times as needed until they are done.

// OUTCOME 2 — They are ready to proceed:
// - Treat ANY of the following as "proceed": "no", "nope", "that's it", "all good", "go ahead", "yep send it", "sounds good", "nothing else", "you go ahead", "that's everything", "all done", "no more from me", or any natural approval meaning "proceed".
// - If genuinely ambiguous, ask ONE short clarifier: "No stress — ready to send this through, or did you want to add something first?"
// - The moment intent is clearly "proceed", go immediately to STEP C.

// ─────────────────────────────────────────────
// STEP C — CALL THE DATABASE FUNCTION
// ─────────────────────────────────────────────
// - Your very next action MUST be a function call to save_customer_booking.
// - Do NOT send any text or speech before the function call executes.
// - Include ALL details gathered throughout the entire conversation in the fields, especially problem_description — make it as rich and detailed as possible based on everything the caller said.
// - This function call is NON-NEGOTIABLE. The booking cannot end without it.

// ─────────────────────────────────────────────
// STEP D — AFTER SUCCESSFUL SAVE
// ─────────────────────────────────────────────
// Once the tool returns success, your closing line depends on the severity you assessed earlier in the call.

// IF SEVERITY WAS HIGH (urgent situation, emergency, serious damage):
//   Say something like this — vary it naturally each time, don't say it word for word:
//   "Okay [name], that's all through. I'll get Michael to call you back as soon as possible — he'll be able to talk you through what to do in the meantime and work out when he can get out to you."

//   The key elements to always include:
//   - Use their name
//   - Say Michael will call them back (not "a tradie", not "someone" — Michael)
//   - Make it feel urgent and personal, not like a ticket number
//   - Mention he'll help them with what to do in the meantime — this reassures them they won't just be left waiting with a crisis
//   - Do NOT say they are booked in, locked in, or that anyone is on their way

// IF SEVERITY WAS LOW OR MEDIUM (normal booking flow):
//   Say something like this — vary it naturally:
//   "Perfect, thanks [name]. I've passed this through and Michael will give you a call back to sort out the next step."

//   Keep it warm and simple. No over-promising.

// RULES FOR BOTH:
// - Do NOT say a visit is booked or confirmed.
// - Do NOT promise a specific time or date.
// - Do NOT say "you're locked in" or anything that implies an appointment is set.
// - The call is now complete.

// ─────────────────────────────────────────────
// FAILURE SAFEGUARD
// ─────────────────────────────────────────────
// If save_customer_booking has NOT been called before any attempt to close or end the conversation, you MUST go back and complete STEP C before allowing the call to end. The booking CANNOT be closed without a successful database save.

// ### HARD RULES ###
// - Language: ENGLISH ONLY — see the absolute rule at the very top of this prompt.
// - ONE question at a time — never stack questions.
// - Keep responses SHORT — 1 to 2 sentences max.
// - SILENCE HANDLING: If you receive a [SYSTEM: The user has been silent...] instruction, speak exactly what it says, naturally and conversationally. The instruction will always start with "I guess you didn't hear that, let me repeat my question." followed by the last question. Say it exactly as written. Do NOT add extra content, explanations, or new questions. Do NOT rephrase. Repeat only.
// - If there's silence, re-engage naturally: "Still there?" or "Sorry, didn't catch that."
// - Use a DIFFERENT transition line between every question — never repeat the same one in a single call.
// - Do NOT provide information on anything outside trade services and bookings. You simply don't have that info.
// - Accept ALL valid trade types — never limit to specific ones.
// - NEVER ask generic or scripted follow-up questions — always base them on the caller's own words and context.
// - ALWAYS call save_customer_booking before ending the call. This rule overrides everything else.`;
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // TOOL DEFINITION
//   // ─────────────────────────────────────────────────────────────────────────────

//   private getSaveBookingTool() {
//     return {
//       type: 'function',
//       name: 'save_customer_booking',
//       description: 'Saves customer booking details to MongoDB.',
//       parameters: {
//         type: 'object',
//         properties: {
//           name: { type: 'string' },
//           phone: { type: 'string' },
//           address: { type: 'string' },
//           urgency: { type: 'string' },
//           service_type: { type: 'string' },
//           problem_description: { type: 'string' },
//           preferred_time: { type: 'string' },
//         },
//         required: [
//           'name',
//           'phone',
//           'address',
//           'urgency',
//           'service_type',
//           'problem_description',
//           'preferred_time',
//         ],
//       },
//     };
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // CLEANUP
//   // ─────────────────────────────────────────────────────────────────────────────

//   closeSession(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (session) {
//       this.closeElevenLabsWs(sessionId);
//       session.ws.close();
//       this.sessions.delete(sessionId);
//       this.logger.log(`[${sessionId}] Active Call Disconnected`);
//     }
//   }
// }
// import { Injectable, Logger } from '@nestjs/common';
// import { ConfigService } from '@nestjs/config';
// import { InjectModel } from '@nestjs/mongoose';
// import { ClientRequest } from 'http';
// import { Model } from 'mongoose';
// import { Socket } from 'net';
// import { TLSSocket } from 'tls';
// import WebSocket from 'ws';
// import { Customer, CustomerDocument } from './Schema/customer.schema';

// /**
//  * RealtimeSession interface tracks the state of a single voice call.
//  * This includes the connection to OpenAI (Brain) and ElevenLabs (Voice).
//  */
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

//   // ── Silence re-prompt tracking ──────────────────────────────────────────────
//   // Stores the last question/statement Jack said so we can repeat it on silence.
//   lastQuestionAsked: string;
//   // How many consecutive silence re-prompts have fired without a user response.
//   silenceRepromptCount: number;
// }

// interface FunctionCallPayload {
//   name: string;
//   arguments: string;
//   call_id: string;
// }

// @Injectable()
// export class VoiceService {
//   private readonly logger = new Logger(VoiceService.name);

//   private sessions = new Map<string, RealtimeSession>();

//   private toFunctionCallPayload(value: unknown): FunctionCallPayload | null {
//     if (!value || typeof value !== 'object') return null;

//     const record = value as Record<string, unknown>;
//     const type = record.type;
//     const name = record.name;
//     const args = record.arguments;
//     const callId = record.call_id;

//     if (type !== 'function_call') return null;
//     if (
//       typeof name !== 'string' ||
//       typeof args !== 'string' ||
//       typeof callId !== 'string'
//     ) {
//       return null;
//     }

//     return { name, arguments: args, call_id: callId };
//   }

//   constructor(
//     private readonly config: ConfigService,
//     @InjectModel(Customer.name)
//     private readonly customerModel: Model<CustomerDocument>,
//   ) {}

//   // ─────────────────────────────────────────────────────────────────────────────
//   // SILENCE HANDLING
//   // Called by the client (via gateway) after ElevenLabs audio finishes and
//   // a configurable silence window (default 5 s) passes with no user speech.
//   // ─────────────────────────────────────────────────────────────────────────────

//   /**
//    * MAX_SILENCE_REPROMPTS — after this many consecutive silent timeouts we
//    * politely close the call rather than looping forever.
//    */
//   private readonly MAX_SILENCE_REPROMPTS = 2;

//   /**
//    * handleSilenceTimeout
//    *
//    * Triggered externally (e.g. from your WebSocket gateway) when the client
//    * detects the user has been silent for too long after Jack finished speaking.
//    *
//    * Behaviour:
//    *  - If Jack is still generating a response, ignore (audio not done yet).
//    *  - If we've already re-prompted MAX_SILENCE_REPROMPTS times, inject a
//    *    polite closing message and end the session.
//    *  - Otherwise inject the last question back into the conversation via
//    *    conversation.item.create so OpenAI re-speaks it naturally, then
//    *    trigger a new response.create.
//    */
//   handleSilenceTimeout(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     // Don't fire while OpenAI is mid-response — audio isn't done yet.
//     if (session.isResponseActive) {
//       this.logger.debug(
//         `[${sessionId}] Silence timeout ignored — response still active`,
//       );
//       return;
//     }

//     session.silenceRepromptCount += 1;

//     if (session.silenceRepromptCount > this.MAX_SILENCE_REPROMPTS) {
//       this.logger.log(
//         `[${sessionId}] Max silence re-prompts reached — closing call politely`,
//       );
//       this._injectAndRespond(
//         sessionId,
//         "It seems like you might have stepped away. No worries — feel free to call back whenever you're ready. Take care!",
//       );
//       // Give the closing message a moment to play before tearing down.
//       setTimeout(() => this.closeSession(sessionId), 8000);
//       return;
//     }

//     const reprompt = this._buildSilenceReprompt(session);
//     this.logger.log(
//       `[${sessionId}] Silence timeout #${session.silenceRepromptCount} — re-prompting: "${reprompt}"`,
//     );
//     this._injectAndRespond(sessionId, reprompt);
//   }

//   /**
//    * _buildSilenceReprompt
//    *
//    * Constructs the silence re-prompt.
//    *
//    * Spec requirement: always say "I guess you didn't hear that, let me repeat
//    * my question." then repeat the last question verbatim.
//    * If no last question is stored, fall back to a generic check-in.
//    */
//   private _buildSilenceReprompt(session: RealtimeSession): string {
//     const last = session.lastQuestionAsked?.trim();

//     if (!last) {
//       // No stored question yet (e.g. silence before Jack has said anything).
//       return "I guess you didn't hear that — are you still there?";
//     }

//     // Both attempt 1 and attempt 2 use the same required phrase then repeat
//     // the last question exactly. The spec says "only repeat last question" with
//     // no new content, so we keep this consistent across attempts.
//     return `I guess you didn't hear that, let me repeat my question. ${last}`;
//   }

//   /**
//    * _injectAndRespond
//    *
//    * Injects a plain text instruction into the OpenAI conversation as a
//    * system/user turn, then triggers response.create so OpenAI speaks it
//    * via the normal text → ElevenLabs pipeline.
//    */
//   private _injectAndRespond(sessionId: string, text: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session || session.ws.readyState !== WebSocket.OPEN) return;

//     // Inject the re-prompt text as a user-visible assistant instruction.
//     session.ws.send(
//       JSON.stringify({
//         type: 'conversation.item.create',
//         item: {
//           type: 'message',
//           role: 'user',
//           content: [
//             {
//               type: 'input_text',
//               // Tell the model what to say — it will paraphrase naturally.
//               text: `[SYSTEM: The user has been silent. Re-engage by saying exactly this, naturally: "${text}"]`,
//             },
//           ],
//         },
//       }),
//     );

//     session.ws.send(JSON.stringify({ type: 'response.create' }));
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // INCOMING CALL HANDLER
//   // ─────────────────────────────────────────────────────────────────────────────

//   async handleIncomingCall(callData: {
//     call_id: string;
//     caller_number: string;
//     called_number: string;
//   }) {
//     this.logger.log(`Voice Service handling call: ${callData.call_id}`);

//     try {
//       await this.createRealtimeSession(callData.call_id, (event) => {
//         this.logger.log(`[${callData.call_id}] Voice event: ${event.type}`);

//         if (event.type === 'audio-delta') {
//           this.sendAudioToAri(callData.call_id, event.delta);
//         }
//       });

//       this.triggerGreeting(callData.call_id);

//       return {
//         success: true,
//         message: 'Voice session created successfully',
//         call_id: callData.call_id,
//       };
//     } catch (error) {
//       this.logger.error(`Error in Voice call handling: ${error.message}`);
//       return { success: false, error: error.message };
//     }
//   }

//   private sendAudioToAri(callId: string, audioDelta: string) {
//     this.logger.log(
//       `[${callId}] Sending audio to ARI: ${audioDelta.length} chars`,
//     );
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // STEP 1: Create OpenAI Realtime session
//   // ─────────────────────────────────────────────────────────────────────────────

//   async createRealtimeSession(
//     sessionId: string,
//     onEvent: (event: any) => void,
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
//       this.instrumentClientWebSocketHandshake(
//         sessionId,
//         'OpenAI',
//         ws,
//         sessionStartedAtMs,
//       );

//       ws.on('open', () => {
//         const openAiConnectedAtMs = Date.now();
//         this.logger.log(`[${sessionId}] OpenAI Realtime WebSocket connected`);
//         this.logger.log(
//           `[${sessionId}] Timing: OpenAI WS connected in ${openAiConnectedAtMs - sessionStartedAtMs}ms`,
//         );

//         const sessionUpdate = {
//           type: 'session.update',
//           session: {
//             modalities: ['text'],
//             instructions: this.getSystemPrompt(),
//             input_audio_format: 'pcm16',
//             turn_detection: {
//               type: 'server_vad',
//               threshold: 0.8,
//               prefix_padding_ms: 300,
//               silence_duration_ms: 2000,
//             },
//             tools: [this.getSaveBookingTool()],
//             tool_choice: 'auto',
//           },
//         };

//         ws.send(JSON.stringify(sessionUpdate));

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
//           processedFunctionCallIds: new Set<string>(),
//           // Silence tracking initialised empty
//           lastQuestionAsked: '',
//           silenceRepromptCount: 0,
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
//         this.logger.error(`[${sessionId}] OpenAI WebSocket error:`, err);
//         onEvent({ type: 'error', error: { message: err.message } });
//         reject(err);
//       });

//       ws.on('close', (code, reason) => {
//         this.logger.log(
//           `[${sessionId}] OpenAI WebSocket closed: ${code} - ${reason}`,
//         );
//         this.closeElevenLabsWs(sessionId);
//         this.sessions.delete(sessionId);
//         onEvent({ type: 'session-closed' });
//       });
//     });
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // STEP 2: Relay user audio to OpenAI
//   // ─────────────────────────────────────────────────────────────────────────────

//   sendAudio(sessionId: string, base64Audio: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     session.ws.send(
//       JSON.stringify({
//         type: 'input_audio_buffer.append',
//         audio: base64Audio,
//       }),
//     );
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // STEP 3: Greeting
//   // ─────────────────────────────────────────────────────────────────────────────

//   triggerGreeting(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     session.greetingTriggeredAtMs = Date.now();
//     this.logger.log(
//       `[${sessionId}] Timing: greeting trigger fired at ${session.greetingTriggeredAtMs - session.sessionStartedAtMs}ms from session start`,
//     );
//     session.ws.send(JSON.stringify({ type: 'response.create' }));
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // STEP 4: ElevenLabs integration
//   // ─────────────────────────────────────────────────────────────────────────────

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
//     this.instrumentClientWebSocketHandshake(
//       sessionId,
//       'ElevenLabs',
//       elWs,
//       session.sessionStartedAtMs,
//     );

//     elWs.on('open', () => {
//       this.logger.log(`[${sessionId}] ElevenLabs WebSocket connected`);
//       session.elevenLabsConnectedAtMs = Date.now();
//       this.logger.log(
//         `[${sessionId}] Timing: ElevenLabs WS connected in ${session.elevenLabsConnectedAtMs - session.sessionStartedAtMs}ms`,
//       );

//       elWs.send(
//         JSON.stringify({
//           text: ' ',
//           voice_settings: {
//             stability: 0.4,
//             similarity_boost: 0.75,
//             speed: 1.15,
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
//             const firstAudioAtMs = Date.now();
//             session.firstAudioDeltaLogged = true;
//             const openAiMs = session.openAiConnectedAtMs
//               ? session.openAiConnectedAtMs - session.sessionStartedAtMs
//               : -1;
//             const elevenLabsMs = session.elevenLabsConnectedAtMs
//               ? session.elevenLabsConnectedAtMs - session.sessionStartedAtMs
//               : -1;
//             const greetingMs = session.greetingTriggeredAtMs
//               ? session.greetingTriggeredAtMs - session.sessionStartedAtMs
//               : -1;
//             const responseCreatedAfterGreetingMs =
//               session.firstResponseCreatedAtMs && session.greetingTriggeredAtMs
//                 ? session.firstResponseCreatedAtMs -
//                   session.greetingTriggeredAtMs
//                 : -1;
//             const firstAudioAfterResponseCreatedMs =
//               session.firstResponseCreatedAtMs
//                 ? firstAudioAtMs - session.firstResponseCreatedAtMs
//                 : -1;

//             this.logger.log(
//               `[${sessionId}] Timing: first audio delta at ${firstAudioAtMs - session.sessionStartedAtMs}ms (openai=${openAiMs}ms, elevenlabs=${elevenLabsMs}ms, greeting=${greetingMs}ms, response_created_after_greeting=${responseCreatedAfterGreetingMs}ms, audio_after_response_created=${firstAudioAfterResponseCreatedMs}ms)`,
//             );
//           }
//           session.onEvent({ type: 'audio-delta', delta: msg.audio });
//         }

//         // ── Signal audio-done so the client can start its silence timer ────────
//         // ElevenLabs sends isFinal=true on the last audio chunk of a turn.
//         if (msg.isFinal === true) {
//           session.onEvent({ type: 'audio-done' });
//         }
//       } catch (err) {
//         // Intentionally silent — non-JSON frames (binary audio) ignored
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

//   private instrumentClientWebSocketHandshake(
//     sessionId: string,
//     provider: 'OpenAI' | 'ElevenLabs',
//     ws: WebSocket,
//     startedAtMs: number,
//   ): void {
//     const wsWithReq = ws as WebSocket & { _req?: ClientRequest };
//     const req = wsWithReq._req;
//     if (!req) {
//       this.logger.warn(
//         `[${sessionId}] Timing: ${provider} request object not available for low-level socket timings`,
//       );
//       return;
//     }

//     let socketHooksAttached = false;
//     const attachSocketHooks = (socket: Socket): void => {
//       if (socketHooksAttached) return;
//       socketHooksAttached = true;

//       socket.once('lookup', () => {
//         this.logger.log(
//           `[${sessionId}] Timing: ${provider} DNS lookup completed in ${Date.now() - startedAtMs}ms`,
//         );
//       });

//       socket.once('connect', () => {
//         this.logger.log(
//           `[${sessionId}] Timing: ${provider} TCP connect completed in ${Date.now() - startedAtMs}ms`,
//         );
//       });

//       (socket as TLSSocket).once('secureConnect', () => {
//         this.logger.log(
//           `[${sessionId}] Timing: ${provider} TLS handshake completed in ${Date.now() - startedAtMs}ms`,
//         );
//       });
//     };

//     if (req.socket) {
//       attachSocketHooks(req.socket);
//     }
//     req.once('socket', (socket: Socket) => {
//       attachSocketHooks(socket);
//     });

//     ws.on('upgrade', () => {
//       this.logger.log(
//         `[${sessionId}] Timing: ${provider} WS upgrade completed in ${Date.now() - startedAtMs}ms`,
//       );
//     });

//     ws.on('open', () => {
//       this.logger.log(
//         `[${sessionId}] Timing: ${provider} WS open event at ${Date.now() - startedAtMs}ms`,
//       );
//     });
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
//     if (session?.elevenLabsWs) {
//       try {
//         if (session.elevenLabsWs.readyState === WebSocket.CONNECTING) {
//           session.elevenLabsWs.terminate();
//         } else if (session.elevenLabsWs.readyState === WebSocket.OPEN) {
//           session.elevenLabsWs.close();
//         }
//       } catch (err) {
//         this.logger.warn(
//           `[${sessionId}] Error closing ElevenLabs WS: ${err.message}`,
//         );
//       }
//       session.elevenLabsWs = null;
//       session.elevenLabsReady = false;
//       session.textBuffer = [];
//     }
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // STEP 5: THE EVENT HUB
//   // ─────────────────────────────────────────────────────────────────────────────

//   private async handleRealtimeEvent(
//     sessionId: string,
//     event: any,
//   ): Promise<void> {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     this.logger.debug(`[${sessionId}] OpenAI Debug Event: ${event.type}`);

//     switch (event.type) {
//       case 'response.created':
//         session.isResponseActive = true;
//         // Reset silence counter — user said something, Jack is responding.
//         session.silenceRepromptCount = 0;

//         if (!session.firstResponseCreatedAtMs) {
//           session.firstResponseCreatedAtMs = Date.now();
//           const fromSessionStart =
//             session.firstResponseCreatedAtMs - session.sessionStartedAtMs;
//           const fromGreeting = session.greetingTriggeredAtMs
//             ? session.firstResponseCreatedAtMs - session.greetingTriggeredAtMs
//             : -1;
//           this.logger.log(
//             `[${sessionId}] Timing: first response.created at ${fromSessionStart}ms (after greeting=${fromGreeting}ms)`,
//           );
//         }
//         this.openElevenLabsStream(sessionId);
//         break;

//       case 'response.done':
//         session.isResponseActive = false;
//         {
//           const typedEvent = event as { response?: { output?: unknown } };
//           const outputs = typedEvent.response?.output;
//           if (Array.isArray(outputs)) {
//             for (const item of outputs) {
//               const functionCall = this.toFunctionCallPayload(item);
//               if (functionCall) {
//                 await this.handleFunctionCall(sessionId, functionCall);
//               }
//             }
//           }
//         }
//         break;

//       case 'response.text.delta':
//         if (session.elevenLabsReady) {
//           this.sendTextToElevenLabs(sessionId, event.delta);
//         } else {
//           session.textBuffer.push(event.delta);
//         }
//         session.onEvent({ type: 'transcript-delta', delta: event.delta });
//         break;

//       case 'response.text.done':
//         // ── Track last question for silence re-prompt ──────────────────────────
//         // Store the full text Jack just said. The silence handler will repeat
//         // the final sentence/question if the user goes quiet.
//         if (typeof event.text === 'string' && event.text.trim()) {
//           session.lastQuestionAsked = event.text.trim();
//         }
//         this.flushElevenLabsStream(sessionId);
//         session.onEvent({ type: 'transcript-done', transcript: event.text });
//         break;

//       case 'input_audio_buffer.speech_started':
//         this.logger.log(`[${sessionId}] USER INTERRUPTED -> Stopping AI Voice`);

//         // User spoke — reset silence counter.
//         session.silenceRepromptCount = 0;

//         if (session.isResponseActive) {
//           try {
//             session.ws.send(JSON.stringify({ type: 'response.cancel' }));
//           } catch (err) {
//             this.logger.warn(
//               `[${sessionId}] Cancel failed (already finished): ${err.message}`,
//             );
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

//       case 'response.output_item.done':
//         {
//           const typedEvent = event as { item?: unknown };
//           const functionCall = this.toFunctionCallPayload(typedEvent.item);
//           if (functionCall) {
//             await this.handleFunctionCall(sessionId, functionCall);
//           }
//         }
//         break;

//       case 'error':
//         this.logger.error(
//           `[${sessionId}] OpenAI Error: ${JSON.stringify(event.error)}`,
//         );
//         break;
//     }
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // STEP 6: DATA PERSISTENCE
//   // ─────────────────────────────────────────────────────────────────────────────

//   private async handleFunctionCall(
//     sessionId: string,
//     event: any,
//   ): Promise<void> {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     if (event.name === 'save_customer_booking') {
//       const typedEvent = event as { call_id?: unknown };
//       const callId =
//         typeof typedEvent.call_id === 'string' ? typedEvent.call_id : null;

//       if (callId && session.processedFunctionCallIds.has(callId)) {
//         this.logger.debug(
//           `[${sessionId}] Duplicate function call ignored: ${callId}`,
//         );
//         return;
//       }

//       if (callId) {
//         session.processedFunctionCallIds.add(callId);
//       }

//       try {
//         const args = JSON.parse(event.arguments);
//         this.logger.log(
//           `[${sessionId}] Saving Booking to MongoDB for: ${args.name}`,
//         );

//         const customer = await this.customerModel.create({
//           name: args.name,
//           phone: args.phone,
//           address: args.address,
//           urgency: args.urgency,
//           serviceType: args.service_type,
//           problemDescription: args.problem_description,
//           preferredTime: args.preferred_time,
//           summary: `Tradie Booking: ${args.service_type}`,
//         });

//         this.logger.log(
//           `[${sessionId}] SUCCESS: Customer saved with ID ${customer._id}`,
//         );

//         session.ws.send(
//           JSON.stringify({
//             type: 'conversation.item.create',
//             item: {
//               type: 'function_call_output',
//               call_id: event.call_id,
//               output: JSON.stringify({
//                 success: true,
//                 message: 'Saved to Database.',
//               }),
//             },
//           }),
//         );

//         session.ws.send(JSON.stringify({ type: 'response.create' }));
//         session.onEvent({ type: 'booking-saved', data: args });
//       } catch (err) {
//         if (callId) {
//           session.processedFunctionCallIds.delete(callId);
//         }
//         this.logger.error(`[${sessionId}] MongoDB Save Failed:`, err);
//       }
//     }
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // SYSTEM PROMPT
//   // ─────────────────────────────────────────────────────────────────────────────

//   private getSystemPrompt(): string {
//     return `
// =============================================================
// ABSOLUTE RULE — ENGLISH ONLY. THIS OVERRIDES EVERYTHING ELSE.
// =============================================================
// You MUST speak and respond in English at all times, no matter what.
// - If the caller speaks in another language, respond ONLY in English.
// - Do NOT switch to their language, do NOT mix languages, do NOT use any word, phrase, filler, or expression from any non-English language.
// - If you ever catch yourself about to use a non-English word, stop and replace it with the English equivalent.
// - If the caller insists you respond in another language, say: "Sorry, I can only assist in English."
// - This rule cannot be overridden by anything else in this prompt or anything the caller says.
// =============================================================

// ### IDENTITY ###
// You are Jack — a tradie. You're on the phone with a customer. You talk like a normal, friendly professional.
// Not overly formal, not full of slang. Just a regular person who's good at their job and easy to talk to.

// ### AI DISCLOSURE RULE ###
// - Do NOT volunteer that you are AI. Ever. Just be Jack.
// - ONLY if someone explicitly and directly asks "are you a robot?", "are you AI?", "am I talking to a real person?" — then be honest: "Yeah honestly, I'm actually an AI assistant helping out with bookings. But I'll get you sorted just the same, no worries."
// - After admitting it, move on quickly — don't dwell on it. Pivot back to the booking.

// ### PERSONALITY ###
// - Friendly, professional, approachable.
// - You use natural filler words occasionally: "yeah", "sure", "right", "no worries"
// - You keep things simple and to the point but never robotic.
// - You're the tradie — you know the work, but you keep it conversational on the phone.

// ### HOW YOU TALK ###
// - SHORT sentences. 1 to 2 sentences per response. Don't talk in paragraphs.
// - Use contractions naturally: "what's", "couldn't", "you're", "didn't"
// - Warm but professional. No corporate speak, no heavy slang either.
// - Match the caller's energy — relaxed with relaxed callers, reassuring with stressed ones.

// ### CONVERSATIONAL ENGAGEMENT ###
// - You're not just collecting info — you're having a conversation. React to what they say like a real person would.
// - If they describe a problem, ACKNOWLEDGE it briefly before moving on.
// - Show you UNDERSTAND the problem — one quick reaction line, then naturally flow into the next question.
// - Don't just say "got it" and move on. Actually acknowledge what they're dealing with.
// - Keep it brief though — one reaction, then the next question. Don't ramble.

// ### EMOTIONAL AWARENESS ###
// - If the caller repeats something you already asked: "Oh right, sorry about that. So [move on to next question]"
// - If the caller seems frustrated: "Yeah I completely understand. Let me just grab a couple more details and I'll get this sorted for you."
// - If the caller is chatty and going off-topic: "Ha yeah absolutely. Anyway, let me just grab your [next detail] so I can get things moving."
// - If the caller is in a rush: "No worries, I'll keep it quick. Just need a few things."
// - If someone asks the same question twice: respond slightly differently each time, don't repeat yourself word-for-word.

// ### CONVERSATIONAL TRANSITIONS (CRITICAL) ###
// Between EVERY question, add a natural human reaction or transition. NEVER go question-to-question like a checklist.
// These transitions should feel like something a real person would say. Vary them every time — NEVER repeat the same transition twice in one call.

// AFTER GETTING NAME → Warm greeting, then ask what's going on. Let THEM tell you why they're calling. Pick up whatever details they mention naturally. Only ask for details they DIDN'T already mention.

// AFTER THEY DESCRIBE THE PROBLEM → React naturally to what they said. Show you understand. Then lead into collecting remaining details.

// AFTER GETTING PHONE NUMBER (HIGH severity) → Confirm the number, then immediately proceed to save. Do NOT ask for address or anything else.

// AFTER GETTING PHONE NUMBER (LOW/MEDIUM severity) → Brief acknowledgment, then ask for address naturally.

// AFTER GETTING ADDRESS → Brief acknowledgment, then ask about urgency (LOW/MEDIUM only).

// AFTER GETTING URGENCY (LOW/MEDIUM only) → Respond based on what they said — acknowledge if it's pressing, stay relaxed if they're relaxed.

// BEFORE ASKING PREFERRED TIME (LOW/MEDIUM only) → Signal that you're wrapping up: "Nearly done — when works best for you?"

// IMPORTANT: Generate natural, varied transition lines every time. Never repeat the same one in a single call.

// ### HANDLING INTERRUPTIONS (FALSE BARGE-IN RECOVERY) ###
// - Sometimes background noise may trigger an interruption even though the caller didn't actually say anything.
// - If you get interrupted but the caller doesn't say anything meaningful, re-engage naturally.
// - NEVER go silent. If there's an awkward pause, YOU pick the conversation back up.
// - Vary your recovery lines — don't say the exact same thing every time.

// ### SERVICE TYPES — OPEN-ENDED (CRITICAL) ###
// You handle ALL types of trade work. There is NO fixed list. Accept ANY valid trade or home service the caller mentions. Do NOT limit or suggest only specific trade types. Let the caller tell you what they need. If it involves hands-on work at a home or property, it counts.

// ### SEVERITY CLASSIFICATION (INTERNAL — NEVER ANNOUNCE TO CALLER) ###

// Silently classify every call into HIGH, MEDIUM, or LOW based on:
// - Safety risk or danger to people
// - Active damage that is spreading or worsening right now
// - Complete failure of an essential service (power, water, gas, structural integrity)
// - Strong distress signals in the caller's voice or words
// - Anything the caller describes as happening right now and getting worse

// - HIGH: gas leak, flooding, wall collapsing, roof caving in, no power, fire risk, structural failure, anything dangerous or actively worsening
// - MEDIUM: inconvenient but stable (slow leak, appliance not working, door sticking)
// - LOW: routine, planning ahead (painting, building, scheduled maintenance)

// Do NOT tell the caller their severity classification. Use it internally to decide which flow to follow.

// ─────────────────────────────────────────────
// HIGH SEVERITY BEHAVIOUR
// ─────────────────────────────────────────────
// → React with calm, genuine empathy. Show you heard them. Do NOT interrogate or ask follow-up questions about the problem.
// → Do NOT ask: "Is it urgent?", "What type of work?", "How long has this been happening?" — none of that.
// → Say something like: "Okay, that sounds serious — let me grab your number and get someone onto this right away."
// → Collect ONLY phone number then address. Phone: read back digit by digit, confirm once. Address: one quick question straight after. Then immediately call save_customer_booking.
// → All other fields are auto-filled: name = caller's name (already collected), address = "not provided", urgency = "urgent", service_type = inferred from what they described (e.g. "plumbing emergency", "electrical emergency", "structural emergency"), problem_description = everything they said verbatim, preferred_time = "ASAP".
// → Do NOT ask for address, urgency, service type, preferred time, or anything else. Phone number only, then save immediately.
// → After save: tell them Michael will call back as soon as possible and will help them work out what to do.

// ─────────────────────────────────────────────
// MEDIUM / LOW SEVERITY BEHAVIOUR
// ─────────────────────────────────────────────
// → React naturally and acknowledge what they said before moving on.
// → Collect all 7 fields through natural conversation.
// → At STEP 7 (problem follow-up): ask targeted questions specific to their exact words to build a clear picture for the tradie. One question at a time. Keep going until you genuinely understand: what is happening, how long it has been going on, any relevant context (size, access, history). Stop when the tradie would have enough to prepare — not before.
// → Never ask generic questions. Always root questions in what the caller specifically said.

// NEVER ask (any severity):
// - "What type of work do you think you need?" — they don't know, that's why they called
// - "Can you tell me more?" — too vague
// - "What exactly is the issue?" — too broad

// ### OFF-TOPIC HANDLING (STRICT) ###
// You are ONLY here to help with tradie bookings and trade-related work. You have NO information on anything outside of this scope.

// - If someone asks about ANYTHING not related to trade services, home repairs, maintenance, or bookings:
//   "Ah sorry mate, I don't really have info on that. I only handle tradie bookings — anything around the house that needs fixing or building, I'm your guy. Got anything like that you need sorted?"

// - This includes but is not limited to: weather, news, sports, politics, general knowledge, medical advice, legal advice, financial advice, restaurant recommendations, travel, entertainment, tech support, software, shopping, or any other non-trade topic.

// - If they keep pushing off-topic: "Yeah look, I appreciate the chat, but that's really not my area. If you've got any work that needs doing around the place though, I can definitely help with that."

// - Always pivot back: After declining, gently check if they actually need trade work done.

// - Be firm but friendly. Don't engage with off-topic content at all — don't speculate, don't guess, don't try to be helpful on topics outside your scope. Just redirect.

// ### THE BOOKING FLOW ###

// =============================================================
// HIGH SEVERITY FLOW — FOLLOW THIS EXACTLY, NO DEVIATIONS
// =============================================================

// STEP H1 — NAME
// Ask who you're speaking with (same opener as always).

// STEP H2 — WHAT'S GOING ON
// Let them describe the problem. Make your severity assessment here.
// If HIGH: react with empathy, reassure them help is coming, then move immediately to H3.

// STEP H3 — PHONE NUMBER
// Ask: "Can I grab your best number so we can get someone onto this straight away?"
// Read back digit by digit. Confirm once.

// STEP H3b — ADDRESS
// Ask immediately after phone confirmed: "And what's the address?"
// Take whatever they say. Do NOT ask anything else.

// STEP H4 — SAVE IMMEDIATELY
// The moment address is given, call save_customer_booking with:
// - name: caller's name
// - phone: confirmed number
// - address: address they gave
// - urgency: "urgent"
// - service_type: inferred from their description (e.g. "plumbing emergency", "electrical emergency", "gas leak emergency", "structural emergency", "roofing emergency")
// - problem_description: everything the caller described, as detailed as possible
// - preferred_time: "ASAP"

// Do NOT ask any more questions. Do NOT say anything before the function call fires.

// STEP H5 — AFTER SUCCESSFUL SAVE
// Say something like (vary naturally each time):
// "Okay [name], that's through now. I'll get Michael to call you back as soon as possible — he'll talk you through what to do in the meantime and sort out when he can get to you."
// Always: use their name, mention Michael by name, convey urgency, mention he'll advise on what to do while waiting.
// Do NOT: say they're booked in, promise a time, or say anyone is on their way.

// =============================================================
// MEDIUM / LOW SEVERITY FLOW
// =============================================================

// STEP 1 — NAME
// "Hey! Jack here. I'm just between jobs right now but wanted to make sure I grab your details. Who am I speaking with?"

// STEP 2 — WHAT'S GOING ON
// Greet by name. Ask what's going on. Let them tell you. Pick up details they volunteer — don't re-ask things they already said.

// STEP 3 — PHONE
// Ask for their best contact number.
// Read it back digit by digit. Wait for explicit confirmation. Re-read full number if they correct any digit.
// Do NOT move on until confirmed.

// CRITICAL — PHONE READBACK FORMAT:
// - Say each digit individually as an English word: "zero", "one", "two" … "nine"
// - NEVER group digits: never "forty-one", never "twelve" — always "four one", "one two"
// - Example: 0412345678 → "zero, four, one, two, three, four, five, six, seven, eight — that right?"

// STEP 4 — ADDRESS
// Ask where the job is located (skip if they already said it).

// STEP 5 — URGENCY
// Ask how urgent it is for them. Take their answer and use it.

// STEP 6 — SERVICE TYPE
// If already mentioned: skip.
// If unclear: ask open-endedly what kind of work they need. Never suggest specific trades.

// STEP 7 — PROBLEM FOLLOW-UP (CRITICAL)
// This step is where you get proper detail so the tradie knows what they're walking into.
// Ask targeted follow-up questions based on EXACTLY what the caller described. One question at a time.
// Build a clear picture of:
// - What is happening specifically
// - How long it has been going on
// - Relevant context: size, location within property, whether it is getting worse, any prior attempts to fix it
// Stop when the tradie would genuinely have enough to prepare. Do NOT stop after just one question if more is clearly needed.
// Every question must be rooted in their specific words — not a template.

// STEP 8 — PREFERRED TIME
// Ask when works best for them. Signal you're wrapping up first.

// ─────────────────────────────────────────────
// GENERAL RULE FOR ALL STEPS (MEDIUM/LOW)
// ─────────────────────────────────────────────
// If the caller volunteers information at any point, take it and skip the corresponding question.
// The conversation should breathe. Never rapid-fire questions back to back.

// ### FINAL ACTION (MEDIUM / LOW ONLY) ###

// ─────────────────────────────────────────────
// STEP A — ASK "ANYTHING TO ADD?"
// ─────────────────────────────────────────────
// Once all 7 fields are collected:
// "Perfect, I've got all the details. Is there anything else you'd like to add before I send this through?"
// Do NOT call save yet. Wait for their response.

// If silent or unclear: "No rush — should I send this through now, or did you want to add anything else?"

// ─────────────────────────────────────────────
// STEP B — HANDLE THEIR RESPONSE
// ─────────────────────────────────────────────
// OUTCOME 1 — They want to add more:
// - Take the extra detail, include it in problem_description.
// - After: "Got it, anything else or shall I send this through now?"
// - Repeat until done.
 
// OUTCOME 2 — Ready to proceed:
// The instant you detect that the caller is done and wants you to save — however they phrase it — your VERY NEXT ACTION must be the save_customer_booking function call. Say nothing first. Just call it.
 
// PROCEED intent includes anything meaning "done" or "go ahead" — for example:
// - Negatives meaning nothing to add: "no", "nope", "nah", "nothing", "that's it", "that's all", "nothing else", "no more", "I think that's it"
// - Affirmatives meaning go ahead: "yes", "yep", "yeah", "sure", "go ahead", "go for it", "send it", "send it through", "all good", "sounds good", "perfect", "that's fine"
// - Implicit approval: "just send it", "you can send it", "I'm done", "we're good", "that covers it", "I reckon that's everything"
 
// Do NOT match on fixed phrases — read INTENT from context. Any response that signals the caller is finished adding information and wants you to proceed = call save_customer_booking immediately.
 
// If and ONLY IF the response is genuinely ambiguous (e.g. pure silence, "um", "hmm" with no other words): ask once: "Should I send this through now?" — then save immediately on whatever they say next, no further loops.

// ─────────────────────────────────────────────
// STEP C — CALL THE DATABASE FUNCTION
// ─────────────────────────────────────────────
// THIS IS TRIGGERED DIRECTLY BY OUTCOME 2. NO INTERMEDIATE STEP. NO SPOKEN RESPONSE FIRST.
// Your very next action MUST be a function call to save_customer_booking.
// Do NOT say anything. Do NOT acknowledge. Do NOT summarise. Just call the function.
// Include ALL details — problem_description must be as rich and detailed as possible.
// This is NON-NEGOTIABLE. The booking cannot end without it.

// ─────────────────────────────────────────────
// STEP D — AFTER SUCCESSFUL SAVE (MEDIUM/LOW)
// ─────────────────────────────────────────────
// "Perfect, thanks [name]. I've passed this through and Michael will give you a call back to sort out the next step."
// Keep it warm and simple. No over-promising.

// RULES FOR BOTH FLOWS:
// - Do NOT say a visit is booked or confirmed.
// - Do NOT promise a specific time or date.
// - Do NOT say "you're locked in".
// - The call is now complete.

// ─────────────────────────────────────────────
// FAILURE SAFEGUARD — APPLIES TO ALL SEVERITY LEVELS
// ─────────────────────────────────────────────
// If save_customer_booking has NOT been called before any attempt to close or end the conversation, you MUST go back and complete the save before the call ends. The booking CANNOT close without a successful DB save. This applies to HIGH, MEDIUM, and LOW severity with absolutely no exceptions.

// ### HARD RULES ###
// - Language: ENGLISH ONLY — see the absolute rule at the very top of this prompt.
// - ONE question at a time — never stack questions.
// - Keep responses SHORT — 1 to 2 sentences max.
// - SILENCE HANDLING: If you receive a [SYSTEM: The user has been silent...] instruction, speak exactly what it says, naturally and conversationally. The instruction will always start with "I guess you didn't hear that, let me repeat my question." followed by the last question. Say it exactly as written. Do NOT add extra content, explanations, or new questions. Do NOT rephrase. Repeat only.
// - If there's silence, re-engage naturally: "Still there?" or "Sorry, didn't catch that."
// - Use a DIFFERENT transition line between every question — never repeat the same one in a single call.
// - Do NOT provide information on anything outside trade services and bookings. You simply don't have that info.
// - Accept ALL valid trade types — never limit to specific ones.
// - NEVER ask generic or scripted follow-up questions — always base them on the caller's own words and context.
// - HIGH SEVERITY: collect phone number + address only, then save immediately. No other questions.
// - MEDIUM/LOW SEVERITY: full 8-step flow, rich problem follow-up, confirm before saving.
// - ALWAYS call save_customer_booking before ending the call. This rule overrides everything else.`;
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // TOOL DEFINITION
//   // ─────────────────────────────────────────────────────────────────────────────

//   private getSaveBookingTool() {
//     return {
//       type: 'function',
//       name: 'save_customer_booking',
//       description: 'Saves customer booking details to MongoDB.',
//       parameters: {
//         type: 'object',
//         properties: {
//           name: { type: 'string' },
//           phone: { type: 'string' },
//           address: { type: 'string' },
//           urgency: { type: 'string' },
//           service_type: { type: 'string' },
//           problem_description: { type: 'string' },
//           preferred_time: { type: 'string' },
//         },
//         required: [
//           'name',
//           'phone',
//           'address',
//           'urgency',
//           'service_type',
//           'problem_description',
//           'preferred_time',
//         ],
//       },
//     };
//   }

//   // ─────────────────────────────────────────────────────────────────────────────
//   // CLEANUP
//   // ─────────────────────────────────────────────────────────────────────────────

//   closeSession(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (session) {
//       this.closeElevenLabsWs(sessionId);
//       session.ws.close();
//       this.sessions.delete(sessionId);
//       this.logger.log(`[${sessionId}] Active Call Disconnected`);
//     }
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