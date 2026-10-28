// pm2 apps for the server (behind the existing Asterisk): LiveKit server, LiveKit SIP, API and agent.
// Configs are built from the root .env at start, so no secrets live in files here.
//   pm2 start deploy/ecosystem.config.cjs && pm2 save
// Asterisk hands 3CX calls to LiveKit SIP on 127.0.0.1:SIP_PORT (see deploy/asterisk/).
const path = require('node:path');

const root = path.join(__dirname, '..');
process.loadEnvFile(path.join(root, '.env'));
const env = process.env;

const livekit = {
  port: 7880,
  bind_addresses: ['127.0.0.1'],
  // Only the agent and LiveKit SIP on this machine join rooms. The ICE UDP port skips loopback, so
  // advertise the server's own address (SIP_PUBLIC_IP); the traffic still never leaves the machine.
  rtc: { tcp_port: 7881, udp_port: 7882, use_external_ip: false, node_ip: env.SIP_PUBLIC_IP },
  redis: { address: '127.0.0.1:6379' },
  keys: { [env.LIVEKIT_API_KEY]: env.LIVEKIT_API_SECRET },
  logging: { level: 'info' },
};

const sip = {
  api_key: env.LIVEKIT_API_KEY,
  api_secret: env.LIVEKIT_API_SECRET,
  ws_url: env.LIVEKIT_URL,
  redis: { address: '127.0.0.1:6379' },
  // Only Asterisk on this machine talks to it: listen and announce loopback (SIP Contact and SDP).
  listen_ip: '127.0.0.1',
  nat_1_to_1_ip: '127.0.0.1',
  media_nat_1_to_1_ip: '127.0.0.1',
  sip_port: Number(env.SIP_PORT ?? 5160),
  rtp_port: env.SIP_RTP_PORTS ?? '30000-30100',
  log_level: env.SIP_LOG_LEVEL ?? 'info',
};

module.exports = {
  apps: [
    {
      name: 'lemans-bot-new-livekit',
      script: path.join(root, 'tools/livekit/livekit-server'),
      interpreter: 'none',
      env: { LIVEKIT_CONFIG: JSON.stringify(livekit) },
    },
    {
      name: 'lemans-bot-new-sip',
      script: path.join(root, 'tools/sip/livekit-sip'),
      interpreter: 'none',
      env: { SIP_CONFIG_BODY: JSON.stringify(sip) },
    },
    { name: 'lemans-bot-new-api', script: path.join(root, 'backend/dist/api/index.js'), cwd: path.join(root, 'backend') },
    { name: 'lemans-bot-new', script: path.join(root, 'backend/dist/agent/worker.js'), args: 'start', cwd: path.join(root, 'backend') },
  ],
};
