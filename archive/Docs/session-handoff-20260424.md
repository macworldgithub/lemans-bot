# Session Handoff: Voice Agent Backend ARI/PBXware Integration

**Date:** April 24, 2026  
**Status:** Ready for E2E testing  
**Session Goal:** DID → PBXware → Asterisk → ARI bridge routing verified

---

## Current State: What's Running

### Asterisk (192.168.1.x / 127.0.0.1)
- **ARI enabled:** http.conf + ari.conf active
- **User auth:** `tradie` / `change-me-now` ✅
- **Dialplan:** `from-pbxware` context defined, routes to `Stasis(ai-bridge)` ✅
- **SIP endpoint:** `pbxware-in` configured for inbound trunks ✅

### NestJS App (localhost:3007)
- **ARI module:** `src/ari/*` integrated ✅
- **Health endpoint:** `GET /ari/health` should return `{ status: "connected" }` (needs verification)
- **Env config:** `.env` points to Asterisk ARI at `http://127.0.0.1:8088`, user `tradie` ✅

### PBXware (admin panel)
- **Trunk created:** ID=13, Generic SIP provider (21), routes to 76.13.179.26:5060 ✅
- **ERG exists:** ID=10 (Ring Group 101) ✅
- **DID example:** 5234 (0291393728) currently routes to ERG 10 ✅

---

## What's Left (Exact Next Steps)

### Step 1: Confirm NestJS→ARI Connection
```bash
curl http://127.0.0.1:3007/ari/health
```
**Expected:** `{ "status": "connected" }` or similar  
**If fails:** Check .env ASTERISK_* vars and ARI service initialization logs

### Step 2: Set DID→Trunk Routing in PBXware
Use API: `pbxware.did.edit` to set DID 5234 destination:
```
did_id=5234
dest_type=trunk
dest_id=13
```
This completes the chain: DID → Trunk 13 → Asterisk from-pbxware → Stasis(ai-bridge)

### Step 3: Live Call Test
1. **From external phone** (or SIP client): Call DID 0291393728
2. **Monitor Asterisk logs:**
   ```bash
   asterisk -rx "core show calls"
   asterisk -rx "pjsip show endpoint pbxware-in"
   ```
3. **Expected log trail:**
   ```
   [pbxware channel] → [Stasis app: ai-bridge] → [voice handler invoked]
   ```

### Step 4: Verify Voice Handler Integration
- Check `src/voice/voice.gateway.ts` is listening to Stasis events
- Confirm `src/voice/voice.service.ts` processes incoming calls
- Test WebSocket connection from app to voice handler

---

## Critical Secrets (Rotate After Testing!)

| Item | Value | ⚠️ Status |
|------|-------|----------|
| ARI password | change-me-now | **ROTATE ASAP** |
| PBXware API token | (in .env PBXWARE_API_KEY) | **Keep safe** |
| VPS IP | 76.13.179.26 | Public (OK for lab) |

---

## Files to Check/Review

| File | Purpose |
|------|---------|
| [src/ari/ari.service.ts](../src/ari/ari.service.ts) | ARI WebSocket connection logic |
| [src/voice/voice.gateway.ts](../src/voice/voice.gateway.ts) | Stasis event handler |
| [.env](.env) | ASTERISK_ARI_URL, PBXWARE_API_KEY |
| [Docs/pbxware-api-cheatsheet.md](pbxware-api-cheatsheet.md) | All PBXware API calls (newly created) |

---

## Resume Command (Copy-Paste This)

To verify everything is still healthy on next session:

```bash
# 1. Check Asterisk ARI status
sudo asterisk -rx "ari show users"

# 2. Check NestJS ARI connection
curl http://127.0.0.1:3007/ari/health

# 3. Verify SIP endpoint
sudo asterisk -rx "pjsip show endpoint pbxware-in"

# 4. List current calls
sudo asterisk -rx "core show calls"
```

---

## Known Issues & Workarounds

| Issue | Workaround |
|-------|-----------|
| ARI connection fails on startup | Verify Asterisk is running: `sudo systemctl status asterisk` |
| DID routing seems slow | PBXware may cache—refresh trunk config in UI after API edits |
| Codec mismatch errors | Always match `codecs` and `codecs_ptime` array lengths |
| Tenant vs server ID confusion | Use `server=440` for most; `server=1` only if response says "In tenant mode" |

---

## Next Session Priorities

1. ✅ Run resume command above → confirm all services healthy
2. ⏳ Execute Step 1–4 from "What's Left" section
3. ⏳ Capture first successful call log (for debugging future issues)
4. 🔒 Rotate ARI + API passwords before going live

**Status:** Ready to test. No blockers identified.

