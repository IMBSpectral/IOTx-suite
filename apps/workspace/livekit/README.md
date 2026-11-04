# IOTx Meet: LiveKit, Egress and Redis

Meet uses self-hosted LiveKit (SFU) for media, LiveKit Egress for recordings, and Redis so the two can talk. `livekit.yaml` and `egress.yaml` in this folder are generated locally and hold the API key pair. They are git-ignored. The same pair is in `apps/workspace/.env` as `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`.

## Local (Windows, Docker Desktop)

From Git Bash, with `MSYS_NO_PATHCONV=1` and docker at `"C:/Program Files/Docker/Docker/resources/bin/docker.exe"`:

```
docker run -d --name iotx-meet-redis --restart unless-stopped -p 127.0.0.1:6380:6379 redis:7.4.1-alpine
docker run -d --name iotx-livekit --restart unless-stopped -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
  -v D:/ImbSpectral/REA-V1/apps/workspace/livekit/livekit.yaml:/etc/livekit.yaml livekit/livekit-server:v1.13.10 --config /etc/livekit.yaml
docker run -d --name iotx-meet-egress --restart unless-stopped --network container:iotx-livekit --cap-add SYS_ADMIN --shm-size 1g \
  -e EGRESS_CONFIG_FILE=/etc/egress.yaml -v D:/ImbSpectral/REA-V1/apps/workspace/livekit/egress.yaml:/etc/egress.yaml \
  -v D:/ImbSpectral/REA-V1/apps/workspace/storage/meet-recordings:/out livekit/egress:v1.15.0
```

Notes:
- **Shared network:** Egress shares LiveKit's network (`--network container:iotx-livekit`), so it reaches LiveKit at `ws://127.0.0.1:7880`. If you restart `iotx-livekit`, restart `iotx-meet-egress` afterwards.
- **ICE addresses:** `node_ip: 127.0.0.1` lets browsers on this PC connect through the published ports. `advertise_internal_ip: true` also offers the container's own address. Egress's Chrome needs that address: without it, video recordings fail with "Start signal not received".
- **Webhooks:** LiveKit sends them to `http://host.docker.internal:3100/workspace/api/meet/webhook`, signed with the key pair. Meet also polls Egress, so recordings still finish without them.
- **Check:** run `npx tsx scripts/meet-egress-check.mts` to see whether Egress can start. With nobody in the room, it ends with "Start signal not received", and that is expected. `scripts/test-meet.mts` runs the full check with a real participant.

## Production (imbspectral.online, Linux): not deployed yet

1. **Firewall** (DigitalOcean firewall and ufw):
   - allow 7881/tcp (ICE over TCP) and 7882/udp (media);
   - keep 7880 closed to the internet, because Caddy proxies it;
   - Redis and Egress stay private.
2. **`/opt/iotx/livekit/livekit.yaml`:** use the same layout as local, with these changes:
   - remove `node_ip` and `advertise_internal_ip`;
   - set `rtc.use_external_ip: true`, or `node_ip: <droplet public IP>`;
   - set `redis.address: 127.0.0.1:6379`;
   - set the webhook URL to `http://127.0.0.1:3100/workspace/api/meet/webhook`;
   - generate a new key pair. Don't reuse the local one.
3. **Containers** (host networking on Linux):
   ```
   docker run -d --name iotx-meet-redis --restart unless-stopped -p 127.0.0.1:6379:6379 redis:7.4.1-alpine
   docker run -d --name iotx-livekit --restart unless-stopped --network host -v /opt/iotx/livekit/livekit.yaml:/etc/livekit.yaml livekit/livekit-server:v1.13.10 --config /etc/livekit.yaml
   docker run -d --name iotx-meet-egress --restart unless-stopped --network host --cap-add SYS_ADMIN --shm-size 1g \
     -e EGRESS_CONFIG_FILE=/etc/egress.yaml -v /opt/iotx/livekit/egress.yaml:/etc/egress.yaml \
     -v /opt/iotx/workspace/storage/meet-recordings:/out livekit/egress:v1.15.0
   ```
   - In egress.yaml, use `ws_url: ws://127.0.0.1:7880` and `redis.address: 127.0.0.1:6379`.
   - Egress needs about 2–4 CPU cores for each room-composite recording.
   - The output folder must be writable by the container's user: `chown -R 1001 /opt/iotx/workspace/storage/meet-recordings`, or chmod it.
4. **Caddy** (inside the `imbspectral.online` site, before the `/workspace*` handler):
   ```
   handle_path /livekit* {
       reverse_proxy 127.0.0.1:7880
   }
   ```
   Or use a subdomain, `rtc.imbspectral.online { reverse_proxy 127.0.0.1:7880 }`, which needs a DNS A record. Caddy proxies WebSockets automatically.
5. **apps/workspace .env** on the server:
   - `LIVEKIT_URL=ws://127.0.0.1:7880`
   - `LIVEKIT_PUBLIC_URL=wss://imbspectral.online/livekit` (or `wss://rtc.imbspectral.online`)
   - `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`: the new pair
   - `OPENAI_API_KEY`: for transcription
   - `ANTHROPIC_API_KEY`: already there
   - optional: `MEET_RECORDINGS_DIR` (default `<app>/storage/meet-recordings`) and `MEET_TRANSCRIBE_MODEL` (default `gpt-4o-transcribe`, with a fallback to `whisper-1`)
6. **Deploy steps:**
   - run `npx prisma db push` (additive tables: meetings, meet_participants, meet_recordings);
   - rebuild apps/workspace and restart `iotx-workspace`;
   - deploy web with the updated meetings manifest.
7. **Large rooms:** for many people, or for guests behind strict firewalls, add TURN. LiveKit has a built-in TURN server; enable `turn:` in livekit.yaml with a TLS certificate on 443/5349.

## Phone dial-in (LiveKit SIP): partial, not running

Meet's side is built: every meeting has a 10-digit meeting ID and a 6-digit PIN, people in the meeting see "Join by phone" (More → Meeting information) and the copied invitation includes it, and when SIP is configured each meeting's room gets a `direct` dispatch rule whose PIN is the meeting ID followed by the PIN (so one phone number serves every meeting). Encrypted meetings never get dial-in. With no config, nothing is created or shown.

What's missing, and needs money or a decision:
1. **A SIP trunk and phone number** from a provider (Twilio Elastic SIP Trunking, Telnyx, Plivo, …), pointed at this server's SIP address.
2. **The LiveKit SIP service** next to LiveKit (it shares the Redis):
   ```
   docker run -d --name iotx-meet-sip --restart unless-stopped --network host \
     -e SIP_CONFIG_BODY="$(cat /opt/iotx/livekit/sip.yaml)" livekit/sip:<pinned version>
   ```
   `sip.yaml` holds `api_key`, `api_secret`, `ws_url: ws://127.0.0.1:7880`, `redis.address`, `sip_port: 5060`, `rtp_port: 10000-20000`. Open UDP 5060 and the RTP range in the firewall (only from the provider's addresses).
3. **.env:** `LIVEKIT_SIP_NUMBERS="+1 415 555 0100"` (shown to people; comma-separated), optionally `LIVEKIT_SIP_ALLOWED_ADDRESSES` (provider IPs), `LIVEKIT_SIP_AUTH_USER` / `LIVEKIT_SIP_AUTH_PASS`.
4. Run `npx tsx scripts/meet-sip-setup.mts` (plan), then `--apply`; add the printed `LIVEKIT_SIP_TRUNK_ID=…` to .env and restart Workspace. `--list`, `--remove <trunkId>` and `--self-test` are there too (`--self-test` already passes against the local LiveKit). `LIVEKIT_SIP_ENABLED=0` turns dial-in off again.

Phone callers skip the waiting room and passcode (the PIN is their key), and their number is hidden from others.

## Live streaming (RTMP)

Uses the same Egress container as recordings (room composite, speaker layout) to push to any RTMP/RTMPS address: More → Live stream (host, with the recording switch). The stream key is never stored; we keep the address with the key masked. Everyone in the room sees "Live". `MEET_STREAMING=off` turns it off. Locally the Egress job starts; it was not tested against a real RTMP server (no YouTube/Facebook key here). On the server, egress needs outbound TCP 1935/443 to the platform.
