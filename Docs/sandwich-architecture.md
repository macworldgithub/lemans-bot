# Sandwich voice architecture

The `Sandwich-Architecture` branch uses one shared streaming pipeline for web and phone calls:

```text
Browser microphone (PCM16, 24 kHz) -- Socket.IO/WebSocket --+
                                                         |
3CX -> existing Asterisk ARI bridge (PCMU, 8 kHz) ---------+-> Deepgram Flux
                                                             |
                                                       finalized user turn
                                                             |
                                                   OpenAI Responses stream
                                                             |
                                                       short text clauses
                                                             |
                                             ElevenLabs Flash v2.5 WebSocket
                                                             |
                           PCM16, 24 kHz -> browser playback / PCMU, 8 kHz -> RTP
```

The existing Asterisk/3CX routing, ARI configuration, bridge and external-media startup, RTP endpoint binding, call teardown, dashboard, authentication, lead extraction and ActiveCampaign integration are retained. The PBX leg continues to use the existing RTP transport; provider STT/TTS audio and browser audio use WebSockets. No new direct 3CX integration or PBX provisioning is required by this change.

## Implementation

`src/voice/sandwich.service.ts` owns one Flux socket and one ElevenLabs socket per call. It uses the existing `openai` package and Responses API for streamed text. The OpenAI client is shared across calls and uses its HTTP connection pool. Responses are independent streamed requests, with a bounded local conversation history. Provider sockets persist across turns. Flux receives 80 ms batches, while browser and RTP inputs remain 20 ms packets. Silence audio keeps Flux connections alive during prewarming and input gaps; Flux v2 does not document a `KeepAlive` message.

The LLM defaults to `OPENAI_VOICE_MODEL`, then `OPENAI_LEAD_MODEL`, then the project's existing lead-model default, `gpt-6-luna`. This is a text model for the Sandwich pipeline; `OPENAI_REALTIME_MODEL` does not select it. There is no new model dependency or replacement of the lead extraction model.

Flux `EndOfTurn` starts the streamed LLM response. `StartOfTurn` interrupts it. Eager speculative replies are deliberately not enabled: they require additional cancellation and tool-side-effect rules. Short text clauses go to Flash as they arrive, without waiting for the complete LLM answer. ElevenLabs output uses `pcm_24000` for web calls and `ulaw_8000` for phones, avoiding resampling on the production RTP path.

Each reply has a unique ElevenLabs context and an abort signal. Barge-in invalidates the context before aborting the LLM request, closes the speech context, discards late output for that context, and clears browser/RTP playback queues. The optional Asterisk WebSocket path sends `FLUSH_MEDIA`. Transcript replacements from Flux are handled as complete revisions rather than appended duplicate words. The browser AudioWorklet remains in the rendering graph with silent output, so capture continues without feeding the microphone into the speakers.

Started calls feed both speakers into the existing `LeadCaptureService`. The LLM's `capture_lead` tool invokes that service, including its existing extraction, database writes, routing and final CRM synchronization. The model receives the save result before it can confirm success. Ending a call waits for queued STT audio and `CloseStream` writes, then allows 750 ms for final transcripts within a six-second overall deadline. It preserves the last known partial user transcript if the network fails, then finalizes the existing lead. Browser prewarming alone does not create a lead.

Phone startup audio has a bounded 12-second allowance matching provider startup. The adapter labels buffered startup frames so the speech queue can accept that backlog and drain it with write-capacity checks; once empty, the normal two-second live input limit resumes. A greeting records the input-audio boundary at which it started. Delayed speech events from before that boundary do not flush the introduction; earlier questions are answered after its TTS context completes. New speech can still interrupt, and a caller already speaking is not talked over by a new introduction.

Connections have startup deadlines, native ping/pong health checks and bounded retries after disconnect, with exponential backoff and jitter. Four reconnect attempts are allowed until a socket has been stable for 30 seconds. Replies have a 30-second watchdog, input buffers are bounded, and stale provider/LLM events cannot restart ended calls. OpenAI retries one failed initial request through the SDK; partial streamed replies are not replayed. After a provider reconnect, a caller may need to repeat an interrupted sentence. Exhausted reconnects end the web session or clean up the phone call and preserve its lead.

## Configuration

Keep credentials in the ignored `.env` file on the backend host:

```dotenv
OPENAI_API_KEY=...
DEEPGRAM_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...

# Optional settings; these are the defaults.
VOICE_ARCHITECTURE=sandwich
OPENAI_VOICE_MODEL=gpt-6-luna
# The voice pipeline defaults to none for gpt-6-luna; other models retain
# their provider default unless explicitly configured (check model support).
OPENAI_VOICE_REASONING_EFFORT=none
DEEPGRAM_EOT_THRESHOLD=0.7
DEEPGRAM_EOT_TIMEOUT_MS=1500
```

The existing `DeepGram_API_Key` spelling is supported when the canonical `DEEPGRAM_API_KEY` is absent or empty. Your current keys and ElevenLabs voice ID can be used as supplied. Provider keys stay in server-side WebSocket headers/API clients and are never sent to the browser or included in latency logs. Existing PBX, MongoDB, SMTP and CRM environment variables continue to apply.

`VOICE_ARCHITECTURE=gpt-live` explicitly restores the previous GPT-Live path for both web and phone calls. Leaving this setting absent enables Sandwich. Restart the backend after configuration changes.

## Verification completed

- `npm run build`: passed.
- Jest: **60 tests passed across 14 suites**. Coverage includes readiness, input batching, streaming before LLM completion, lead tools, transcript revisions, interruption cancellation, stale context rejection, reconnect behavior, buffer limits, final and partial transcript draining, web lead lifecycle, ARI startup gating, µ-law/RTP routing, optional WebSocket flushing and late events after hangup. Regression tests exercise actual ElevenLabs `contextId` / `isFinal` response frames and the snake_case examples, including interrupted-context rejection.
- Playwright MCP: confirmed a real browser WebSocket connection; PCM scheduling and immediate queue cancellation; safe transcript rendering; reconnect status and call-end cleanup. Native AudioWorklet capture with a synthetic microphone stream produced **29 packets of 960 bytes in 600 ms at 24 kHz**, matching 20 ms capture packets.
- The original branch had three failing tests. An isolated archive of `HEAD` reproduced all three. Two tests expected an extra legacy greeting message although the current legacy implementation seeds its greeting in `session.start`. They now verify the seeded greeting and audio ordering. The RTP timing test now controls the actual `node:perf_hooks` clock rather than advancing only Jest timers. Production legacy greeting and RTP timing behavior were not changed to accommodate the tests.
- Live-provider smoke verification passed after correcting the ElevenLabs response parser. Actual TTS responses use `contextId` and `isFinal`; the initial parser expected only the snake_case names shown in API reference examples and discarded the audio. Isolated ElevenLabs probes returned 103,224 bytes of 24 kHz PCM and 18,591 bytes of 8 kHz µ-law. The complete real-provider STT -> LLM -> TTS test returned 189,992 bytes for web and 30,038 bytes for phone. A real-provider browser harness received six chunks totaling 583,440 bytes across its greeting and silence prompts, with its AudioContext running and playback completing without a voice error. No production test leads were created.
- Single-run estimated speech-end -> first server audio measurements were **3,990 ms for web** and **2,092 ms for phone**; detected end-of-turn -> audio was 2,996 ms and 1,827 ms respectively. These are individual synthetic utterance samples, not median/p95 or audible endpoint measurements. The phone codec test did not dial a physical PBX call. The running terminal reported `ECONNREFUSED` at the configured ARI endpoint `127.0.0.1:8088`; physical phone testing requires that endpoint to be reachable.

## Test the configured application

1. Start the backend from this branch: `npm run start:dev`. For a compiled run use `npm run build` followed by `npm run start:prod`. The configured `.env` port at implementation time is `3010`.
2. Open `http://localhost:3010` on the backend host (or your existing HTTPS application URL). Allow microphone access and select **Start Demo Call**. Chloe should greet you with your configured ElevenLabs voice. HTTPS or localhost is required for browser microphone access.
3. Ask an activities or booking question. Check that the user transcript updates, Chloe replies in short natural turns, and audio starts before the entire text response is produced.
4. Interrupt Chloe while she is speaking. Current and queued speech should stop; say a new request and check that her next reply answers it without old speech returning.
5. Give a callback name/number and enquiry, then correct one detail. End the call and verify the existing dashboard/lead record and CRM workflow retain the corrected details. A provider or persistence error must never produce an unsupported claim that saving succeeded.
6. Call your already-configured 3CX number or test extension that routes into the existing Asterisk application. Repeat the same greeting, enquiry, barge-in and callback tests. Say goodbye and verify the normal call teardown after the farewell; also test caller hangup mid-sentence.
7. In a test environment, briefly interrupt provider connectivity. Check reconnect messages, absence of repeated stale audio, successful continuation after recovery, and final call cleanup if recovery fails.

No changes to your extension, dialplan or provider voice are needed to begin these tests. The backend must run where the existing Asterisk ARI/RTP configuration is reachable.

## Latency monitoring

Each reply's first ElevenLabs audio chunk produces a JSON log with `type: "voice-latency"`, also forwarded to web clients. Look at conversation turns, rather than the initial greeting, which is labeled `kind: "prompt"`.

| Field | Meaning |
| --- | --- |
| `speechEndToFirstAudioMs` | Estimated end of the final recognized word to first audio received by the backend. Includes Flux turn detection. Null if a valid word timestamp is unavailable. |
| `endOfTurnToFirstAudioMs` | Flux `EndOfTurn` receipt to first audio received by the backend. |
| `llmFirstTokenMs` | LLM request start to first text delta. |
| `firstTokenToAudioMs` | First text delta to first ElevenLabs audio chunk. |
| `endpoint` | Currently `server_audio_received`. This is not a measurement of audible output at the caller's speaker. |

The speech-end estimate maps Flux sample timestamps onto the backend's audio input timeline. Browser/PBX network delivery and playback queues add latency after the measured endpoint. Existing RTP first-packet diagnostics remain available separately. Use multiple normal conversational turns to report median and p95 measurements; do not interpret a mocked test timing as live service latency.

For an isolated real-provider test without dialing or saving leads, run `npm run test:voice:live`. It synthesizes a test utterance, feeds it through real STT -> LLM -> TTS at real-time speed in web and phone codecs, and writes results to ignored `.tmp/voice-smoke-results.json`. It consumes provider usage. `fileEndToFirstAudioMs` uses the input fixture's end (including any trailing silence); the Flux word-timestamp metric is the closer speech-end estimate.

`npm run test:voice:browser` starts a localhost-only harness on port 5055 using real providers with production DB/CRM writes disabled. Use the normal application on port 3010 to verify saved leads and the existing phone setup.

## Provider references

- [Deepgram Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart): `/v2/listen`, `flux-general-en`, supported codecs and 80 ms input batching.
- [Deepgram turn-based API](https://developers.deepgram.com/reference/speech-to-text/listen-flux): `Connected`, `TurnInfo`, word timestamps and `CloseStream`.
- [OpenAI streaming Responses](https://developers.openai.com/api/docs/guides/streaming-responses): streamed text deltas and response lifecycle.
- [ElevenLabs multi-context TTS WebSocket](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input): persistent connections, contexts, flushing and output formats.
- [ElevenLabs multi-context guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/multi-context-web-socket): receive-side `contextId`; live probes also verified `isFinal`. The adapter accepts both naming conventions.
- [Asterisk WebSocket channel documentation](https://docs.asterisk.org/Configuration/Channel-Drivers/WebSocket/): binary media frames, text controls and `FLUSH_MEDIA`.
