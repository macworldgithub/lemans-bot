# Saved GPT Live telephone greeting

The GPT Live phone path plays a local recording after both `session.started`
and the ARI bridge/RTP destination are ready. It no longer asks the model to
generate the introduction during each call. Browser and Sandwich startup retain
their existing behavior.

The approved recording says:

> Hi, you've reached Le Mans Entertainment. I'm Chloe. How can I help you today?

`src/ari/assets/chloe-greeting.wav` is a mono 24 kHz PCM WAV preview generated
with `gpt-live-1`, voice `quartz`. The telephone version is
`chloe-greeting.ulaw`, raw mono G.711 mu-law at 8 kHz, approximately 4.7 seconds.
Its JSON metadata records the voice, exact returned transcript and audio hash.
The loader checks the hash and format, and rejects a voice mismatch rather than
silently switching voices during the call. The recording and subsequent model
audio both play at their original rate. The former 5% speed conversion was removed
because it can exhaust the output queue between streamed audio chunks and create
gaps. RTP still sends one 160-sample packet every 20 ms.

## Runtime flow

1. Answer the call; connect GPT Live and prepare the ARI media bridge.
2. Once both are ready, queue the saved recording exactly once through the
   existing paced RTP output. No greeting-generation API request occurs per call.
3. Continue sending input every 20 ms. Preserve actual caller audio in order;
   fill gaps with mu-law silence if the telephone route stops sending packets.
4. For an uninterrupted greeting, wait until its local RTP queue drains, then
   tell GPT Live what the application delivered and record the greeting in the
   conversation transcript. This is a local delivery milestone; it cannot prove
   that the remote caller's handset played every packet.
5. If the caller speaks, flush the greeting queue and tell GPT Live it was
   interrupted. A local energy detector reacts to 80 ms of sustained speech;
   provider transcripts also handle quieter callers. Input audio continues and
   is preserved. Background noise can affect energy-based interruption detection.
6. Block unsolicited model output before the first detected caller speech and
   instruct the model to avoid a second introduction.
7. On hangup, stop silence generation, drain queued real caller audio at its
   normal rate, then allow the existing 750 ms final-transcript grace period.
   Queued input is capped at ten seconds; a full startup backlog may therefore
   extend finalization by that much. Cleanup stops the input clock, including on
   provider failure or disconnect.

The implementation uses application playback instead of Live audio fixtures:
fixture playback drops incoming audio while active, which would lose an early
caller interruption. See the official [session guide](https://developers.openai.com/api/docs/guides/live-conversations)
and [playback controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live).

## Transcript fragments and playback

GPT Live manages when to listen and speak through its continuous audio stream.
Caller transcript fragments can arrive late or overlap assistant speech, so the
web handler must not emit `speech-started` from those fragments, and the phone
handler must not clear queued model audio for each fragment. Keep forwarding
transcripts for display and lead capture. Only the application-owned saved
greeting uses the existing first-caller-speech interruption path; it clears that
greeting once. Already queued model audio still plays in order, so interruption
latency also depends on the size of the playback queue.

See the official [transcript timing guidance](https://developers.openai.com/api/docs/guides/live-conversations#transcript-deltas)
and [WebSocket audio handling](https://developers.openai.com/api/docs/guides/voice-websockets?api=live).

## Speaking pace on web and phone

Set `OPENAI_LIVE_SPEAKING_PACE` in `.env` to `slow`, `normal`, `brisk`, `fast`,
or `very_fast`. The default is `brisk`, and unrecognized values fall back to
`brisk`. Restart the backend after changing it; new web and phone sessions use
the same pace instructions. Chloe is still asked to slow down for contact details,
dates, and spelling, and to pause for the caller's answer.

This is a model speaking style, not an exact multiplier or words-per-minute
guarantee. GPT Live's documented audio settings expose a voice choice but no
numeric speech-speed setting. The official [prompting guide](https://developers.openai.com/api/docs/guides/live-prompting#personality)
recommends describing speaking pace in instructions. Browser playback stays at
1.0x and phone RTP keeps its normal 20 ms cadence, preserving the audio stream.

The saved phone greeting is a recording. To apply a changed pace to it too, run
`npm run build`, then `node scripts/generate-live-greeting.cjs`, then
`npm run build` again before deployment. The generator reads the same environment
setting and shared pace instructions, and records `speakingPace` in the greeting
metadata. Listen to the generated WAV before deploying a new recording.

## Build and deploy

Keep these server settings:

```env
VOICE_ARCHITECTURE=gpt-live
OPENAI_LIVE_VOICE=quartz
```

Run `npm run build`, then restart the backend using your usual process manager.
Nest copies `src/ari/assets` to `dist/ari/assets`, including in watch mode. Deploy
that directory with the compiled JavaScript. Do not deploy only individual JS files.
No 3CX routing changes are required for this feature. Test the public number
after deployment because the simulated tests do not exercise your actual trunk.

If you change the voice or approved text, update the shared text and regeneration
script together, run `node scripts/generate-live-greeting.cjs`, listen to the WAV,
and rebuild. Generation uses the project's OpenAI key and incurs one Live session;
it makes no calls and accesses no lead database or CRM. The script validates the
returned transcript before saving assets and has a 30-second limit.

## Verification

Regression coverage checks readiness ordering, duplicate startup events, zero
incoming audio, paced startup replay, caller interruption, quiet-caller transcript
interruption, model greeting suppression, hangup drain and socket backpressure.

Validation on 2026-10-15: all 120 tests across 19 suites passed, along with the
production build and TypeScript checks. Both real GPT Live smoke cases below
passed: one uninterrupted greeting followed by a question, and an early caller
interruption. Each returned model speech without another introduction and removed
the session during cleanup. These tests simulate the PBX; they do not validate the
public telephone route or listener-side audio quality.

An optional real-provider test uses the compiled ARI service with a simulated PBX
and a synthetic caller question. It does not place calls or save leads:

```powershell
npm run build
node scripts/live-greeting-smoke.cjs
node scripts/live-greeting-smoke.cjs --interrupt
```

The smoke script expects the existing `.tmp/voice-fixture-ulaw_8000.raw` fixture
from the isolated voice smoke tests; it fails if that fixture is absent.

For a manual production check, call and remain silent: hear one complete greeting.
Then ask about children's activities: hear an answer without another introduction.
Call again and speak during the greeting: it should stop and answer your request.
Finally, hang up during the greeting and confirm the session is removed. Compare
`GREETING`, `GREETING_FINISHED` or `GREETING_INTERRUPTED`, `T13`, and `T15` for the
same call ID. The greeting's `T14` is now cached audio readiness, not remote synthesis.
