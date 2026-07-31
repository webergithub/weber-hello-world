# Deploying LinkTalk

LinkTalk is a single Node process (HTTP + WebSocket on one port). The only hard
requirement for real phones is **HTTPS**: microphone recording (Whisper voice
input), the Web Share button (AirDrop / Nearby Share), and Web NFC all require a
secure context. `http://localhost` counts as secure for local testing; anything
reached from another device does not.

The invite QR code and link automatically use whatever host+scheme the phone
reached the server through (`X-Forwarded-Proto` / `X-Forwarded-Host` are
honoured), so nothing needs configuring when you put a proxy or tunnel in front.

---

## Option A — quick trial from your laptop (tunnel)

Fastest way to get real phones in a room:

```bash
npm install && npm start          # serves on :3000

# in another terminal, either:
ngrok http 3000                   # https://xxxx.ngrok-free.app
# or:
cloudflared tunnel --url http://localhost:3000
```

Open the printed `https://…` URL on the host phone, create a room, and let
others scan the QR. Mic / share / NFC all work because the tunnel is HTTPS.

## Option B — VPS with Caddy (recommended)

Caddy gets certificates automatically and proxies WebSockets with zero extra
config:

```
# /etc/caddy/Caddyfile
talk.example.com {
    reverse_proxy localhost:3000
}
```

Run LinkTalk under systemd so it restarts on boot/crash (persistence means a
restart keeps every room's history):

```ini
# /etc/systemd/system/linktalk.service
[Unit]
Description=LinkTalk
After=network.target

[Service]
WorkingDirectory=/opt/linktalk
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=3000
# Environment=WHISPER_API_KEY=sk-...

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now linktalk caddy
```

## Option C — nginx + certbot

The one gotcha is the WebSocket upgrade for `/ws` — include these headers or
joining will silently fail:

```nginx
server {
    server_name talk.example.com;
    # listen 443 ssl; certificates via certbot --nginx

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WebSocket
        proxy_set_header Connection "upgrade";       # WebSocket
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;  # keeps invite links https
        proxy_set_header X-Forwarded-Host $host;
        proxy_read_timeout 1h;                       # long-lived sockets
    }
}
```

## Option D — Docker

```bash
docker build -t linktalk .
docker run -d --name linktalk -p 3000:3000 \
  -v linktalk-data:/app/data \
  -e WHISPER_API_KEY=sk-... \
  linktalk
```

The `data/` volume keeps room history across container restarts. Put Caddy,
nginx, or your platform's HTTPS ingress in front as above.

## PaaS (Render / Fly.io / Railway …)

All of these terminate HTTPS and pass WebSockets through, so the defaults just
work. Two notes:

- Attach a **persistent disk** mounted at `data/` (or set `DATA_FILE` to the
  disk path); otherwise set `PERSIST=0` and accept that a redeploy clears rooms.
- The platform sets `PORT` for you — LinkTalk already reads it.

---

## Environment variables

| Variable | Meaning | Default |
| --- | --- | --- |
| `PORT` | listen port | `3000` |
| `WHISPER_API_KEY` | bearer token for Whisper speech-to-text (voice input off without it) | — |
| `WHISPER_URL` | Whisper-compatible transcription endpoint | OpenAI |
| `WHISPER_MODEL` | model name | `whisper-1` |
| `WHISPER_MOCK` | `1` = canned transcript, for testing without a key | off |
| `TRANSLATE_URL` | translation endpoint template (`{q}`, `{from}`, `{to}`) | MyMemory (key-less) |
| `TRANSLATE_PICK` | dot-path to the translated string in the response | `responseData.translatedText` |
| `TRANSLATE_OFFLINE` | `1` = phrasebook only, no network | off |
| `PERSIST` | `0` = keep rooms in memory only | on |
| `DATA_FILE` | room snapshot location | `data/rooms.json` |
| `ROOM_TTL_MS` | how long an empty room is kept | `86400000` (24h) |
| `ADMIN_TOKEN` | enables the `/admin` console; **unset = console disabled** | — |
| `RATE_TRANSLATE_PER_MIN` | per-IP translate requests/minute | `240` |
| `RATE_TRANSCRIBE_PER_MIN` | per-IP transcribe requests/minute | `60` |
| `RATE_ROOMS_PER_MIN` | per-IP room creations/minute | `60` |
| `RATE_LIMIT` | `0` = disable rate limiting entirely | on |

### Monitoring hooks

- **Liveness/readiness:** `GET /api/health` — returns `200 {"status":"ok"}`, or
  `503 {"status":"shutting_down"}` while the process drains, so load balancers
  and k8s probes can pull it out of rotation cleanly.
- **Metrics:** `GET /api/metrics` — JSON counters (rooms, sockets, messages,
  translations broken down by cache/provider/offline/failure, transcriptions,
  rate-limit trips). Scrape into whatever you use for dashboards.
- **Admin console:** `/admin`, guarded by `ADMIN_TOKEN` (see
  [BACKEND.md](BACKEND.md)). Serve it over HTTPS — the token is sent as a
  bearer header. If you'd rather not expose it publicly, restrict `/admin` and
  `/api/admin/` to your VPN in the proxy config.

> Rate limits key on `X-Forwarded-For`'s first hop, so make sure your proxy sets
> it (the Caddy and nginx configs above do). If every phone shares one NAT
> egress IP, raise the limits accordingly.

## Post-deploy checklist

1. Open the site on two phones over `https://` — create a room on one, scan the
   QR with the other, and exchange a message each way.
2. Set different **I read** languages on each phone and confirm both sides see
   translations (the default MyMemory provider needs outbound internet).
3. Tap the mic: with `WHISPER_API_KEY` set you should see "Transcribing with
   Whisper…" and then the message; **My menu → Settings** shows engine status.
4. Try **Share** — iPhones should offer AirDrop, Android Nearby Share.
5. Restart the service and rejoin the room: history should still be there.
