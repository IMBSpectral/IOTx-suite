#!/usr/bin/env bash
# One-time Meet media setup on the production server (see README.md, "Production").
# Makes a NEW LiveKit key pair on the server (never printed), writes livekit.yaml
# and egress.yaml, adds the LiveKit and transcription settings to the workspace
# .env, and starts Redis, LiveKit (with TURN on 3478/udp) and Egress. Safe to re-run:
# existing keys and containers are kept.
set -euo pipefail
LK=/opt/iotx/livekit
WS_ENV=/opt/iotx/workspace/.env
WEB_ENV=/opt/iotx/web/.env
REC=/opt/iotx/workspace/storage/meet-recordings
mkdir -p "$LK" "$REC"
chmod 700 "$LK"
chown -R 1001 "$REC" || true

if [ ! -f "$LK/livekit.yaml" ]; then
  umask 077
  KEY="API$(openssl rand -hex 8)"
  SECRET="$(openssl rand -base64 48 | tr -d '/+=\n' | head -c 48)"
  cat > "$LK/livekit.yaml" <<EOF
port: 7880
bind_addresses:
  - "127.0.0.1"
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: true
redis:
  address: 127.0.0.1:6379
keys:
  $KEY: $SECRET
turn:
  enabled: true
  domain: imbspectral.online
  udp_port: 3478
room:
  empty_timeout: 300
  departure_timeout: 20
logging:
  level: info
webhook:
  api_key: $KEY
  urls:
    - http://127.0.0.1:3100/workspace/api/meet/webhook
EOF
  cat > "$LK/egress.yaml" <<EOF
api_key: $KEY
api_secret: $SECRET
ws_url: ws://127.0.0.1:7880
redis:
  address: 127.0.0.1:6379
health_port: 9090
log_level: info
file_output:
  local: true
EOF
  chmod 644 "$LK/egress.yaml" "$LK/livekit.yaml"   # read by the containers' own users; the folder itself is 700
  # Workspace settings: LiveKit, and the transcription key the suite already has.
  cp "$WS_ENV" "$WS_ENV.bak.$(date +%s)"
  grep -v -E '^(LIVEKIT_URL|LIVEKIT_PUBLIC_URL|LIVEKIT_API_KEY|LIVEKIT_API_SECRET|OPENAI_API_KEY|MEET_RECORDINGS_DIR)=' "$WS_ENV" > "$WS_ENV.new"
  {
    echo "LIVEKIT_URL=ws://127.0.0.1:7880"
    echo "LIVEKIT_PUBLIC_URL=wss://imbspectral.online/livekit"
    echo "LIVEKIT_API_KEY=$KEY"
    echo "LIVEKIT_API_SECRET=$SECRET"
    echo "MEET_RECORDINGS_DIR=$REC"
    grep -E '^OPENAI_API_KEY=' "$WEB_ENV" || true
  } >> "$WS_ENV.new"
  mv "$WS_ENV.new" "$WS_ENV"
  chmod 600 "$WS_ENV"
  echo "made a new key pair and wrote the settings"
fi

run() { docker inspect "$1" >/dev/null 2>&1 && echo "$1 already exists" || { shift; docker run "$@" >/dev/null && echo "started"; }; }
run iotx-meet-redis -d --name iotx-meet-redis --restart unless-stopped -p 127.0.0.1:6379:6379 redis:7.4.1-alpine
run iotx-livekit -d --name iotx-livekit --restart unless-stopped --network host -v "$LK/livekit.yaml:/etc/livekit.yaml:ro" livekit/livekit-server:v1.13.10 --config /etc/livekit.yaml
run iotx-meet-egress -d --name iotx-meet-egress --restart unless-stopped --network host --cap-add SYS_ADMIN --shm-size 1g \
  -e EGRESS_CONFIG_FILE=/etc/egress.yaml -v "$LK/egress.yaml:/etc/egress.yaml:ro" -v "$REC:/out" livekit/egress:v1.15.0
sleep 5
docker ps --filter name=iotx- --format '{{.Names}} {{.Status}}'
curl -s -o /dev/null -w "livekit http %{http_code}\n" http://127.0.0.1:7880/
