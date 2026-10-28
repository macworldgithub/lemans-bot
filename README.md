# LeMans Voice Agent

AI receptionist ("Chloe") for LeMans Entertainment. Answers callers about activities, ages,
prices, hours and bookings from the knowledge base, takes callback leads, transfers to staff
and hangs up cleanly. Runs on the web demo today; the phone line (PBXware → SIP) is phase 2.

```
Browser demo (React) ──WebRTC──▶ LiveKit Server ◀── Agent worker (Node, @livekit/agents)
                                   (room per call)     Deepgram → OpenAI → ElevenLabs
                                                       local VAD + turn detector
                                                       tools: save_lead · transfer_call · end_call
                                                              │ call events (HTTP, shared secret)
Monitor page ◀──SSE── Express API ◀──────────────────────────┘  → MongoDB (calls, leads)
```

| Folder | What |
|---|---|
| `backend/src/agent` | LiveKit agent worker: pipeline, prompt, tools, call handling |
| `backend/src/api` | Express API: room tokens, agent events, monitor feed, MongoDB |
| `backend/src/knowledge` | Loads `knowledge/*.csv` into the system prompt |
| `knowledge/` | Knowledge base sheets (edit these; next call picks them up) |
| `frontend/` | React + Vite + Tailwind: demo call page `/` and call monitor `/monitor` |
| `docs/PLAN.md` | Architecture decisions and to-do list |
| `archive/` | Previous implementation (Asterisk ARI), kept for reference |

## Run locally

Needs Node 22+.

```bash
cp .env.example .env      # then fill in the API keys
npm install
npm run setup             # installs packages, downloads LiveKit server + turn-detector model
npm run dev               # LiveKit + API + agent + web, Ctrl+C stops all
```

Open http://localhost:5180 and press **Start Demo Call**. Watch every call at
http://localhost:5180/monitor. LiveKit's own log goes to `logs/livekit.log`.

### Phone calls on this machine (3CX)

With `SIP_ENABLED=true` in `.env`, `npm run dev` also starts LiveKit SIP and Redis in Docker
(`sip/docker-compose.yml`) and registers a trunk that sends every call to the agent. Needs:

- Docker Desktop running.
- The router forwarding UDP `SIP_PORT` (5100) and UDP `SIP_RTP_PORTS` (10000-10100) to this machine.
- In 3CX, trunk `test1voice-trunk` → Registrar/Server = this machine's public IP, port 5100. Dial 8888 from a
  3CX extension, or call DID 02 8790 7749 / 02 8787 8741.

Only calls from `SIP_ALLOWED_ADDRESSES` (the 3CX IP) are accepted. SIP log: `logs/sip.log`.
Stopping `npm run dev` with Ctrl+C also stops the containers.

### Server (76.13.179.26, behind the existing Asterisk)

3CX trunk `test1voice-trunk` → Asterisk `76.13.179.26:5100` (`/etc/asterisk/pjsip_lemans.conf`) → dialplan
`[from-lemans-3cx-livekit]` → LiveKit SIP on `127.0.0.1:5160` → Chloe. Nothing in 3CX changes, and LiveKit
is reachable only from the server itself. Code lives in `/var/www/lemans-bot-new`, run by pm2
(`deploy/ecosystem.config.cjs`):

| pm2 app | What |
|---|---|
| `lemans-bot-new` | Agent worker (Chloe) |
| `lemans-bot-new-api` | API on port 3011 (MongoDB, call monitor) |
| `lemans-bot-new-livekit` | LiveKit server, 127.0.0.1:7880 |
| `lemans-bot-new-sip` | LiveKit SIP, 127.0.0.1:5160, RTP 30000-30100 |
| `lemans-bot` | Previous Asterisk ARI bot, stopped and kept |

Deploy: copy the code, `npm --prefix backend ci && npm --prefix backend run build`, `node scripts/setup-livekit.mjs`,
`npm --prefix backend run download-files`, put the `livekit-sip` binary (from the `livekit/sip` image) in
`tools/sip/`, then `pm2 start deploy/ecosystem.config.cjs && node scripts/provision-sip.mjs && pm2 save`.
Redis comes from `apt install redis-server`.

Watch calls live (local time, what the caller and Chloe say, call start/end): `cd /var/www/lemans-bot-new && npm run logs`
(`npm run logs -- --all` for every line; `LOG_TZ=Australia/Melbourne npm run logs` for Melbourne time).
Asterisk side: `asterisk -rvvv`.

Back to the old bot: in `pjsip_lemans.conf` swap the two `context=` lines of `[trunk-lemans-3cx]`, run
`asterisk -rx "pjsip reload"`, then `pm2 stop lemans-bot-new && pm2 start lemans-bot`.

## Tests

| Command | What it checks | Needs |
|---|---|---|
| `npm test` | Backend unit tests (knowledge loader, API, call store, transfers) + frontend build | nothing |
| `npm run test:agent` | Chloe's behaviour against the real OpenAI model, judged by an LLM: hours, prices, no corporate quotes, no medical clearance, transfers, after-hours leads, hang-up | OpenAI key (~cents) |
| `npm run test:e2e` | Real voice calls in a browser with a fake microphone, on whichever pipeline the agent runs: hours question → answer → goodbye → hang-up; silent caller → check-in → hang-up; monitor page; kids party price; corporate (no rate, transfer or callback); pregnant caller not cleared; callback lead saved; caller interrupts Chloe | `npm run dev` running, all keys (~7 min) |

Generate the fake-caller recordings once with `npm --prefix frontend run e2e:audio`. To test a stack on
other ports, set `E2E_BASE_URL` (e.g. `http://localhost:5181`).

## Configuration

All settings live in the root `.env` (see `.env.example`). The important switch:

- `AGENT_PIPELINE=cascade`: Deepgram → OpenAI `gpt-4.1-mini` → ElevenLabs voice. Most control.
- `AGENT_PIPELINE=realtime`: OpenAI speech-to-speech (`gpt-realtime-2.1`). Faster, OpenAI voice only.
- `AGENT_PIPELINE=live`: OpenAI GPT-Live (`gpt-live-1`), full duplex: listens while it talks, handles
  interruptions and backchannels naturally. The voice model answers from the knowledge base itself and
  *delegates* transfers, callback leads and hang-ups to a backend model that runs the tools. Needs a paid
  OpenAI tier. See "GPT-Live notes" below.

Restart `npm run dev` after changing the pipeline.

### GPT-Live notes

GPT-Live is newer and less predictable than the other two pipelines, so the agent adds guards:

| GPT-Live behaviour | Guard in this project |
|---|---|
| Greeting is a request the model may ignore (silent pickup) | Asks again every 4 s until Chloe speaks (max 3 tries) |
| Often says goodbye without delegating the hang-up | After each Chloe line a quick `gpt-4.1-mini` check asks "is the call finished?"; if yes and nobody speaks for 5 s, the agent hangs up |
| Splits one caller sentence into several pieces | Transcript joins everything the caller says until Chloe replies into one line |
| Voice model cannot see tools | Separate voice and backend instructions (`buildLiveInstructions` in `prompt.ts`) |
| Cannot run text-only tests | Behaviour is tested with real voice calls (`npm run test:e2e`) |

Delegations and the tools they ran are logged by the agent (`GPT-Live delegated`, `tool ran`).

`npm --prefix backend run bench:llm -- gpt-4.1-mini gpt-4o-mini` measures OpenAI response time
with the real prompt from this machine.

## Production notes

- Set `NODE_ENV=production` for the agent so it sheds calls when the CPU is busy.
- Run the agent with `npm --prefix backend run build && npm --prefix backend run start:agent`
  and the API with `start:api`; scale agent workers horizontally (each registers with LiveKit).
- The monitor feed and `/api/calls` expose transcripts: put them behind auth before going public.
