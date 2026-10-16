// One-time GPT Live synthesis. No phone calls, database or CRM access.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
// Build first so synthesis uses the same pace instructions as both live paths.
const { getLiveSpeakingPace } = require('../dist/voice/live-speaking-pace');
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const text =
  "Hi, you've reached Le Mans Entertainment. I'm Chloe. How can I help you today?";
const voice = process.env.OPENAI_LIVE_VOICE || 'quartz';
const pace = getLiveSpeakingPace(process.env.OPENAI_LIVE_SPEAKING_PACE);
if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
const directory = path.resolve(__dirname, '../src/ari/assets');
const chunks = [];
let transcript = '';
let lastAudio = 0;
let inputTimer;
let finished = false;
const eventCounts = {};
const ws = new WebSocket('wss://api.openai.com/v1/live/sessions', {
  headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  handshakeTimeout: 10000,
});
const deadline = setTimeout(
  () =>
    finish(
      new Error(
        `Greeting synthesis timed out; events=${JSON.stringify(eventCounts)}`,
      ),
    ),
  30000,
);
const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
function ulaw(sample) {
  let sign = sample < 0 ? 0x80 : 0;
  let value = Math.min(32635, Math.abs(sample)) + 132;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(value & mask); mask >>= 1)
    exponent--;
  return ~(sign | (exponent << 4) | ((value >> (exponent + 3)) & 15)) & 255;
}
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  clearInterval(inputTimer);
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: 'session.close' }));
  ws.close();
  const terminate = setTimeout(() => ws.terminate(), 1000);
  terminate.unref();
  if (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  if (normalize(transcript) !== normalize(text)) {
    console.error(
      'Greeting transcript does not match the approved text:',
      transcript,
    );
    process.exitCode = 1;
    return;
  }
  let pcm = Buffer.concat(chunks);
  let firstVoiced = 0;
  while (
    firstVoiced < pcm.length / 2 &&
    Math.abs(pcm.readInt16LE(firstVoiced * 2)) < 150
  )
    firstVoiced++;
  pcm = pcm.subarray(Math.max(0, firstVoiced - 2400) * 2);
  // Remove model-generated trailing silence, retaining 200ms of natural decay.
  let lastVoiced = pcm.length / 2 - 1;
  while (lastVoiced > 0 && Math.abs(pcm.readInt16LE(lastVoiced * 2)) < 150)
    lastVoiced--;
  pcm = pcm.subarray(0, Math.min(pcm.length, (lastVoiced + 4800) * 2));
  const duration = pcm.length / 48000;
  if (duration < 2 || duration > 12 || pcm.length % 2) {
    console.error('Invalid greeting audio duration');
    process.exitCode = 1;
    return;
  }
  const wav = Buffer.alloc(44);
  wav.write('RIFF');
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  const phone = Buffer.alloc(Math.floor(pcm.length / 6));
  // Average three PCM samples before downsampling from 24kHz to 8kHz.
  for (let i = 0; i < phone.length; i++) {
    const offset = i * 6;
    phone[i] = ulaw(
      Math.round(
        (pcm.readInt16LE(offset) +
          pcm.readInt16LE(offset + 2) +
          pcm.readInt16LE(offset + 4)) /
          3,
      ),
    );
  }
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'chloe-greeting.wav'),
    Buffer.concat([wav, pcm]),
  );
  fs.writeFileSync(path.join(directory, 'chloe-greeting.ulaw'), phone);
  fs.writeFileSync(
    path.join(directory, 'chloe-greeting.json'),
    JSON.stringify(
      {
        text,
        transcript,
        model: 'gpt-live-1',
        voice,
        speakingPace: pace.name,
        sampleRate: 8000,
        encoding: 'mulaw',
        durationMs: phone.length / 8,
        sha256: crypto.createHash('sha256').update(phone).digest('hex'),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({
      status: 'generated',
      voice,
      speakingPace: pace.name,
      durationMs: phone.length / 8,
      transcript,
    }),
  );
}
ws.on('open', () =>
  ws.send(
    JSON.stringify({
      type: 'session.start',
      session: {
        model: 'gpt-live-1',
        instructions:
          'You are Chloe, a warm Australian receptionist. This is a recording session. Say only the exact requested greeting once. Do not add words, rephrase, or speak again afterward. ' +
          pace.instructions,
        input: [
          {
            type: 'message',
            role: 'developer',
            content: [
              {
                type: 'input_text',
                text: `Say this exact greeting immediately in English, then remain silent: ${text}`,
              },
            ],
          },
        ],
        audio: {
          format: { type: 'audio/pcm', rate: 24000 },
          output: { voice },
        },
        delegation: { type: 'client' },
      },
    }),
  ),
);
ws.on('message', (raw) => {
  try {
    const event = JSON.parse(raw.toString());
    eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
    if (event.type === 'error')
      return finish(
        new Error(
          `GPT Live rejected synthesis (${event.error?.code || 'provider_error'})`,
        ),
      );
    if (event.type === 'session.started') {
      let ticks = 0;
      inputTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(
          JSON.stringify({
            type: 'session.input_audio.append',
            audio: Buffer.alloc(960).toString('base64'),
          }),
        );
        if (++ticks === 150 && !lastAudio)
          ws.send(
            JSON.stringify({
              type: 'session.instructions.append',
              delegation_id: null,
              content: `Recording starts now. Say only this exact greeting once, immediately, then remain silent: ${text}`,
            }),
          );
        if (lastAudio && Date.now() - lastAudio > 1500) finish();
      }, 20);
    }
    if (event.type === 'session.output_audio.delta') {
      const audio = Buffer.from(event.delta, 'base64');
      chunks.push(audio);
      for (let i = 0; i + 1 < audio.length; i += 2) {
        if (Math.abs(audio.readInt16LE(i)) >= 150) {
          lastAudio = Date.now();
          break;
        }
      }
    }
    if (event.type === 'session.output_transcript.delta')
      transcript += event.delta || '';
  } catch {
    finish(new Error('Invalid GPT Live response'));
  }
});
ws.on('error', () => finish(new Error('GPT Live connection failed')));
ws.on('close', () => {
  if (!finished)
    finish(new Error('GPT Live closed before synthesis completed'));
});
