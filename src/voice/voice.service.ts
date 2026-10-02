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
import { LEMANS_SYSTEM_PROMPT } from './lemans-knowledge';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EventType =
  | 'kids_party'
  | 'teen_party'
  | 'buck_party'
  | 'corporate'
  | 'adult_party'
  | 'karts'
  | 'vr'
  | 'activities'
  | 'booking_change'
  | 'complaint'
  | 'after_hours'
  | 'school_group'
  | 'emergency'
  | 'general_enquiry'
  | 'unknown';

interface RealtimeSession {
  ws: WebSocket;
  onEvent: (event: any) => void;
  sessionStartedAtMs: number;
  greetingTriggeredAtMs: number | null;
  outputAudioTimer: ReturnType<typeof setTimeout> | null;
  firstAudioDeltaLogged: boolean;
  silenceRepromptCount: number;
  callerNumber: string;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  callerTranscript: string;
  lastInputTranscriptAtMs: number;
  savedLead: boolean;
}

// Transfer number map — populated from env matching Transfer rules destination names
const TRANSFER_NUMBERS: Record<EventType, string | null> = {
  emergency: process.env.TRANSFER_EMERGENCY ?? process.env.TRANSFER_DUTY_MANAGER ?? null,
  kids_party: process.env.TRANSFER_KIDS_PARTY ?? process.env.TRANSFER_RESERVATIONS ?? null,
  teen_party: process.env.TRANSFER_TEEN_PARTY ?? process.env.TRANSFER_RESERVATIONS ?? null,
  buck_party: process.env.TRANSFER_BUCK_PARTY ?? process.env.TRANSFER_RESERVATIONS ?? null,
  corporate: process.env.TRANSFER_CORPORATE ?? process.env.TRANSFER_CORPORATE_SALES ?? null,
  adult_party: process.env.TRANSFER_ADULT_PARTY ?? process.env.TRANSFER_RESERVATIONS ?? null,
  karts: process.env.TRANSFER_KARTS ?? process.env.TRANSFER_TRACK ?? process.env.TRANSFER_RESERVATIONS ?? null,
  vr: process.env.TRANSFER_VR ?? process.env.TRANSFER_RESERVATIONS ?? null,
  activities: process.env.TRANSFER_ACTIVITIES ?? process.env.TRANSFER_RESERVATIONS ?? null,
  booking_change: process.env.TRANSFER_BOOKING_CHANGE ?? process.env.TRANSFER_RESERVATIONS ?? null,
  complaint: process.env.TRANSFER_COMPLAINT ?? process.env.TRANSFER_DUTY_MANAGER ?? null,
  after_hours: null,
  school_group: process.env.TRANSFER_SCHOOL_GROUP ?? process.env.TRANSFER_RESERVATIONS ?? null,
  general_enquiry: process.env.TRANSFER_GENERAL ?? process.env.TRANSFER_RESERVATIONS ?? null,
  unknown: process.env.TRANSFER_GENERAL ?? process.env.TRANSFER_RESERVATIONS ?? null,
};

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);
  private sessions = new Map<string, RealtimeSession>();
  private readonly MAX_SILENCE_REPROMPTS = 2;
  private readonly TOOL_TIMEOUT_MS = 10_000;

  constructor(
    private readonly config: ConfigService,
    @InjectModel(Lead.name)
    private readonly leadModel: Model<LeadDocument>,
    private readonly activeCampaign: ActiveCampaignService,
  ) { }

  // ─── Silence handling ────────────────────────────────────────────────────────

  handleSilenceTimeout(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;


    session.silenceRepromptCount += 1;

    if (session.silenceRepromptCount > this.MAX_SILENCE_REPROMPTS) {
      this.logger.log(`[${sessionId}] Max silence re-prompts reached — closing politely`);
      this._injectAndRespond(
        sessionId,
        "It seems like you might have stepped away. No worries at all — feel free to call back whenever you're ready. Thanks for contacting Le Mans Entertainment, take care!",
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


    const SILENCE_TIMEOUT_MS = 8_000;
    session.silenceTimer = setTimeout(() => {
      this.handleSilenceTimeout(sessionId);
    }, SILENCE_TIMEOUT_MS);

    this.logger.debug(`[${sessionId}] Silence countdown started (${SILENCE_TIMEOUT_MS}ms)`);
  }

  private _buildSilenceReprompt(session: RealtimeSession): string {
    if (session.silenceRepromptCount === 1) {
      return "Hey there, just checking if you're still with me! I'm happy to help with any questions about our tracks, karts, or booking.";
    }
    return "Are you still there? Let me know if you'd like me to grab your details so one of our team can give you a call back.";
  }

  private _injectAndRespond(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.ws.readyState !== WebSocket.OPEN) return;


    session.ws.send(JSON.stringify({
      type: 'session.instructions.append',
      delegation_id: null,
      content: `The caller has been quiet. Re-engage warmly by saying: ${text}`,
    }));
  }

  // ─── Create session ──────────────────────────────────────────────────────────

  async createRealtimeSession(
    sessionId: string,
    onEvent: (event: any) => void,
    callerNumber = 'unknown',
  ): Promise<void> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    const model = 'gpt-live-1';
    const url = 'wss://api.openai.com/v1/live/sessions';
    const sessionStartedAtMs = Date.now();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      this.instrumentHandshake(sessionId, 'GPT-Live', ws, sessionStartedAtMs);

      ws.on('open', () => {
        this.logger.log(`[${sessionId}] GPT-Live WebSocket connected in ${Date.now() - sessionStartedAtMs}ms`);

        ws.send(
          JSON.stringify({
            type: 'session.start',
            session: {
              model,
              instructions: `${this.getSystemPrompt()}\n\nGPT-Live conversation guidance: Speak warmly and concisely in a natural Australian voice. Ask one clear question at a time. For callback, booking, complaint, or other staff follow-up requests, collect the caller’s name and request details, then delegate the task to the application to save the enquiry.`,
              audio: {
                format: { type: 'audio/pcm', rate: 24000 },
                output: { voice: this.config.get<string>('OPENAI_LIVE_VOICE') ?? 'quartz' },
              },
              delegation: { type: 'client' },
            },
          }),
        );

        this.sessions.set(sessionId, {
          ws,
          onEvent,
          sessionStartedAtMs,
          greetingTriggeredAtMs: null,
          firstAudioDeltaLogged: false,
          outputAudioTimer: null,
          silenceRepromptCount: 0,
          callerNumber,
          silenceTimer: null,
          callerTranscript: '',
          lastInputTranscriptAtMs: 0,
          savedLead: false,
        });

      });

      ws.on('message', async (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(data.toString());
          if (event.type === 'session.started') resolve();
          if (event.type === 'session.delegation.created') {
            await this.handleClientDelegation(sessionId, event.delegation?.id);
          }
          await this.handleRealtimeEvent(sessionId, event);
        } catch (err) {
          this.logger.error(`[${sessionId}] Failed to parse event:`, err);
        }
      });

      ws.on('error', (err) => {
        this.logger.error(`[${sessionId}] GPT-Live WS error:`, err);
        onEvent({ type: 'realtime-error', error: { message: err.message } });
        reject(err);
      });

      ws.on('close', (code, reason) => {
        this.logger.log(`[${sessionId}] GPT-Live WS closed: ${code} - ${reason}`);
        const closedSession = this.sessions.get(sessionId);
        if (closedSession?.outputAudioTimer) clearTimeout(closedSession.outputAudioTimer);
        this.sessions.delete(sessionId);
        onEvent({ type: 'session-closed' });
      });
    });
  }

  // ─── Send audio ──────────────────────────────────────────────────────────────

  sendAudio(sessionId: string, base64Audio: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.ws.send(JSON.stringify({ type: 'session.input_audio.append', audio: base64Audio }));
  }

  // ─── Trigger greeting ────────────────────────────────────────────────────────

  triggerGreeting(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.greetingTriggeredAtMs = Date.now();
    session.ws.send(JSON.stringify({ type: 'session.instructions.append', delegation_id: null, content: 'Greet the caller now in English as Chloe from LeMans Entertainment. Welcome them warmly, introduce yourself, ask how you can help, then pause and listen.' }));
  }

  // ─── Event hub ───────────────────────────────────────────────────────────────

  private async handleRealtimeEvent(sessionId: string, event: any): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    switch (event.type) {
      case 'session.started':
        this.logger.log(`[${sessionId}] GPT-Live session started`);
        break;
      case 'session.output_audio.delta':
        if (!session.firstAudioDeltaLogged) {
          session.firstAudioDeltaLogged = true;
          this.logger.log(`[${sessionId}] First audio at ${Date.now() - session.sessionStartedAtMs}ms`);
        }
        session.onEvent({ type: 'audio-delta', delta: event.delta });
        if (session.outputAudioTimer) clearTimeout(session.outputAudioTimer);
        session.outputAudioTimer = setTimeout(() => {
          session.outputAudioTimer = null;
          session.onEvent({ type: 'audio-done' });
        }, 350);
        break;
      case 'session.output_transcript.delta':
        session.onEvent({ type: 'transcript-delta', delta: event.delta });
        break;
      case 'session.input_transcript.delta':
        if (Date.now() - session.lastInputTranscriptAtMs > 1500) {
          session.onEvent({ type: 'user-transcript-reset' });
        }
        session.lastInputTranscriptAtMs = Date.now();
        session.callerTranscript += event.delta ?? '';
        session.silenceRepromptCount = 0;
        if (session.silenceTimer) {
          clearTimeout(session.silenceTimer);
          session.silenceTimer = null;
        }
        if (session.outputAudioTimer) {
          clearTimeout(session.outputAudioTimer);
          session.outputAudioTimer = null;
          session.onEvent({ type: 'speech-started' });
        }
        session.onEvent({ type: 'user-transcript-delta', delta: event.delta });
        break;
      case 'session.instructions.appended':
        break;
      case 'response.event':
        break;
      case 'session.delegation.created':
        session.onEvent({ type: 'delegation-created', delegation: event.delegation });
        break;
      case 'session.closed':
        session.onEvent({ type: 'audio-done' });
        break;
      case 'error':
        this.logger.error(`[${sessionId}] GPT-Live error: ${JSON.stringify(event.error)}`);
        session.onEvent({ type: 'realtime-error', error: event.error });
        break;
      default:
        this.logger.debug(`[${sessionId}] Unhandled GPT-Live event: ${event.type}`);
    }
  }

  // ─── save_lead ───────────────────────────────────────────────────────────────

  private async handleSaveLead(sessionId: string, args: any, delegationId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Corporate callers with > 40 people are assigned to Skye in ActiveCampaign
    const groupSize: number | null = args.group_size ?? null;
    const isCorporateLarge =
      args.event_type === 'corporate' &&
      groupSize !== null &&
      groupSize > 40;
    const assignedTo: string = isCorporateLarge ? 'Skye' : 'LeMans Inquiries';

    this.logger.log(
      `[${sessionId}] Saving lead — caller: ${args.caller_name} | type: ${args.event_type} | assigned: ${assignedTo}`,
    );

    const lead = await this.withToolTimeout(
      this.leadModel.create({
        callerName: args.caller_name,
        callerNumber: args.caller_number || session.callerNumber,
        callerEmail: args.caller_email,
        eventType: args.event_type,
        eventDate: args.event_date,
        groupSize: args.group_size,
        enquiryDetails: args.enquiry_details,
        assignedTo,
        callId: sessionId,
        source: 'voice_agent',
      }),
      'database_save',
    );

    this.logger.log(`[${sessionId}] Lead saved: ${lead._id} (assigned to ${assignedTo})`);

    // ── Push to ActiveCampaign ───────────────────────────────────────────────
    const tagMap: Record<string, string> = {
      kids_party: 'KidsParty',
      teen_party: 'TeenParty',
      buck_party: 'BucksHens',
      corporate: 'Corporate',
      adult_party: 'AdultParty',
      karts: 'Karts',
      vr: 'VR',
      activities: 'Activities',
      booking_change: 'BookingChange',
      complaint: 'Complaint',
      after_hours: 'AfterHours',
      school_group: 'SchoolGroup',
      emergency: 'Emergency',
      general_enquiry: 'GeneralEnquiry',
      unknown: 'Unknown',
    };
    const activeCampaignTag = tagMap[args.event_type] || args.event_type;

    this.logger.log(`[${sessionId}] CRM sync started delegation_id=${delegationId}`);
    void this.activeCampaign.createContact({
      firstName: args.caller_name,
      phone: args.caller_number || session.callerNumber,
      email: args.caller_email,
      tag: activeCampaignTag,
      fieldValues: [
        { field: 'EVENT_TYPE', value: args.event_type ?? '' },
        { field: 'EVENT_DATE', value: args.event_date ?? '' },
        { field: 'GROUP_SIZE', value: String(args.group_size ?? '') },
        { field: 'ENQUIRY', value: args.enquiry_details ?? '' },
        { field: 'ASSIGNED_TO', value: assignedTo },
      ],
    }).then(() => {
      this.logger.log(`[${sessionId}] CRM sync completed delegation_id=${delegationId}`);
    }).catch((err) => {
      this.logger.warn(`[${sessionId}] CRM sync failed delegation_id=${delegationId} reason=${err instanceof Error ? err.name : 'unknown'}`);
    });

    const commentaryContent = isCorporateLarge
      ? `I've passed your details straight to Skye. She'll give you a call back personally to plan everything.`
      : args.event_type === 'emergency'
        ? `I've logged the emergency incident immediately for management. Please go straight to the nearest staff member or Track Marshall on site immediately, or call Triple Zero (000) right away if anyone is in danger or needs urgent medical attention.`
        : args.event_type === 'complaint'
          ? `I've logged your complaint for our duty manager. A manager will review your details and contact you directly.`
          : args.event_type === 'after_hours'
            ? `The details have been recorded. Our reservations team will give you a call back first thing after 9am.`
            : `All noted. Someone from the team will give you a call back to go through everything with you.`;

    session.ws.send(JSON.stringify({
      type: 'session.commentary.append',
      delegation_id: delegationId,
      content: commentaryContent,
    }));
    session.onEvent({ type: 'lead-saved', data: { ...args, assignedTo } });
  }

  private async handleClientDelegation(sessionId: string, delegationId?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !delegationId) return;
    if (session.savedLead) {
      this.logger.warn(`[${sessionId}] Duplicate delegation ignored delegation_id=${delegationId}`);
      return;
    }

    const startedAt = Date.now();
    this.logger.log(`[${sessionId}] Tool call started name=client_delegation delegation_id=${delegationId}`);

    const transcript = session.callerTranscript.trim();
    const lower = transcript.toLowerCase();
    const hasContactOrName =
      /\b(?:my name is|name is|name's|i am|i'm|this is|it's|it is|call me)\s+[a-z]/i.test(transcript) ||
      /\b(?:\+?61|0)[\s()\d-]{8,14}\d\b/.test(transcript);
    const wantsFollowUp =
      hasContactOrName ||
      /call me back|callback|call back|contact me|speak to|talk to|book(ing)?|quote|complaint|reschedule|change|party|bucks|hens|stag|birthday|corporate|company|team building|function|kart|race|track|vr|zero latency|laser|golf|arcade|school|excursion|after hours|hold|deposit|reserve|reservation|manager|refund|late|date|price|cost|how much|emergency|injury/i.test(lower);
    if (!wantsFollowUp) {
      this.logger.log(`[${sessionId}] Tool call completed name=client_delegation delegation_id=${delegationId} result=no_follow_up duration_ms=${Date.now() - startedAt}`);
      session.ws.send(JSON.stringify({
        type: 'session.thinking.append', delegation_id: delegationId,
        content: 'No staff follow-up or lead record is needed for this request.',
      }));
      return;
    }

    const nameMatch = transcript.match(/\b(?:my name is|name is|name's|i am|i'm|this is|it's|it is|call me)\s+([a-z][a-z' -]{1,50})/i);
    let callerName = nameMatch?.[1]?.split(/[,.;!?]|\b(?:and|i|we|my|i'd|i would|phone|number|mobile|email)\b/i)[0]?.trim();
    if (!callerName) {
      const suffixMatch = transcript.match(/\b([a-z][a-z' -]{1,30})\s+(?:here|speaking)\b/i);
      callerName = suffixMatch?.[1]?.trim();
    }
    if (!callerName) {
      this.logger.warn(`[${sessionId}] Tool call needs caller name delegation_id=${delegationId} duration_ms=${Date.now() - startedAt}`);
      session.ws.send(JSON.stringify({
        type: 'session.commentary.append', delegation_id: delegationId,
        content: 'Please ask the caller for their name so the team can follow up, then delegate again once they have answered.',
      }));
      return;
    }

    const eventType: EventType =
      lower.includes('emergency') || lower.includes('injury') || lower.includes('injured') || lower.includes('accident') ? 'emergency'
        : lower.includes('corporate') || lower.includes('company') || lower.includes('team building') || lower.includes('christmas party') ? 'corporate'
          : lower.includes('school') || lower.includes('excursion') ? 'school_group'
            : lower.includes('complaint') || lower.includes('unhappy') || lower.includes('refund') ? 'complaint'
              : lower.includes('reschedule') || lower.includes('running late') || lower.includes('change') || lower.includes('booking') ? 'booking_change'
                : lower.includes('teen') ? 'teen_party'
                  : lower.includes('kid') || lower.includes('child') || (lower.includes('birthday') && !lower.includes('18th') && !lower.includes('21st') && !lower.includes('adult')) ? 'kids_party'
                    : lower.includes('buck') || lower.includes('hens') || lower.includes('stag') ? 'buck_party'
                      : lower.includes('adult') || lower.includes('18th') || lower.includes('21st') || lower.includes('social group') ? 'adult_party'
                        : lower.includes('kart') || lower.includes('race') || lower.includes('super kart') || lower.includes('sprint') ? 'karts'
                          : lower.includes('vr') || lower.includes('zero latency') ? 'vr'
                            : lower.includes('laser') || lower.includes('golf') || lower.includes('arcade') ? 'activities'
                              : lower.includes('after hours') || lower.includes('closed') ? 'after_hours'
                                : 'general_enquiry';

    const email = transcript.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
    const phone = transcript.match(/\b(?:\+?61|0)[\s()\d-]{8,14}\d\b/)?.[0]?.replace(/[\s()-]/g, '');
    if ((!phone && session.callerNumber === 'unknown')) {
      this.logger.warn(`[${sessionId}] Tool call needs callback number delegation_id=${delegationId} duration_ms=${Date.now() - startedAt}`);
      session.ws.send(JSON.stringify({
        type: 'session.commentary.append', delegation_id: delegationId,
        content: 'Please ask the caller for a callback phone number, then delegate again once they have answered.',
      }));
      return;
    }
    const groupSize = Number(transcript.match(/\b(\d{1,3})\s+(?:people|guests|kids|children|attendees|drivers|racers|players|guys|girls)\b/i)?.[1]) || undefined;
    const eventDate = transcript.match(/\b(?:on|for|around|this|next)\s+((?:next\s+)?(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?\w+|\w+\s+\d{1,2}(?:st|nd|rd|th)?|weekend))\b/i)?.[1];
    const details = transcript.slice(-1600);

    session.savedLead = true;
    try {
      await this.handleSaveLead(sessionId, {
        caller_name: callerName,
        caller_number: session.callerNumber !== 'unknown' ? session.callerNumber : phone,
        caller_email: email,
        event_type: eventType,
        event_date: eventDate,
        group_size: groupSize,
        enquiry_details: details,
      }, delegationId);
      this.logger.log(`[${sessionId}] Tool call completed name=client_delegation delegation_id=${delegationId} duration_ms=${Date.now() - startedAt}`);
    } catch (error) {
      session.savedLead = false;
      const timedOut = error instanceof Error && error.message.includes('timed out');
      this.logger.error(`[${sessionId}] Tool call ${timedOut ? 'timed out' : 'failed'} name=client_delegation delegation_id=${delegationId} duration_ms=${Date.now() - startedAt}`);
      session.ws.send(JSON.stringify({
        type: 'session.commentary.append', delegation_id: delegationId,
        content: 'I could not save the enquiry just now. Apologize briefly and offer the caller the reservations phone number, (03) 8787 8741.',
      }));
    }
  }

  public async handleExternalDelegation(params: {
    callId: string;
    callerNumber?: string;
    callerTranscript: string;
    delegationId: string;
    sendCommentary: (content: string) => void;
    sendThinking?: (content: string) => void;
  }): Promise<void> {
    const { callId, callerNumber = 'unknown', callerTranscript, delegationId, sendCommentary, sendThinking } = params;
    const startedAt = Date.now();
    this.logger.log(`[${callId}] Tool call started name=client_delegation delegation_id=${delegationId}`);

    const transcript = callerTranscript.trim();
    const lower = transcript.toLowerCase();
    const hasContactOrName =
      /\b(?:my name is|name is|name's|i am|i'm|this is|it's|it is|call me)\s+[a-z]/i.test(transcript) ||
      /\b(?:\+?61|0)[\s()\d-]{8,14}\d\b/.test(transcript);
    const wantsFollowUp =
      hasContactOrName ||
      /call me back|callback|call back|contact me|speak to|talk to|book(ing)?|quote|complaint|reschedule|change|party|bucks|hens|stag|birthday|corporate|company|team building|function|kart|race|track|vr|zero latency|laser|golf|arcade|school|excursion|after hours|hold|deposit|reserve|reservation|manager|refund|late|date|price|cost|how much|emergency|injury/i.test(lower);
    if (!wantsFollowUp) {
      this.logger.log(`[${callId}] Tool call completed name=client_delegation delegation_id=${delegationId} result=no_follow_up duration_ms=${Date.now() - startedAt}`);
      if (sendThinking) sendThinking('No staff follow-up or lead record is needed for this request.');
      return;
    }

    const nameMatch = transcript.match(/\b(?:my name is|name is|name's|i am|i'm|this is|it's|it is|call me)\s+([a-z][a-z' -]{1,50})/i);
    let callerName = nameMatch?.[1]?.split(/[,.;!?]|\b(?:and|i|we|my|i'd|i would|phone|number|mobile|email)\b/i)[0]?.trim();
    if (!callerName) {
      const suffixMatch = transcript.match(/\b([a-z][a-z' -]{1,30})\s+(?:here|speaking)\b/i);
      callerName = suffixMatch?.[1]?.trim();
    }
    if (!callerName) {
      this.logger.warn(`[${callId}] Tool call needs caller name delegation_id=${delegationId} duration_ms=${Date.now() - startedAt}`);
      sendCommentary('Please ask the caller for their name so the team can follow up, then delegate again once they have answered.');
      return;
    }

    const eventType: EventType =
      lower.includes('emergency') || lower.includes('injury') || lower.includes('injured') || lower.includes('accident') ? 'emergency'
        : lower.includes('corporate') || lower.includes('company') || lower.includes('team building') || lower.includes('christmas party') ? 'corporate'
          : lower.includes('school') || lower.includes('excursion') ? 'school_group'
            : lower.includes('complaint') || lower.includes('unhappy') || lower.includes('refund') ? 'complaint'
              : lower.includes('reschedule') || lower.includes('running late') || lower.includes('change') || lower.includes('booking') ? 'booking_change'
                : lower.includes('teen') ? 'teen_party'
                  : lower.includes('kid') || lower.includes('child') || (lower.includes('birthday') && !lower.includes('18th') && !lower.includes('21st') && !lower.includes('adult')) ? 'kids_party'
                    : lower.includes('buck') || lower.includes('hens') || lower.includes('stag') ? 'buck_party'
                      : lower.includes('adult') || lower.includes('18th') || lower.includes('21st') || lower.includes('social group') ? 'adult_party'
                        : lower.includes('kart') || lower.includes('race') || lower.includes('super kart') || lower.includes('sprint') ? 'karts'
                          : lower.includes('vr') || lower.includes('zero latency') ? 'vr'
                            : lower.includes('laser') || lower.includes('golf') || lower.includes('arcade') ? 'activities'
                              : lower.includes('after hours') || lower.includes('closed') ? 'after_hours'
                                : 'general_enquiry';

    const email = transcript.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
    const phone = transcript.match(/\b(?:\+?61|0)[\s()\d-]{8,14}\d\b/)?.[0]?.replace(/[\s()-]/g, '');
    if (!phone && callerNumber === 'unknown') {
      this.logger.warn(`[${callId}] Tool call needs callback number delegation_id=${delegationId} duration_ms=${Date.now() - startedAt}`);
      sendCommentary('Please ask the caller for a callback phone number, then delegate again once they have answered.');
      return;
    }

    const groupSize = Number(transcript.match(/\b(\d{1,3})\s+(?:people|guests|kids|children|attendees|drivers|racers|players|guys|girls)\b/i)?.[1]) || undefined;
    const eventDate = transcript.match(/\b(?:on|for|around|this|next)\s+((?:next\s+)?(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?\w+|\w+\s+\d{1,2}(?:st|nd|rd|th)?|weekend))\b/i)?.[1];
    const details = transcript.slice(-1600);

    const isCorporateLarge = eventType === 'corporate' && groupSize !== undefined && groupSize > 40;
    const assignedTo = isCorporateLarge ? 'Skye' : 'LeMans Inquiries';

    try {
      await this.withToolTimeout(
        this.leadModel.create({
          callerName,
          callerNumber: callerNumber !== 'unknown' ? callerNumber : phone,
          callerEmail: email,
          eventType,
          eventDate,
          groupSize,
          enquiryDetails: details,
          assignedTo,
          callId,
          source: 'voice_agent',
        }),
        'database_save',
      );

      const tagMap: Record<string, string> = {
        kids_party: 'KidsParty',
        teen_party: 'TeenParty',
        buck_party: 'BucksHens',
        corporate: 'Corporate',
        adult_party: 'AdultParty',
        karts: 'Karts',
        vr: 'VR',
        activities: 'Activities',
        booking_change: 'BookingChange',
        complaint: 'Complaint',
        after_hours: 'AfterHours',
        school_group: 'SchoolGroup',
        emergency: 'Emergency',
        general_enquiry: 'GeneralEnquiry',
        unknown: 'Unknown',
      };
      const activeCampaignTag = tagMap[eventType] || eventType;

      void this.activeCampaign.createContact({
        firstName: callerName,
        phone: callerNumber !== 'unknown' ? callerNumber : phone,
        email,
        tag: activeCampaignTag,
        fieldValues: [
          { field: 'EVENT_TYPE', value: eventType ?? '' },
          { field: 'EVENT_DATE', value: eventDate ?? '' },
          { field: 'GROUP_SIZE', value: String(groupSize ?? '') },
          { field: 'ENQUIRY', value: details ?? '' },
          { field: 'ASSIGNED_TO', value: assignedTo },
        ],
      }).catch((err) => {
        this.logger.warn(`[${callId}] CRM sync failed delegation_id=${delegationId} reason=${err instanceof Error ? err.name : 'unknown'}`);
      });

      const commentaryContent = isCorporateLarge
        ? `I've passed your details straight to Skye. She'll give you a call back personally to plan everything.`
        : eventType === 'emergency'
          ? `I've logged the emergency incident immediately for management. Please go straight to the nearest staff member or Track Marshall on site immediately, or call Triple Zero (000) right away if anyone is in danger or needs urgent medical attention.`
          : eventType === 'complaint'
            ? `I've logged your complaint for our duty manager. A manager will review your details and contact you directly.`
            : eventType === 'after_hours'
              ? `The details have been recorded. Our reservations team will give you a call back first thing after 9am.`
              : `All noted. Someone from the team will give you a call back to go through everything with you.`;


      sendCommentary(commentaryContent);
      this.logger.log(`[${callId}] Tool call completed name=client_delegation delegation_id=${delegationId} duration_ms=${Date.now() - startedAt}`);
    } catch (error) {
      const timedOut = error instanceof Error && error.message.includes('timed out');
      this.logger.error(`[${callId}] Tool call ${timedOut ? 'timed out' : 'failed'} name=client_delegation delegation_id=${delegationId} duration_ms=${Date.now() - startedAt}`);
      sendCommentary('I could not save the enquiry just now. Apologize briefly and offer the caller the reservations phone number, (03) 8787 8741.');
    }
  }

  private async withToolTimeout<T>(operation: Promise<T>, operationName: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${operationName} timed out`)), this.TOOL_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────────

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.outputAudioTimer) clearTimeout(session.outputAudioTimer);
      if (session.silenceTimer) clearTimeout(session.silenceTimer);
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
    provider: 'GPT-Live',
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

  // ─── System prompt & tools ───────────────────────────────────────────────────

  public getSystemPrompt(): string {
    return LEMANS_SYSTEM_PROMPT;
  }

}
