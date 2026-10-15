/** Local web verification using real providers, without production DB/CRM writes. */
require('reflect-metadata');
const { Module } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const { join } = require('node:path');
const { VoiceGateway } = require('../dist/voice/voice.gateway');
const { VoiceService } = require('../dist/voice/voice.service');
const { SandwichService } = require('../dist/voice/sandwich.service');
const { LeadCaptureService } = require('../dist/voice/lead-capture.service');
process.loadEnvFile('.env');
class HarnessModule {}
Module({
  providers: [
    VoiceGateway,
    VoiceService,
    SandwichService,
    { provide: ConfigService, useValue: new ConfigService(process.env) },
    {
      provide: LeadCaptureService,
      useValue: {
        hasPendingFinalization: () => false,
        startSession() {},
        appendTranscript() {},
        captureLead: async () => ({
          saved: false,
          message: 'Local test only; production persistence is disabled.',
        }),
        finalizeSession: async () => {},
      },
    },
  ],
})(HarnessModule);
(async () => {
  const app = await NestFactory.create(HarnessModule);
  app.enableShutdownHooks();
  app.useStaticAssets(join(process.cwd(), 'public'));
  await app.listen(5055, '127.0.0.1');
  console.log(
    'Voice test harness http://127.0.0.1:5055 (test leads are not saved)',
  );
})().catch(() => {
  console.error('Could not start voice test harness');
  process.exitCode = 1;
});
