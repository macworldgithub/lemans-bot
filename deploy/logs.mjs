// Readable live view of the server logs: Chloe (agent) and LiveKit SIP, one line per event, local time.
//   node deploy/logs.mjs          call events and what was said
//   node deploy/logs.mjs --all    every line (still reformatted)
// LOG_TZ picks the clock (default Asia/Karachi); e.g. LOG_TZ=Australia/Melbourne node deploy/logs.mjs
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const all = process.argv.includes('--all');
const tz = process.env.LOG_TZ ?? 'Asia/Karachi';
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const color = { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', cyan: '\x1b[36m', magenta: '\x1b[35m' };
const paint = (c, s) => (process.stdout.isTTY ? `${color[c]}${s}${color.reset}` : s);

// Agent (pino JSON) messages worth showing, and the fields to print with them.
const AGENT = {
  'call started': ['source', 'callerNumber'],
  said: [],
  'turn latency': ['e2eMs'],
  'tool ran': ['tool', 'args', 'result'],
  'GPT-Live delegated': [],
  'GPT-Live backend output': ['kind', 'tool', 'said'],
  'lead saved': ['eventType'],
  'call wrapped up without end_call, hanging up': [],
  'caller silent, hanging up': [],
  'call ended': ['reason'],
  'session error': ['err'],
  'registered worker': ['agentName'],
};
// LiveKit SIP messages worth showing.
const SIP = { 'processing invite': 'call arriving', 'Accepting the call': 'call answered', 'SIP call ended': 'call ended' };

const fmt = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

function agentLine(j) {
  const time = clock.format(new Date(j.time));
  const level = j.level >= 50 ? 'red' : j.level >= 40 ? 'yellow' : null;
  if (j.msg === 'said') {
    const who = j.who === 'caller' ? paint('cyan', 'Caller') : paint('magenta', 'Chloe ');
    return `${paint('dim', time)}  ${who}  ${j.text}`;
  }
  if (!all && !(j.msg in AGENT) && !level) return null;
  const fields = (AGENT[j.msg] ?? Object.keys(j).filter((k) => !['level', 'time', 'pid', 'hostname', 'msg', 'version', 'jobID', 'room_id'].includes(k)))
    .filter((k) => j[k] !== undefined && j[k] !== '')
    .map((k) => `${k}=${fmt(j[k])}`)
    .join(' ');
  const text = `[chloe] ${j.msg}${fields ? `  ${fields}` : ''}`;
  return `${paint('dim', time)}  ${level ? paint(level, text) : text}`;
}

function sipLine(line) {
  // 2026-10-26T12:48:15.859Z<TAB>INFO<TAB>sip<TAB>file.go:261<TAB>message<TAB>{json}
  const parts = line.split('\t');
  if (parts.length < 5 || !/^\d{4}-/.test(parts[0])) return all ? line : null;
  const [ts, level, , , msg, rest = ''] = parts;
  const label = SIP[msg];
  const bad = level === 'ERROR' || level === 'WARN';
  if (!all && !label && !bad) return null;
  let extra = '';
  try {
    const f = JSON.parse(rest);
    if (msg === 'processing invite') extra = `from=${f.fromUser} to=${f.toUser}`;
    else if (msg === 'SIP call ended') extra = `reason=${f.reason}`;
    else if (bad || all) extra = Object.entries(f).filter(([k]) => !['nodeID', 'traceID', 'tid', 'sipTag'].includes(k)).map(([k, v]) => `${k}=${fmt(v)}`).join(' ').slice(0, 300);
  } catch {
    extra = rest.slice(0, 200);
  }
  const text = `[phone] ${label ?? msg}${extra ? `  ${extra}` : ''}`;
  return `${paint('dim', clock.format(new Date(ts)))}  ${bad ? paint(level === 'ERROR' ? 'red' : 'yellow', text) : paint('green', text)}`;
}

const pm2 = spawn('pm2', ['logs', 'lemans-bot-new', 'lemans-bot-new-sip', '--raw', '--lines', all ? '50' : '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
console.log(paint('dim', `Watching lemans-bot-new + lemans-bot-new-sip (times in ${tz}). Ctrl+C to stop.`));
for (const stream of [pm2.stdout, pm2.stderr]) {
  readline.createInterface({ input: stream }).on('line', (line) => {
    let out;
    try {
      const j = JSON.parse(line);
      out = typeof j === 'object' && j && 'msg' in j ? agentLine(j) : null;
    } catch {
      out = sipLine(line);
    }
    if (out) console.log(out);
  });
}
process.on('SIGINT', () => {
  pm2.kill();
  process.exit(0);
});
