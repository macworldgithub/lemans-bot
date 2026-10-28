# PBXware API Cheatsheet

**Last Validated:** April 24, 2026  
**Tenant:** voice-agent-backend | **Server Setup:** Mixed (see quirks)  
**SIP Provider:** Generic SIP (provider_id=21)

---

## Base Pattern

```
POST to PBXware admin API
Format: pbxware.<object>.<method>
Required: ?apiformat=json&action=pbxware.<object>.<method>
Auth: Bearer <admin_token>
Server quirk: Most use server=440; some tenant-scoped need server=1
```

---

## Known Good Values (Reuse These)

| Item | ID/Value | Notes |
|------|----------|-------|
| SIP Provider | 21 | Generic SIP (not 61 dial code) |
| Trunk ID | 13 | Created & working; maps to voice-agent-backend |
| Existing ERG | 10 | Ring Group 101 |
| Existing DID | 5234 | 0291393728 → mapped to ERG 101 |
| VPS Public IP | 76.13.179.26 | For external testing |
| Asterisk ARI User | tradie | Password: change-me-now (rotate after testing) |
| ARI Endpoint | http://127.0.0.1:8088 | internal, HTTP (not HTTPS in lab) |

---

## Trunk Management

### List Providers
```bash
curl -X POST "http://<pbxware-ip>:440/api" \
  -H "Authorization: Bearer <token>" \
  -d "action=pbxware.trunk.providers&apiformat=json&server=440"
```
**Response:** `provider_id`, `provider_name` (includes "Generic SIP")

### Create Trunk
```bash
curl -X POST "http://<pbxware-ip>:440/api" \
  -H "Authorization: Bearer <token>" \
  -d "action=pbxware.trunk.add \
      &server=440 \
      &apiformat=json \
      &provider_id=21 \
      &country=1 \
      &codecs=alaw,ulaw \
      &codecs_ptime=20,20 \
      &name=voice-agent-backend \
      &hostip=76.13.179.26 \
      &port=5060"
```
**Returns:** `trunk_id` (example: 13)  
**Pitfalls:**
- `country` = PBX internal ID (use 1, not 61)
- `codecs` array length must match `codecs_ptime` (alaw,ulaw + 20,20)

### Edit Trunk
```bash
curl -X POST "http://<pbxware-ip>:440/api" \
  -H "Authorization: Bearer <token>" \
  -d "action=pbxware.trunk.edit \
      &server=440 \
      &apiformat=json \
      &trunk_id=13 \
      &hostip=<new_ip> \
      &port=5060"
```

---

## DID Management

### List DIDs
```bash
curl -X POST "http://<pbxware-ip>:440/api" \
  -H "Authorization: Bearer <token>" \
  -d "action=pbxware.did.list&server=440&apiformat=json"
```
**Returns:** DID list with IDs and mapped destinations

### Add DID
```bash
curl -X POST "http://<pbxware-ip>:440/api" \
  -H "Authorization: Bearer <token>" \
  -d "action=pbxware.did.add \
      &server=440 \
      &apiformat=json \
      &number=0291393729 \
      &dest_type=erg \
      &dest_id=10"
```

### Edit DID
```bash
curl -X POST "http://<pbxware-ip>:440/api" \
  -H "Authorization: Bearer <token>" \
  -d "action=pbxware.did.edit \
      &server=440 \
      &apiformat=json \
      &did_id=5234 \
      &dest_type=trunk \
      &dest_id=13"
```

### Delete DID
```bash
curl -X POST "http://<pbxware-ip>:440/api" \
  -H "Authorization: Bearer <token>" \
  -d "action=pbxware.did.delete&server=440&apiformat=json&did_id=5234"
```

---

## ERG (Ring Group) Management

### List ERGs
```bash
curl -X POST "http://<pbxware-ip>:440/api" \
  -H "Authorization: Bearer <token>" \
  -d "action=pbxware.erg.list&server=440&apiformat=json"
```

### Add ERG
```bash
curl -X POST "http://<pbxware-ip>:440/api" \
  -H "Authorization: Bearer <token>" \
  -d "action=pbxware.erg.add \
      &server=440 \
      &apiformat=json \
      &number=102 \
      &name=Voice%20Agent%20Queue"
```

### Edit ERG
```bash
curl -X POST "http://<pbxware-ip>:440/api" \
  -H "Authorization: Bearer <token>" \
  -d "action=pbxware.erg.edit \
      &server=440 \
      &apiformat=json \
      &erg_id=10 \
      &name=Updated%20Queue"
```

### Add Members to ERG
```bash
curl -X POST "http://<pbxware-ip>:440/api" \
  -H "Authorization: Bearer <token>" \
  -d "action=pbxware.erg.members \
      &server=440 \
      &apiformat=json \
      &erg_id=10 \
      &member_id=1"
```

---

## Common Error Responses & Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `Action object is invalid` | Wrong method name | Check spelling: `pbxware.<object>.<method>` |
| `Tenant not allowed` | Calling tenant-scoped action on server=440 | Try `server=1` instead |
| `In tenant mode` | Action requires tenant context | Try `server=1` with tenant ID |
| Codec mismatch in response | `codecs` count ≠ `codecs_ptime` count | Use matching arrays: `alaw,ulaw` + `20,20` |
| `country` rejected | Using dial code instead of PBX ID | Use PBX internal ID (1, 2, 3…) not 61 |

---

## Next Steps Checklist

- [ ] Confirm DID 5234 → route to trunk 13 (no-answer + after-hours)
- [ ] Test live call: DID → PBXware → trunk 13 → Asterisk `from-pbxware` → `Stasis(ai-bridge)`
- [ ] Verify `GET /ari/health` returns `{ status: "connected" }`
- [ ] Check Asterisk logs for failover chain: `asterisk -rx "pjsip show endpoint pbxware-in"`
- [ ] **SECURITY:** Rotate `tradie` ARI password & API tokens before production

---

## Session Handoff Notes

**To resume:** Paste these three outputs in next session:
1. `curl http://127.0.0.1:3007/ari/health`
2. `sudo asterisk -rx "pjsip show endpoint pbxware-in"`
3. One Asterisk log snippet from a failover test call

This gives instant visibility into whether failures are in PBX routing, SIP auth, or ARI app connection—no re-discovery.

