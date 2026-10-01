# ARI call latency diagnosis

Status: code traced; temporary instrumentation added; reported five-second symptom not reproduced with a live call. No behavioral optimization applied without a measured root cause.

## Actual ingress and flow

`AriService.onModuleInit` registers audio callbacks and opens one ARI event WebSocket at startup only when ASTERISK_ARI_AUTO_CONNECT is true. The HTTP client is constructed once. The configured application is ASTERISK_ARI_APP, default ai-bridge; this instance does not subscribe to lemans-bot unless configured for it.

`connectEventSocket` receives StasisStart -> `handleStasisStart` -> `answerChannel` -> `createBridge` -> `addChannelToBridge` (caller) -> `createWebSocketExternalMediaChannel` -> `addChannelToBridge` (external media) -> store session -> register RTP -> `startAiSession` -> WebSocket open -> session.start -> session.started -> session.instructions.append (greeting) -> session.output_audio.delta -> `sendUlawToCall` -> 20 ms RTP drain -> UDP send.

Despite its name, createWebSocketExternalMediaChannel creates UDP/RTP ulaw media, not a media WebSocket. The separately listening WebSocket gateway is initialized at startup and is not requested by that ARI externalMedia call.

First caller audio: RTP socket -> handleIncomingPacket -> bind remote to pending session -> handleInboundRtpFrame -> session.input_audio.append, only if the provider socket is OPEN. Earlier frames are discarded. AI readiness is session.started; there is no session.updated wait and no explicit ARI VAD/silence/endpoint timer. Greeting is requested on readiness and does not wait for caller speech.

## Findings and limits

- Answer is the first awaited operation. No sleeps, retries, remote prompts, credential fetches, subprocesses, database lookups or MCP setup precede it. The VoiceService incoming-call invocation is commented out.
- Provider connection starts only after five sequential ARI HTTP requests. This definitely adds their cumulative duration to provider startup, but no measured duration is available. Moving startup earlier requires testing greeting/media readiness and hangup/error cleanup; it is not justified as the actual five-second fix yet.
- The 10,000 ms Axios timeout is a request deadline, not an unconditional wait.
- RTP output starts on the next 20 ms drain tick once the remote endpoint is known. Output arriving before remote binding is discarded. Remote binding currently picks the first unbound session, a separate concurrent-call correctness risk.
- Per-audio-chunk informational logging exists and could create logging overhead under load; no measured contribution available.
- Default external-media destination is port 6001, while RTP listener fallback is 6000. Explicit configuration may reconcile these. A mismatch produces missing audio, not a proven fixed delay. No configuration changed.
- PbxService.handleIncomingCall has an intentional 6000 ms tradie-answer poll before redirecting to AI. It is a separate HTTP webhook flow; StasisStart does not invoke it. Confirm if production also uses this webhook upstream.
- Browser VoiceGateway/VoiceService silence timers (10/8 seconds), prewarm expiry (60 seconds), output buffering and CRM/database calls are not used by this ARI call handler.
- No production call logs or Asterisk/3CX telemetry were available. Code does not establish network connection, session startup or generation durations. The deployed build/application identity must be verified.

## Real-call capture

Build and run using the production environment and existing process manager. For a local foreground run:

```powershell
npm run build
npm run start:prod 2>&1 | Tee-Object -FilePath call-latency.log
```

Then call the DID through 3CX and examine:

```powershell
Select-String -Path call-latency.log -Pattern '\[CALL-LATENCY\]'
```

For an existing Linux systemd deployment, replace YOUR_SERVICE with its real unit:

```sh
journalctl -u YOUR_SERVICE -f -o cat | grep --line-buffered '\[CALL-LATENCY\]'
```

GET /ari/health must report connected and the app actually reached by the dialplan. It exposes configured endpoints; do not publish configuration dumps or credentials. If the call reaches lemans-bot while this instance listens to ai-bridge, this instrumentation will not see it.

## Breakdown from one call

All records carry ISO timestamps, monotonic milliseconds from T0 and a call/channel ID. Milestones can arrive out of numeric order because media events run independently; each is emitted once per call.

| Portion | Calculate |
|---|---|
| Dispatch/answer invocation | T2 - T0 |
| Answer HTTP completion | T3 - T2 |
| Bridge creation | T5 - T4 |
| External-media creation HTTP completion | T7 - T6 |
| Complete media setup | MEDIA_JOINED - T3 |
| Provider DNS/TCP/TLS/WebSocket handshake | T9 - T8 |
| Provider session configuration/readiness | T11 - T10 |
| Greeting generation until first received audio | T14 - GREETING |
| AI audio to actual first RTP send | T15 - T14 |
| Total application first-audio latency | T15 - T0 |

T3 is successful answer REST completion, not an independently observed SIP answer at 3CX. T7 is REST completion, not first packet readiness. T14 is first provider audio received, not provider-internal generation start. T15 confirms local transport send, not caller playback. Use Asterisk SIP/ARI timestamps to measure before T0 and packet/caller observations for after T15. There are no fabricated numeric before/after estimates.

Expected: answer invocation has no intentional wait; HTTP/media operations, provider handshake, session startup and audio generation remain network dependent. Once RTP output is queued, the first packet normally starts on a 20 ms tick, subject to event-loop scheduling. A fast T3 with a late T14/T15 means AI first-response/media latency rather than delayed answering.

Next action: collect one full trace with startup messages and provider errors (redacted), identify the dominant measured interval, then apply and verify the smallest causal fix. Keep diagnostics temporarily as requested.

## Local validation

- TypeScript no-emit check passed.
- Nest production build passed.
- Diagnostic milestone isolation/deduplication/cleanup test passed.
- Newly added diagnostics helper and test pass lint; RTP service passes lint.
- Existing full test suite: two passed, three failed because the existing VoiceService and Dashboard test modules omit required dependency providers. No ARI behavior is exercised by those failing tests.
- Existing AriService lint baseline has 22 errors (nine formatting, thirteen other errors). Changes are checked against that baseline rather than changing unrelated code.
- Live 3CX/Asterisk/provider flow has not been verified. No before/after call-latency measurement or confirmed production root cause is claimed.
