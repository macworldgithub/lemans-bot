# Voice response latency review — 15 October 2026

The pause is measurable. The main contributor in this test was the wait for the
first model text, followed by speech-end detection and speech synthesis/network
delivery. Streaming was already enabled; the app does not wait for the whole
model answer before sending text to ElevenLabs.

## Live comparison

The same cached synthetic question, "Hello, what activities do you have for
children?", was streamed through the actual Deepgram -> OpenAI -> ElevenLabs
pipeline. Both settings used the full current venue prompt, the same model
(`gpt-6-luna`), and unchanged speech detection and speech settings. There were
three independent sessions per audio format per setting (12 completed turns).
Medium reasoning reproduces the previous unset model setting; none is the new
voice default. These batches ran sequentially, without randomization.

Median timings in milliseconds:

| Measurement                                 | Web, medium | Web, none | Phone format, medium | Phone format, none |
| ------------------------------------------- | ----------: | --------: | -------------------: | -----------------: |
| Estimated final word -> first backend audio |       3,088 |     2,664 |                2,754 |              2,463 |
| Detected end of turn -> first backend audio |       2,586 |     2,036 |                2,299 |              1,953 |
| Model request -> first text                 |       2,166 |     1,428 |                1,925 |              1,682 |
| First text -> first backend audio           |         420 |       590 |                  378 |                253 |

Final-word-to-audio samples:

- Web, medium: 3,079 / 3,873 / 3,088 ms.
- Web, none: 2,660 / 3,731 / 2,664 ms.
- Phone format, medium: 2,676 / 2,754 / 4,362 ms.
- Phone format, none: 2,463 / 2,441 / 3,172 ms.

The median total reduction was approximately 14% for web audio and 11% for phone
audio. Three samples per format are too few to establish a production latency
distribution or isolate the setting from network/provider variation. Medians of
individual stages do not necessarily add to the median total. A noticeable pause
remains; this is not a claim of instant responses.

## Change and tradeoff

The voice pipeline now explicitly sends `reasoning: { effort: 'none' }` for the
default `gpt-6-luna` conversational model. `OPENAI_VOICE_REASONING_EFFORT` can
override it, for example `medium` to restore the prior setting. Other model IDs
retain their provider defaults unless this setting is supplied. The extraction
model used for lead saving is unchanged. Restart the backend to load the change.

Less reasoning can change answer quality, especially on complex requests; these
synthetic timing tests do not evaluate every booking workflow. Existing local
tests cover streaming before model completion, tool rounds, interruptions, and
the new reasoning configuration/override behavior.

The Deepgram settings remain `eot_threshold=0.7` and `eot_timeout_ms=1500` by
default. Most measured turns ended naturally before that timeout. Aggressively
shortening it can interrupt someone pausing while spelling an email or giving
phone digits. Eager speculative generation has not been enabled.

## Reproduce

These commands call the configured providers and incur normal API usage. They
send synthetic audio and, with `--production-prompt`, the venue instructions.
Lead capture is stubbed; no database/CRM records are created and no PBX is dialed.

```powershell
npm run build
node scripts/voice-smoke.cjs --production-prompt --runs=3 --reasoning=medium --label=latency-before
node scripts/voice-smoke.cjs --production-prompt --runs=3 --reasoning=none --label=latency-after-full
```

JSON results go to `.tmp/voice-smoke-<label>.json`. Without extra arguments, the
original two-format smoke test still runs once using a minimal test prompt.

## Limits and remaining measurements

- These are first-audio receipt times at the backend, excluding physical speaker
  output, PBX transport, microphone hardware, and user network latency.
- Phone format uses real 8 kHz mulaw STT/TTS but does not place an Asterisk/3CX call.
- The browser source schedules audio with a 60 ms lead; this is source inspection,
  not a new browser runtime measurement. Playwright MCP could not execute because
  its tool approval policy rejected execution in this session.
- Each test measures the first question of a fresh session. Long conversations,
  save-tool waits, concurrency and percentile latency need separate measurements.
- Provider startup is separate from the pause after speaking; one test also saw
  a slow STT connection of approximately 3.16 seconds.

Sources:

- [OpenAI GPT-6 Luna model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna)
  documents the medium reasoning default and support for none.
- [OpenAI latency guidance](https://developers.openai.com/api/docs/guides/latency-optimization)
  explains streaming, output length and request overhead.
- [Deepgram turn detection settings](https://developers.deepgram.com/docs/flux/configuration)
  explains the confidence/latency tradeoff and forced-silence timeout.
