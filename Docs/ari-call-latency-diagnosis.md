# Production phone-call startup optimization

Scope: DID -> SIP provider -> 3CX -> 8888 -> Asterisk -> Stasis(lemans-bot) -> AriService -> GPT-Live -> RTP -> caller. No VoiceGateway, VoiceService, browser/frontend testing, telephony configuration, ports, NAT or firewall changes.

## 1. Measured bottleneck

The user supplied a real-call baseline of StasisStart -> first RTP = approximately **2427 ms**.

| Stage | Elapsed from StasisStart | Increment |
|---|---:|---:|
| Answer complete (T3) | 12 ms | 12 ms from arrival |
| Bridge created (T5) | 15 ms | 3 ms after answer |
| Media joined / GPT starts (T8) | 223 ms | 211 ms after answer |
| GPT WebSocket open (T9) | 895 ms | 672 ms handshake |
| Configuration sent (T10) | 897 ms | 2 ms |
| Session ready / greeting sent (T11) | 1534 ms | 637 ms session initialization |
| First GPT audio (T14) | 2405 ms | 871 ms greeting generation |
| First RTP sent (T15) | 2427 ms | 22 ms output pacing |

Answering is fast. The avoidable application dependency was starting GPT only after all ARI media setup. Most latency remains provider connection, session initialization and greeting generation.

## 2. Changes and code flow

AriService.handleStasisStart reserves call state before its first await. initializePhoneCall still answers first. Once answer completes, it registers RTP startup state and starts GPT immediately. The event-driven GPT WebSocket/session branch progresses while ARI bridge/media setup is awaited.

The ARI media branch preserves its existing ordering: create bridge -> add caller -> create externalMedia. Adding externalMedia to the bridge and obtaining its RTP address/port run concurrently, with Promise.allSettled so cleanup cannot outrun an unfinished operation.

bindPhoneRtpEndpoint retrieves UNICASTRTP_LOCAL_ADDRESS and UNICASTRTP_LOCAL_PORT through two concurrent ARI GET /channels/{id}/variable requests. AriRtpMediaService.setRemoteEndpoint associates each call explicitly with that endpoint. This replaces first-pending-call guessing for the production path and allows safe output without waiting for the caller's first RTP packet. Early packets are retained by endpoint until they can be assigned to their call. Original packet-arrival timestamps are retained for diagnostics.

activatePhoneAudio requires both session.started and completed bridge/RTP readiness. It sends the same greeting instructions exactly once, forwards buffered caller audio in order, and releases any unexpectedly early GPT output only after readiness. Caller audio is not sent merely because the WebSocket opened.

cleanupSession cancels locally first: mark ended, close GPT, unregister RTP, and clear audio/diagnostic timers. It waits for outstanding startup requests, then deletes deterministic externalMedia/bridge IDs, including resources created after disconnect. Failed calls are hung up promptly. Application shutdown rejects new calls and waits for active startup cleanup.

Startup buffers are bounded; overflow is an explicit pipeline failure, not silent truncation. GPT handshake has a 10-second failure deadline and session startup has a 15-second failure deadline. These deadlines do not delay successful calls. They protect the new concurrent branch from remaining alive indefinitely when its counterpart fails.

## 3. GPT startup and greeting inspection

- One GPT WebSocket per phone call; duplicate events do not create another session. Live conversational sessions are not shared across callers.
- ARI HTTP client and ARI event connection remain initialized once, rather than per call.
- session.start contains a short static prompt, PCMU 8 kHz format, configured voice and client delegation. There are no per-call remote prompt/config/credential/database fetches, tool-definition generation or tool list.
- ConfigService reads are local. No speculative DNS/TLS tuning or preconnected session pool was added; the measured connection duration combines network handshake stages.
- The greeting remains session.instructions.append, with delegation_id:null, sent after required session.started and media readiness. It is application behavior instructions, not a fabricated user utterance or response.create request.
- No redundant session.updated wait, initial history or greeting tool setup was found. The business prompt and greeting wording are unchanged, since there is no measured evidence that rewriting them would safely reduce the 871 ms interval.
- Per-chunk informational audio logs were removed from the phone response handling path; milestone logs remain. No numeric gain is attributed to that reduction.

Official sources: [GPT-Live WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets), [GPT-Live session management](https://developers.openai.com/api/docs/guides/live-conversations), [Asterisk external media and endpoint variables](https://docs.asterisk.org/Development/Reference-Information/Asterisk-Framework-and-API-Examples/External-Media-and-ARI/).

## 4. Expected timing, not a measured improvement

Moving GPT startup from 223 ms to approximately 12 ms overlaps **211 ms** of media setup.

If provider and generation durations repeat, and MEDIA_READY finishes before GPT session readiness:

- T8: approximately 12 ms
- T9: approximately 684 ms
- T10: approximately 686 ms
- T11 / GREETING: approximately 1323 ms
- T14: approximately 2194 ms
- T15: approximately **2216 ms**

This is an architectural projection, not a new call measurement. Additional RTP variable lookups must finish before readiness, and network/provider variation may exceed this expected saving. No greeting-generation reduction is claimed.

## 5. Turn logging and protocol limits

T0 through T15 remain, with RTP_BOUND, MEDIA_READY, INPUT_BUFFERED, OUTPUT_BUFFERED and CALL_FAILED milestones. CALL-LATENCY-SUMMARY is printed once when first audio is sent, or at cleanup if the call ends earlier.

Summary fields ending in _ms are milliseconds. answer_ms is T3-T2; media_ready_ms, session_ready_ms and first_rtp_ms are elapsed from T0. gpt_connect_ms is T9-T8; session_init_ms is T11-T10; greeting_first_audio_ms is T14-GREETING. Missing or invalid intervals are null. baseline_first_rtp_ms is 2427.

VAD_CONFIG logs exactly what this production session.start sends: no turn_detection type, threshold, prefix_padding_ms, silence_duration_ms, eagerness, create_response or interrupt_response overrides. All are reported as omitted; provider-resolved thresholds are not known. No Realtime VAD fields were added to the GPT-Live session.

GPT-Live's primary voice stream is continuous/full duplex. Its documented transcript fragments do not delimit completed conversational turns, and output audio deltas have no audio-done event. response.event concerns delegated backend Responses work, not the primary voice response lifecycle.

Therefore:

- USER_SPEECH_STARTED / USER_SPEECH_STOPPED: local PCMU energy estimates, using RMS 600, 80 ms minimum voiced audio, and 300 ms observed silence. These are diagnostics only, not GPT VAD decisions. Noise and short pauses can misclassify them.
- FIRST_RESPONSE_AUDIO: actual arrival of the first provider audio delta in a locally grouped output burst.
- RESPONSE_CREATED: explicitly indicates provider_event_unavailable; it does not manufacture a generation-start timestamp.
- RESPONSE_DONE: output_gap_estimate after 350 ms without a new delta. This is not provider completion or caller playback completion; a pause/network gap may split one utterance.
- CALL-TURN-SUMMARY: distinguishes initial_greeting from conversation estimates and logs speech_end_to_first_audio_ms relative to the last locally voiced packet arrival, if an end boundary was observed before output. Overlapping speech yields null. speech_end_to_response_ms remains null because the primary protocol does not expose it.

These diagnostic thresholds/timers never delay, gate or modify streaming or GPT turn taking. Provider event types not otherwise handled are logged once per call without payloads, to detect protocol capability changes. Transcripts, audio, prompts, credentials and authorization headers are not logged.

## 6. Verification and risks

Production-focused tests cover startup overlap; readiness gating; duplicate/external channel starts; disconnect during answer, bridge and externalMedia creation; GPT failure; readiness timeout; early caller/GPT audio buffering; endpoint lookup failure with a pending join; concurrent RTP association/replay; RTP pacing; buffer overflow; cleanup and shutdown; honest local speech metrics.

No live call has been made against the modified application here. The next 3CX call must verify normal greeting, immediate caller speech, multiple conversation turns and hangup. Also test two simultaneous calls and a caller hanging up during startup.

The new application dependency is access to Asterisk's documented UNICASTRTP_LOCAL_* variables. There are two extra concurrent REST reads. Missing variables, an invalid endpoint or a NAT topology that makes the reported local endpoint unreachable can cause call failure; no guesses, NAT rewrites or port changes were made. New buffer caps and startup deadlines deliberately fail stalled calls rather than leak resources or drop audio indefinitely. Early speech is now preserved and may legitimately affect the greeting if a caller speaks immediately.

## 7. Collect the next real-call trace

Build/deploy with the existing production configuration and process manager. Do not start a second instance on the same media port. Confirm GET /ari/health reports the instance connected to lemans-bot.

For a foreground PowerShell deployment:

```powershell
npm run build
npm run start:prod 2>&1 | Tee-Object -FilePath phone-call.log
# Make a real 3CX call, speak immediately, then have two more turns and hang up.
Select-String -Path phone-call.log -Pattern '\[CALL-LATENCY\]|\[CALL-LATENCY-SUMMARY\]|\[CALL-TURN-SUMMARY\]'
```

For an existing systemd service (replace YOUR_SERVICE with the real unit):

```sh
journalctl -u YOUR_SERVICE -f -o cat | grep --line-buffered -E '\[CALL-LATENCY\]|\[CALL-LATENCY-SUMMARY\]|\[CALL-TURN-SUMMARY\]'
```

Collect the entire call trace, not only its summary: T0-T15, RTP_BOUND, MEDIA_READY, GREETING, VAD_CONFIG, speech/response events, turn summaries and any CALL_FAILED reason. Expect T8 immediately after T3 and before media readiness; GREETING must follow both T11 and MEDIA_READY. Compare first_rtp_ms with the measured **2427 ms** baseline across several calls. Do not claim improvement from mock tests or expected timings.

### Local validation result

Production-focused ARI test suite: **20 tests passed across four suites**. TypeScript no-emit check and Nest production build passed. RTP service, diagnostics helpers and all new tests are lint-clean. AriService has seven inherited lint findings, down from the pre-change 22; no added lint errors. The final scoped diff passed whitespace checks and was manually reviewed. Existing browser/VoiceGateway/VoiceService files were not changed. Live provider and 3CX verification remains pending the next real phone call.
