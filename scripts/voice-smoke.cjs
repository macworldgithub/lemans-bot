// Real-provider test, isolated from production leads/CRM and without dialing a phone.
const { ConfigService } = require('@nestjs/config');
const { SandwichService } = require('../dist/voice/sandwich.service');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const {
  LEMANS_SYSTEM_PROMPT,
  getEventDateContext,
} = require('../dist/voice/lemans-knowledge');
process.loadEnvFile('.env');
const argument = (name) =>
  process.argv
    .find((item) => item.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
const runs = Number(argument('runs') ?? 1);
if (!Number.isInteger(runs) || runs < 1 || runs > 5)
  throw new Error('--runs must be 1 through 5');
const productionPrompt = process.argv.includes('--production-prompt');
const effort = argument('reasoning');
const label = argument('label') ?? 'results';
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('Invalid test label');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

async function fixture(format) {
  const path = `.tmp/voice-fixture-${format}.raw`;
  if (fs.existsSync(path)) return fs.readFileSync(path);
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(process.env.ELEVENLABS_VOICE_ID)}/stream?output_format=${format}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: 'Hello, what activities do you have for children?',
        model_id: 'eleven_flash_v2_5',
      }),
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok)
    throw new Error(`Fixture synthesis HTTP ${response.status}`);
  const audio = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync('.tmp', { recursive: true });
  fs.writeFileSync(path, audio);
  return audio;
}
async function run(mode, audio, iteration) {
  const config = { ...process.env };
  if (effort) config.OPENAI_VOICE_REASONING_EFFORT = effort;
  const service = new SandwichService(new ConfigService(config));
  const id = `smoke-${mode}-${iteration}`;
  const metrics = [];
  let lastInputAt = null;
  let firstAudioAt = null;
  let bytes = 0;
  let turns = 0;
  let error = null;
  const providerEvents = {};
  const handleTurn = service.handleTurn.bind(service);
  service.handleTurn = (id, session, event) => {
    const name = `${event.type}:${event.event || ''}`;
    providerEvents[name] = (providerEvents[name] || 0) + 1;
    return handleTurn(id, session, event);
  };
  const connectedAt = performance.now();
  try {
    await service.createSession(id, {
      inputEncoding: mode === 'web' ? 'linear16' : 'mulaw',
      inputRate: mode === 'web' ? 24000 : 8000,
      outputFormat: mode === 'web' ? 'pcm_24000' : 'ulaw_8000',
      instructions: productionPrompt
        ? `${LEMANS_SYSTEM_PROMPT}\n${getEventDateContext()}`
        : 'You are Chloe from Le Mans Entertainment. Answer the caller briefly. We offer go-karting, VR and laser tag. Ask one follow-up question.',
      onTranscript: (role) => {
        if (role === 'user') turns++;
      },
      captureLead: async () => ({
        saved: false,
        message: 'This is an isolated test.',
      }),
      onEvent: (event) => {
        if (event.type === 'voice-latency') metrics.push(event);
        if (event.type === 'audio-delta') {
          firstAudioAt ??= performance.now();
          bytes += Buffer.from(event.delta, 'base64').length;
        }
        if (event.type === 'realtime-error') error = event.error.message;
      },
    });
    const startupMs = Math.round(performance.now() - connectedAt);
    const size = mode === 'web' ? 960 : 160; // 20ms packets, as used by web/RTP.
    const started = performance.now();
    for (let offset = 0; offset < audio.length; offset += size) {
      service.sendAudio(
        id,
        audio.subarray(offset, offset + size).toString('base64'),
      );
      lastInputAt = performance.now();
      await sleep(
        Math.max(0, started + (offset / size + 1) * 20 - performance.now()),
      );
    }
    const deadline = performance.now() + 20000;
    while (performance.now() < deadline && !bytes && !error) {
      service.sendAudio(
        id,
        Buffer.alloc(size, mode === 'web' ? 0 : 0xff).toString('base64'),
      );
      await sleep(20);
    }
    if (!bytes) throw new Error(error || 'No response audio before timeout');
    await sleep(500);
    results.push({
      mode,
      iteration,
      startupMs,
      userTurns: turns,
      responseAudioBytes: bytes,
      fileEndToFirstAudioMs: Math.round(firstAudioAt - lastInputAt),
      metrics,
      result: 'passed',
      note: 'Real STT/LLM/TTS; server receipt timing. Phone uses real 8kHz codecs but no PBX dial.',
    });
  } catch (error) {
    results.push({
      mode,
      result: 'failed',
      error: error.message,
      inputAudioBytes: audio.length,
      userTurns: turns,
      providerEvents,
    });
  } finally {
    await service.closeSession(id, false);
  }
}
(async () => {
  for (let iteration = 1; iteration <= runs; iteration++) {
    for (const mode of ['web', 'phone']) {
      try {
        await run(
          mode,
          await fixture(mode === 'web' ? 'pcm_24000' : 'ulaw_8000'),
          iteration,
        );
      } catch (error) {
        results.push({
          mode,
          result: 'failed',
          error: error.message,
          networkCode: error.cause?.code,
        });
      }
    }
  }
  fs.mkdirSync('.tmp', { recursive: true });
  fs.writeFileSync(
    `.tmp/voice-smoke-${label}.json`,
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        productionPrompt,
        reasoning: effort ?? '(voice default)',
        results,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(results, null, 2));
  if (results.some((result) => result.result === 'failed'))
    process.exitCode = 1;
})().catch(() => {
  console.error('Voice smoke test failed');
  process.exitCode = 1;
});
