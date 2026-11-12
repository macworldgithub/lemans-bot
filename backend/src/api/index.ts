import { pino } from 'pino';

import { config } from '../config.js';
import { HoursService } from '../hours/service.js';
import { FakeSmsProvider } from '../messaging/provider.js';
import { MessagingService } from '../messaging/service.js';
import { createApp } from './app.js';
import { Database } from './db.js';
import { CallStore } from './store.js';

const logger = pino({
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: config.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty', options: { colorize: true } },
});

const store = new CallStore();
const db = new Database(config.MONGO_URI, config.MONGO_DB, logger);

store.on('ended', (call) => {
  db.saveCall(call).catch((err: Error) => logger.error({ err: err.message, callId: call.callId }, 'saving call failed'));
});

await db.connect();

const hoursService = new HoursService({
  timezone: config.TIMEZONE,
  maxAgeMs: config.HOURS_MAX_AGE_SECONDS * 1000,
  onSnapshotSaved: async (s) => db.saveHoursSnapshot(s),
});

const savedSnapshot = await db.loadLatestHoursSnapshot();
if (savedSnapshot && hoursService.loadSnapshot(savedSnapshot)) {
  logger.info({ version: savedSnapshot.version, rows: savedSnapshot.rows.length }, 'loaded hours snapshot from db');
}

const smsProvider = new FakeSmsProvider();
if (config.SMS_ENABLED) throw new Error('Live SMS is unavailable until an approved real provider is configured and release checks pass');
const messagingService = new MessagingService({
  provider: smsProvider,
  // Recipient fingerprints use a keyed HMAC. Keep a dedicated secret when one is configured.
  hmacSecret: config.SMS_HMAC_SECRET ?? config.INTERNAL_API_SECRET,
  bookingUrl: config.BOOKING_LINK_URL,
  mapsUrl: config.MAPS_LINK_URL,
  dailyLimit: config.SMS_DAILY_LIMIT,
  cooldownSeconds: config.SMS_RECIPIENT_COOLDOWN_SECONDS,
  smsEnabled: config.SMS_ENABLED,
  // Live sending fails closed: the service refuses to start without durable storage.
  store: db.connected ? db : undefined,
});

const server = createApp({ config, store, db, logger, hoursService, messagingService }).listen(
  config.PORT,
  config.API_HOST,
  () => {
    logger.info({ host: config.API_HOST, port: config.PORT, pipeline: config.AGENT_PIPELINE }, 'API listening');
  },
);

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  server.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
