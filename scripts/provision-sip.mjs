// Registers the LiveKit SIP inbound trunk and the dispatch rule that sends every call to the agent.
// Safe to re-run. Reads LIVEKIT_* , AGENT_NAME and SIP_ALLOWED_ADDRESSES from the root .env.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { provisionSip } from './sip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
await provisionSip();
