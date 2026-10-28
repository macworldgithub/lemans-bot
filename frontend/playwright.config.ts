import path from 'node:path';

import { defineConfig } from '@playwright/test';

// Full-stack tests: need livekit-server, the API and the agent worker running
// (see README). Chromium's fake microphone plays a generated caller recording;
// each project gets its own recording. Generate them with `npm run e2e:audio`.
const fakeMic = (name: string) => ({
  browserName: 'chromium' as const,
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${path.resolve(import.meta.dirname, `e2e/fixtures/${name}.wav`)}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

// Point at another running stack (e.g. a second copy on other ports) with E2E_BASE_URL.
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5180';

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: BASE_URL },
  projects: [
    { name: 'caller-hours', testMatch: ['call.spec.ts', 'monitor.spec.ts'], use: fakeMic('caller-hours') },
    { name: 'caller-silent', testMatch: 'silence.spec.ts', use: fakeMic('caller-silent') },
    ...['caller-kids-price', 'caller-corporate', 'caller-pregnant', 'caller-lead', 'caller-interrupt'].map((name) => ({
      name,
      testMatch: 'behaviour.spec.ts',
      timeout: 180_000,
      use: fakeMic(name),
    })),
  ],
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: true,
  },
});
