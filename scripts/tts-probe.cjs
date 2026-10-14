// Isolated ElevenLabs diagnostic. Logs metadata only, never keys or audio payloads.
const WebSocket = require('ws');
const { randomUUID } = require('node:crypto');
process.loadEnvFile('.env');
const context = randomUUID();
const url = new URL(
  `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(process.env.ELEVENLABS_VOICE_ID)}/multi-stream-input`,
);
url.searchParams.set('model_id', 'eleven_flash_v2_5');
url.searchParams.set(
  'output_format',
  process.argv.includes('--phone') ? 'ulaw_8000' : 'pcm_24000',
);
const ws = new WebSocket(url, {
  headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
  handshakeTimeout: 10000,
});
let audioBytes = 0;
let packets = 0;
let done = false;
const started = Date.now();
const timer = setTimeout(() => finish('timeout'), 15000);
function finish(result) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  console.log(
    JSON.stringify({
      result,
      packets,
      audioBytes,
      elapsedMs: Date.now() - started,
    }),
  );
  ws.terminate();
  if (!audioBytes) process.exitCode = 1;
}
ws.on('open', () => {
  console.log(
    JSON.stringify({
      event: 'connected',
      outputFormat: url.searchParams.get('output_format'),
    }),
  );
  ws.send(
    JSON.stringify({
      context_id: context,
      text: ' ',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        use_speaker_boost: false,
      },
    }),
  );
  ws.send(
    JSON.stringify({
      context_id: context,
      text: 'Hello, this is Chloe. How can I help you today? ',
      flush: true,
    }),
  );
  ws.send(JSON.stringify({ context_id: context, close_context: true }));
});
ws.on('message', (raw) => {
  const event = JSON.parse(raw.toString());
  const bytes = event.audio ? Buffer.from(event.audio, 'base64').length : 0;
  packets++;
  audioBytes += bytes;
  console.log(
    JSON.stringify({
      event: 'tts-frame',
      keys: Object.keys(event),
      audioBytes: bytes,
      snakeContextMatches: event.context_id === context,
      camelContextMatches: event.contextId === context,
      is_final: event.is_final,
      isFinal: event.isFinal,
      hasError: !!event.error,
    }),
  );
  if (event.is_final || event.isFinal || event.error) finish('completed');
});
ws.on('error', (error) => {
  console.log(
    JSON.stringify({
      event: 'connection-error',
      code: error.code || 'WS_ERROR',
    }),
  );
  finish('connection-error');
});
ws.on('close', () => finish('closed'));
