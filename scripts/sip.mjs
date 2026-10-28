// Phone calls on a dev machine (SIP_ENABLED=true): runs LiveKit SIP + Redis in Docker and registers
// the PBX trunk and the dispatch rule that sends every call to the agent. Used by scripts/livekit.mjs.
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compose = ['compose', '-f', path.join(root, 'sip', 'docker-compose.yml')];

const TRUNK_NAME = 'pbx-inbound';
const RULE_NAME = 'pbx-to-agent';

/**
 * The address the containers use to reach the LiveKit server on this machine. On Windows that is the
 * WSL/Docker virtual adapter, which only Docker can see, so the server is not exposed to the LAN.
 */
function dockerHostIp() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (!/^vEthernet \(WSL/i.test(name)) continue;
    const v4 = addrs?.find((a) => a.family === 'IPv4');
    if (v4) return v4.address;
  }
  throw new Error('No "vEthernet (WSL)" network adapter found. Start Docker Desktop and try again.');
}

async function publicIp() {
  if (process.env.SIP_PUBLIC_IP) return process.env.SIP_PUBLIC_IP;
  const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error('Could not detect the public IP; set SIP_PUBLIC_IP in .env');
  return (await res.text()).trim();
}

export function sipSettings() {
  return {
    port: Number(process.env.SIP_PORT ?? 5100),
    rtpPorts: process.env.SIP_RTP_PORTS ?? '10000-10100',
    allowed: (process.env.SIP_ALLOWED_ADDRESSES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    authUsername: process.env.SIP_AUTH_USERNAME || undefined,
    authPassword: process.env.SIP_AUTH_PASSWORD || undefined,
  };
}

/** Starts Redis and LiveKit SIP. Returns the address the LiveKit server must also listen on. */
export async function startSip() {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
  } catch {
    throw new Error('Docker is not running. Start Docker Desktop, or set SIP_ENABLED=false.');
  }
  const { port, rtpPorts } = sipSettings();
  const hostIp = dockerHostIp();
  const externalIp = await publicIp();
  const config = {
    api_key: process.env.LIVEKIT_API_KEY,
    api_secret: process.env.LIVEKIT_API_SECRET,
    ws_url: `ws://${hostIp}:7880`,
    redis: { address: 'redis:6379' },
    sip_port: port,
    rtp_port: rtpPorts,
    // Behind a router: announce the public address in SIP and SDP, and send audio back to
    // wherever the PBX's audio really comes from.
    nat_1_to_1_ip: externalIp,
    media_nat_1_to_1_ip: externalIp,
    symmetric_rtp: true,
    log_level: process.env.SIP_LOG_LEVEL ?? 'info',
  };
  const env = { ...process.env, SIP_CONFIG_BODY: JSON.stringify(config), SIP_PORT: String(port), SIP_RTP_PORTS: rtpPorts };
  execFileSync('docker', [...compose, 'up', '-d', '--force-recreate'], { env, stdio: ['ignore', 'ignore', 'inherit'] });

  const logFile = path.join(root, 'logs', 'sip.log');
  const logs = spawn('docker', [...compose, 'logs', '-f', '--no-color', 'sip'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = createWriteStream(logFile, { flags: 'w' });
  logs.stdout.pipe(out);
  logs.stderr.pipe(out);

  console.log(`LiveKit SIP on ${externalIp}:${port} (UDP/TCP), audio UDP ${rtpPorts} (log: ${path.relative(root, logFile)})`);
  return { hostIp, stop: () => logs.kill() };
}

/** Recreates the inbound trunk and the dispatch rule (idempotent), once the LiveKit server is up. */
export async function provisionSip() {
  const require = createRequire(path.join(root, 'backend', 'package.json'));
  const { SipClient, RoomConfiguration, RoomAgentDispatch } = require('livekit-server-sdk');
  const httpUrl = (process.env.LIVEKIT_URL ?? 'ws://127.0.0.1:7880').replace(/^ws/, 'http');
  const sip = new SipClient(httpUrl, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  const { allowed, authUsername, authPassword } = sipSettings();

  for (const t of await sip.listSipInboundTrunk()) if (t.name === TRUNK_NAME) await sip.deleteSipTrunk(t.sipTrunkId);
  for (const r of await sip.listSipDispatchRule()) if (r.name === RULE_NAME) await sip.deleteSipDispatchRule(r.sipDispatchRuleId);

  // No numbers listed: accept whatever number the PBX dials (8888, a DID, ...).
  const trunk = await sip.createSipInboundTrunk(TRUNK_NAME, [], {
    allowedAddresses: allowed.length ? allowed : undefined,
    authUsername,
    authPassword,
  });
  await sip.createSipDispatchRule(
    { type: 'individual', roomPrefix: 'phone-' },
    {
      name: RULE_NAME,
      trunkIds: [trunk.sipTrunkId],
      roomConfig: new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: process.env.AGENT_NAME ?? 'lemans-receptionist' })] }),
    },
  );
  const who = allowed.length ? `from ${allowed.join(', ')}` : 'from any address';
  console.log(`SIP trunk ready: calls ${who}${authUsername ? ' with password' : ''} go to agent "${process.env.AGENT_NAME ?? 'lemans-receptionist'}"`);
}

export function stopSip() {
  const { port, rtpPorts } = sipSettings();
  // The compose file interpolates the ports, so `down` needs them too.
  const env = { ...process.env, SIP_PORT: String(port), SIP_RTP_PORTS: rtpPorts };
  try {
    execFileSync('docker', [...compose, 'down'], { env, stdio: 'ignore' });
  } catch {
    // Already stopped.
  }
}
