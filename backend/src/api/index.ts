import { pino } from 'pino';

import { config } from '../config.js';
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

const server = createApp({ config, store, db, logger }).listen(config.PORT, () => {
  logger.info({ port: config.PORT, pipeline: config.AGENT_PIPELINE }, 'API listening');
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  server.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
