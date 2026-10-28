# Phase 1: Asterisk ARI Bridge Setup

This is the first production step for the selected architecture:

- PBXware handles business logic routing (working hours, no-answer, after-hours)
- Asterisk on your VPS handles media entry and sends calls into `Stasis(ai-bridge)`
- NestJS (`/ari` module) consumes ARI events and forwards call context to `VoiceAgentService`

## 1) VPS install (Ubuntu)

```bash
sudo apt update
sudo apt install -y asterisk
sudo systemctl enable asterisk
sudo systemctl start asterisk
sudo systemctl status asterisk --no-pager
```

## 2) Enable ARI HTTP endpoint

Edit `/etc/asterisk/http.conf`:

```ini
[general]
enabled=yes
bindaddr=0.0.0.0
bindport=8088
```

Edit `/etc/asterisk/ari.conf`:

```ini
[general]
enabled = yes
pretty = yes

[tradie]
type = user
read_only = no
password = change-me
```

## 3) Add minimal Stasis dialplan

Edit `/etc/asterisk/extensions.conf`:

```ini
[from-pbxware]
exten => _X.,1,NoOp(Inbound from PBXware - ${CALLERID(num)} to ${EXTEN})
 same => n,Answer()
 same => n,Stasis(ai-bridge)
 same => n,Hangup()
```

## 4) Add SIP/PJSIP endpoint for PBXware

Use your existing Asterisk stack conventions. If using PJSIP, create a trunk endpoint and route inbound calls into context `from-pbxware`.

At minimum:

- identify/auth section for PBXware host/IP
- endpoint context = `from-pbxware`
- transport/codec aligned with PBXware trunk settings

## 5) Open firewall on VPS

```bash
sudo ufw allow 5060/udp
sudo ufw allow 10000:20000/udp
sudo ufw allow 8088/tcp
sudo ufw status
```

## 6) Reload Asterisk

```bash
sudo asterisk -rx "core reload"
sudo asterisk -rx "http show status"
sudo asterisk -rx "ari show users"
```

## 7) App env for NestJS (`.env`)

```dotenv
ASTERISK_ARI_URL=http://127.0.0.1:8088
ASTERISK_ARI_APP=ai-bridge
ASTERISK_ARI_USERNAME=tradie
ASTERISK_ARI_PASSWORD=change-me
ASTERISK_ARI_AUTO_CONNECT=true
```

## 8) Verify from NestJS

1. Start API:
   ```bash
   npm run start:dev
   ```
2. Check health:
   ```bash
   curl http://localhost:3007/ari/health
   ```
3. Expected status after connect:
   - `status: "connected"`
   - `app: "ai-bridge"`

## 9) PBXware handoff for testing

In PBXware, point the no-answer/after-hours destination to the SIP trunk that sends the call to your VPS Asterisk endpoint/context `from-pbxware`.

Once this is live, we move to Phase 2:

- stream media to your realtime AI path
- perform call control (playback, record, transfer, hangup) via ARI.
