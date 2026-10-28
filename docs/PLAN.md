# LeMans Voice Agent — Build Plan

## Architecture (decided 2026-10-26)

```
Caller ─PSTN─▶ Bicom PBXware ──SIP trunk──▶ LiveKit SIP ─┐          (phase 2)
Browser demo (React) ──WebRTC──────────────▶ LiveKit Server (room per call)
                                                          │
                     Agent worker (Node, @livekit/agents) ◀┘
                       STT  Deepgram nova-3 (en-AU)
                       LLM  OpenAI gpt-4.1-mini (knowledge base in system prompt, cached)
                       TTS  ElevenLabs Flash v2.5
                       VAD  Silero (local) · turn detector v1-mini (local)
                       tools: save_lead · transfer_call · end_call
                                                          │ HTTP (shared secret)
Express API ◀─────────────────────────────────────────────┘
  /api/token            browser joins a room, agent dispatched by name
  /api/monitor/stream   SSE live feed of every call (monitor page)
  /internal/events      agent → API call events
  MongoDB               calls, transcripts, leads
```

Why LiveKit Agents (Node): official Node SDK with OpenAI, Deepgram and ElevenLabs plugins, turn
detection, interruption handling, SIP and transfers built in. Replaces the old Asterisk ARI + RTP
bridge, whose hand-written audio handling was the main source of bugs.

## Measured (laptop in Pakistan, local LiveKit, 2026-10-26)

| | Cascade (default) | Realtime |
|---|---|---|
| Caller stops → Chloe speaks | 1.4 – 2.3 s | 0.45 – 1.2 s |
| Breakdown (cascade) | end-of-turn wait ~0.55 s, OpenAI first token 0.7 – 1.5 s, ElevenLabs first audio ~0.3 s | — |
| Voice | ElevenLabs (Chloe) | OpenAI `marin` |
| Behaviour tests | 7/7 | not run (text tests use the cascade LLM) |

### Three pipelines compared (2026-10-26, same laptop, 8 voice tests each)

| | Cascade | Realtime (`gpt-realtime-2.1`) | GPT-Live (`gpt-live-1`) |
|---|---|---|---|
| Voice tests passed | 8/8 | 8/8 | 8/8 |
| Caller stops → Chloe speaks (median / p90) | ~1.4–2.3 s | 1.23 / 1.60 s | 1.39 / 1.81 s |
| Voice | ElevenLabs | OpenAI `marin` | OpenAI `marin` (12 GPT-Live voices + custom) |
| Exact fixed greeting | Yes (TTS) | Requested | Requested, retried if ignored |
| Tools | Direct | Direct | Delegated to backend model (`gpt-5.6-luna`) |
| Hang-up reliability | Tool | Tool | Tool + "call finished?" guard (needed on most calls) |
| Text behaviour tests | 7/7 | — | Not supported by LiveKit for duplex models |
| Cost | per token + Deepgram + ElevenLabs | per audio token | $0.05/min + backend tokens |

Latency includes the end-of-turn wait; GPT-Live's figure includes turns where it delegated a tool.
Behaviour notes from the test calls: GPT-Live sounds the most natural and handles interruptions well;
it transferred a corporate caller after hours where realtime correctly offered a callback instead.

OpenAI first-token time is mostly network distance from this laptop (TLS handshake 0.3 s, Deepgram
1.1 s). A server in the US or Australia should cut the cascade figure substantially.

## Done

### Phase 1 — Web demo end to end
- [x] Research frameworks, pick LiveKit Agents (Node)
- [x] LiveKit server running locally (`npm run dev` starts everything)
- [x] Backend: config validation, Express API, MongoDB persistence
- [x] Knowledge base loader (CSV → prompt), loaded per call
- [x] Agent: both pipelines, fixed greeting, tools, transcript + latency reporting
- [x] Tools: save_lead, transfer_call (SIP REFER on phone, notice on web), end_call (speaks goodbye)
- [x] Dead air: "Are you still there?" after 15 s, hang up 12 s later
- [x] Frontend: LiveKit client on demo page, agent-join timeout, monitor via SSE
- [x] Tests: 23 unit, 7 LLM-judged behaviour, 8 voice calls in a real browser (fake microphone)
- [x] Third pipeline: OpenAI GPT-Live (`AGENT_PIPELINE=live`) with greeting retry, hang-up guard,
      delegation logging; all 8 voice tests pass on cascade, realtime and GPT-Live

## To do

### Phase 2 — Phone line
- [ ] LiveKit SIP service (needs Linux/Docker + Redis + public IP)
- [ ] PBXware trunk 13 → LiveKit SIP inbound trunk, dispatch rule → `lemans-receptionist`
- [ ] Transfer targets per Transfer rules sheet (numbers still "TO FILL")
- [ ] Confirm PBXware accepts SIP REFER (cold transfer) from LiveKit
- [ ] Noise cancellation for phone audio (Krisp/BVC is LiveKit Cloud only)

### Phase 3 — Production
- [ ] Choose LiveKit Cloud or self-hosted VPS
- [ ] Docker Compose: livekit, sip, redis, api, agent; TLS; secrets
- [ ] Auth on monitor page and `/api/calls` / `/api/leads` (transcripts are personal data)
- [ ] ActiveCampaign sync for leads (needs API key + list/tags — Open question Q6)
- [ ] Call recording (Egress), alerting on agent errors

## Open questions for LeMans (from knowledge base)
Q1 Friday hours · Q2 transfer numbers · Q5 rate card · Q6 ActiveCampaign · Q9 paintball.
