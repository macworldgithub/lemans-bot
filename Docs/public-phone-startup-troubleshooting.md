# Public telephone call ends after STT backpressure

## What the supplied log proves

Call `1792060445.0` reached the application. Answer succeeded in approximately
110 ms; the ARI bridge, external media channel, and RTP endpoint were ready by
501 ms. Deepgram became ready at approximately 1,599 ms. At 1,605 ms the pipeline
reported `STT_BACKPRESSURE`, followed by call cleanup. The summary reports
`ended_before_first_audio`. No bot output audio milestone appears for this call.

This is a speech pipeline failure after routing into Asterisk. The earlier CRM
retry warnings do not cause this failure. The provided log does not establish
that the caller heard the bot's greeting on this particular call, or prove why
another call's opening words were clipped.

## Why startup could trigger it

The original ARI adapter retained up to two seconds of
8 kHz mulaw input while provider sockets connected. Once ready, it passed those frames to the speech pipeline in
a synchronous loop. Previously, a speech WebSocket write queue over one second
of audio caused immediate fatal cleanup. The JavaScript loop could fill that
queue before network I/O had a chance to drain it. An ordinary startup burst
could therefore be mistaken for a failed connection.

The reproduction test supplies 1.6 seconds of ordered phone packets while a
fake socket models queued network writes. The prior code closed the call. The
corrected code retains the unsent frames and resumes on its existing 80 ms
heartbeat when the socket drains. It also verifies a subsequent caller question
can produce reply audio.

## Safeguards

- Check write capacity before each 80 ms chunk, including within a burst.
- Keep unsent audio ordered in the existing bounded input queue; do not discard
  caller words to hide overload.
- Phone startup audio is bounded at 12 seconds, matching the provider startup
  deadline. The adapter explicitly labels startup frames for the downstream
  queue. Once the backlog drains, the normal two-second live limit resumes.
  Continued input on a blocked network still fails safely when its queue fills.
- A socket that remains backpressured for five seconds without regaining room
  for a chunk still fails with `STT_BACKPRESSURE`.
- Stop the ARI startup replay if cleanup begins. Do not start the greeting on a
  failed call.
- Log first incoming RTP, startup audio release size, temporary backpressure
  queue sizes, and the actual fatal error code. Do not log audio or credentials.

## Greeting and hangup ordering

The introduction now records the audio boundary at which it started. A delayed
speech event for earlier buffered input does not cancel that introduction. Its
caller question is retained and answered when the greeting's TTS context ends.
New speech, or an earlier turn continuing into the introduction, can interrupt
normally. If the caller is already speaking, a new introduction does not start
over them. This fixes an application-side clipping race, not unverified PBX audio
delivery timing.

On hangup, retained audio is written in bounded chunks, followed by `CloseStream`.
The 750 ms transcription grace period starts after the socket write callback for
that close request. All write waiting and transcript draining share a six-second
deadline. A broken write still releases resources and preserves any last known
partial transcript; no new spoken reply starts during shutdown. A callback means
the local write completed, not a guarantee the remote provider transcribed it.

## Test before deployment

```powershell
npm test -- --runInBand
npm run build
```

The regression suite covers startup bursts, five-second provider startup,
restoring the live queue bound, greeting/caller-turn ordering, a reply after
recovery, persistent network stalls, queue overflow, delayed or failed final
writes, and stopping the greeting after pipeline failure.
Mocks reproduce the failure condition; they do not prove PSTN audio delivery.

After deploying and restarting the server, compare one internal extension call
and one public-number call with the same short question. Test a cold first call
as well as a later call. Also check a short interruption, digit-by-digit phone
input, caller hangup, and two simultaneous calls.

Watch for:

- `MEDIA_READY`: Asterisk bridge and RTP binding completed.
- `T12`: a caller-side RTP packet reached the bot. This can be silence; it does
  not by itself prove intelligible microphone audio.
- `SANDWICH_INPUT_RELEASE`: how much audio waited for provider startup.
- `voice-stt-backpressure`: temporary queue pressure. A single recovered warning
  is different from a fatal `voice-pipeline-failed` event.
- `T13`: input was passed to the speech pipeline, not proof of transcription.
- `SANDWICH_TURN_LATENCY` with `kind: conversation`: reply audio reached the bot.
- `T15`: bot RTP audio was sent toward Asterisk, not proof the caller heard it.

If caller audio arrives but produces no transcript/reply, inspect speech events
and codec/audio content next. If caller RTP never arrives, investigate the
3CX-to-Asterisk media leg, codec negotiation, firewall/NAT, and trunk routing.

## If the greeting still starts halfway through

The public path is caller -> public SIP trunk -> 3CX call handling -> bot trunk
-> Asterisk. The internal extension path has fewer steps. Check that 3CX routes
the DID to the intended bot trunk/extension without an extra greeting, IVR,
forwarding loop, or another endpoint answering first. Confirm the exact extension
used (888 vs 8888) in the PBX configuration.

With the startup crash resolved, capture a new call's milestones and Asterisk SIP
answer/media timing. Asterisk documents that remote endpoints can need a short
delay after answering to receive the start of a prompt. If the capture confirms
this, test `Wait(1)` after the existing `Answer()` and before `Stasis(...)` in the
dedicated bot dialplan context. This is a PBX configuration experiment, not an
application change already deployed by this fix. Do not add delays or alter
unrelated routes without verifying the active dialplan.

[Asterisk answer/playback timing guidance](https://docs.asterisk.org/Configuration/Applications/Answer-Playback-and-Hangup-Applications/)
and [Deepgram Flux 80 ms audio guidance](https://developers.deepgram.com/docs/flux/quickstart).

The prevention principle is to distinguish a temporary queue from an outage,
keep resource limits, and exercise the public route as well as the extension.
Providers and networks can still fail; use these diagnostics to locate the
failed step instead of changing model prompts or codecs without evidence.
