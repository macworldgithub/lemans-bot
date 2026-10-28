// Runs a local LiveKit server in dev mode (keys: devkey / secret) for development.
// Its debug output is very chatty, so it goes to logs/livekit.log; only startup is echoed.
// With SIP_ENABLED=true it also starts LiveKit SIP (Docker) so a PBX can call the agent.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { provisionSip, startSip, stopSip } from './sip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const local = path.join(root, 'tools', 'livekit', process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server');
const binary = existsSync(local) ? local : 'livekit-server';

if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const sipEnabled = process.env.SIP_ENABLED === 'true';

mkdirSync(path.join(root, 'logs'), { recursive: true });
const logFile = path.join(root, 'logs', 'livekit.log');
const log = createWriteStream(logFile, { flags: 'w' });

const args = ['--dev', '--bind', '127.0.0.1'];
let sip;
if (sipEnabled) {
  try {
    sip = await startSip();
  } catch (err) {
    console.error(`Phone calls disabled: ${err.message}`);
    process.exit(1);
  }
  // The SIP container reaches the server over Docker's adapter and shares its Redis.
  args.push('--bind', sip.hostIp, '--redis-host', '127.0.0.1:6379');
}

const server = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
server.on('error', (err) => {
  console.error(`Could not start ${binary}: ${err.message}\nRun "npm run setup" first.`);
  process.exit(1);
});

async function provision(attempt = 1) {
  try {
    await provisionSip();
  } catch (err) {
    if (attempt >= 5) return console.error(`Could not set up the SIP trunk: ${err.message}`);
    setTimeout(() => void provision(attempt + 1), 2_000);
  }
}

let announced = false;
let tail = '';
const onData = (chunk) => {
  log.write(chunk);
  tail = (tail + chunk.toString()).slice(-4000);
  if (!announced && chunk.toString().includes('starting LiveKit server')) {
    announced = true;
    console.log(`LiveKit server ready on ws://127.0.0.1:7880 (log: ${path.relative(root, logFile)})`);
    if (sipEnabled) void provision();
  }
};
server.stdout.on('data', onData);
server.stderr.on('data', onData);
server.on('exit', (code) => {
  if (code) {
    const portBusy = /bind|address already in use|Only one usage of each socket address/i.test(tail);
    console.error(
      portBusy
        ? 'LiveKit could not start: its ports (7880-7882) are already in use. Another copy is probably running; stop it first.'
        : `LiveKit exited with code ${code}. Last log lines:\n${tail.split('\n').slice(-8).join('\n')}`,
    );
  }
  if (sip) {
    sip.stop();
    stopSip();
  }
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill());
