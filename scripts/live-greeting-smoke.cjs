// Real GPT Live + production ARI service; simulated PBX and no database/CRM.
// Run after npm run build. Uses the existing synthetic question fixture.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const axios = require('axios');
const { Logger } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const { AriService } = require('../dist/ari/ari.service');
const {
  LEMANS_SYSTEM_PROMPT,
  getEventDateContext,
} = require('../dist/voice/lemans-knowledge');
if (fs.existsSync('.env')) process.loadEnvFile('.env');
Logger.overrideLogger(false);
const interrupt = process.argv.includes('--interrupt');
const fixture = fs.readFileSync('.tmp/voice-fixture-ulaw_8000.raw');
const config = new ConfigService({
  ...process.env,
  VOICE_ARCHITECTURE: 'gpt-live',
});
const transcripts = [];
let queuedUntil = 0;
let greetingCount = 0;
let flushes = 0;
let callerStarted = false;
let responseBytes = 0;
const originalCreate = axios.default.create;
axios.default.create = () => ({
  request: async (options) => ({
    data: options.params?.variable
      ? {
          value: options.params.variable.endsWith('ADDRESS')
            ? '127.0.0.1'
            : '18000',
        }
      : { id: 'extmedia-greeting-smoke' },
  }),
});
const service = new AriService(
  config,
  {
    registerCallSession() {},
    unregisterCallSession() {},
    setRemoteEndpoint() {},
    sendUlawToCall(id, audio) {
      if (!callerStarted) greetingCount++;
      else responseBytes += audio.length;
      queuedUntil = Math.max(Date.now(), queuedUntil) + audio.length / 8;
    },
    isOutputQueueDrained: () => Date.now() >= queuedUntil,
    flushQueue() {
      flushes++;
      queuedUntil = 0;
    },
  },
  {},
  {
    isSandwichEnabled: () => false,
    getSystemPrompt: () => `${LEMANS_SYSTEM_PROMPT}\n${getEventDateContext()}`,
    startExternalSession() {},
    finalizeExternalSession: async () => {},
    appendExternalTranscript: (id, role, text) =>
      transcripts.push({ role, text }),
    handleExternalDelegation: async () => {},
  },
);
axios.default.create = originalCreate;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (!service.sessions.has('greeting-smoke'))
      throw new Error('Session closed unexpectedly');
    if (Date.now() >= end)
      throw new Error('Timed out waiting for GPT Live response');
    await delay(20);
  }
}
(async () => {
  try {
    await service.handleStasisStart({ channel: { id: 'greeting-smoke' } });
    await waitFor(() => greetingCount > 0);
    await delay(interrupt ? 500 : 5000);
    assert.equal(
      greetingCount,
      1,
      'Greeting must play once during initial silence',
    );
    callerStarted = true;
    for (let offset = 0; offset < fixture.length; offset += 160) {
      service.handleInboundRtpFrame(
        'greeting-smoke',
        fixture.subarray(offset, offset + 160),
      );
      await delay(20);
    }
    await waitFor(() =>
      transcripts.some(
        (item) =>
          item.role === 'assistant' &&
          !item.text.startsWith("Hi, you've reached"),
      ),
    );
    await delay(3500);
    const ai = service.aiSessions.get('greeting-smoke');
    const assistant = transcripts
      .filter((item) => item.role === 'assistant')
      .map((item) => item.text)
      .join('');
    assert.equal(ai.greetingState, interrupt ? 'interrupted' : 'finished');
    assert.ok(
      responseBytes > 0,
      'GPT Live must return audio after the caller question',
    );
    const introductionCount = (
      assistant.match(/you.ve reached Le Mans|I.m Chloe/gi) || []
    ).length;
    assert.ok(
      introductionCount <= (interrupt ? 0 : 2),
      'GPT Live repeated the introduction',
    );
    console.log(
      JSON.stringify({
        mode: interrupt ? 'interrupt' : 'normal',
        greetingCount,
        greetingState: ai.greetingState,
        flushes,
        responseBytes,
        assistant,
      }),
    );
  } finally {
    await service.handleChannelCleanup({ channel: { id: 'greeting-smoke' } });
    assert.equal(service.aiSessions.size, 0);
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
