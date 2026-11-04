#!/usr/bin/env bash
# One-time setup of a NEW IOTx instance on a blank Ubuntu 24.04 server (a client's own copy).
#   bash provision-instance.sh <domain> <admin-email> [public-ip]
# Installs Node 22, Docker and Caddy; starts Postgres (own password) with the suite's and
# Workspace's databases; writes both apps' .env with NEW secrets (nothing is copied from
# another instance; AI keys are added afterwards with set-env.sh); creates the services and
# the Caddy site for <domain> and *.<domain> (published apps). Safe to re-run: existing
# secrets, databases and settings are kept. The code itself arrives with remote-deploy.sh.
set -euo pipefail
DOMAIN=${1:?domain, e.g. iforge.online}
ADMIN=${2:?first admin email}
IP=${3:-$(curl -s -4 https://ifconfig.me || hostname -I | awk '{print $1}')}
ROOT=/opt/iotx
export DEBIAN_FRONTEND=noninteractive

echo "== packages"
# A new server runs its own updates on first boot: wait for the package lock.
for i in $(seq 1 120); do fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock >/dev/null 2>&1 || break; sleep 5; done
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git build-essential openssl debian-keyring debian-archive-keyring apt-transport-https >/dev/null
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh >/dev/null; fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
echo "node $(node -v), $(docker --version | cut -d, -f1), caddy $(caddy version | cut -d' ' -f1)"

mkdir -p "$ROOT/web" "$ROOT/workspace" "$ROOT/projects-data/_forge" "$ROOT/livekit"
rand() { openssl rand -base64 48 | tr -d '/+=\n' | head -c "${1:-40}"; }

echo "== database"
PGPASS_FILE=$ROOT/.pgpass-iotx
[ -f "$PGPASS_FILE" ] || (umask 077; rand 32 > "$PGPASS_FILE")
PGPASS=$(cat "$PGPASS_FILE")
if ! docker ps -a --format '{{.Names}}' | grep -qx iotx-postgres; then
  docker run -d --name iotx-postgres --restart unless-stopped -e POSTGRES_PASSWORD="$PGPASS" \
    -p 127.0.0.1:5432:5432 -v iotx-pgdata:/var/lib/postgresql/data postgres:17 >/dev/null
fi
for i in $(seq 1 30); do docker exec iotx-postgres pg_isready -q -U postgres && break; sleep 2; done
for db in forge iotx_workspace; do
  docker exec iotx-postgres psql -U postgres -tAc "select 1 from pg_database where datname='$db'" | grep -q 1 || docker exec iotx-postgres psql -U postgres -qc "create database $db"
done

echo "== settings (.env, new secrets; existing values are kept)"
setkv() { # file key value: add the key if it isn't there yet
  local f=$1 k=$2 v=$3
  touch "$f"; chmod 600 "$f"
  grep -q "^$k=" "$f" || printf '%s=%s\n' "$k" "$v" >> "$f"
}
WEB=$ROOT/web/.env
WSE=$ROOT/workspace/.env
SERVICE_KEY=$(grep -s '^IOTX_SERVICE_KEY=' "$WEB" | cut -d= -f2- || true)
[ -n "$SERVICE_KEY" ] || SERVICE_KEY=$(rand 48)
setkv "$WEB" NODE_ENV production
setkv "$WEB" PORT 3000
setkv "$WEB" DATABASE_URL "postgresql://postgres:$PGPASS@127.0.0.1:5432/forge"
setkv "$WEB" DB_POOL_MAX 10
setkv "$WEB" AUTH_SECRET "$(rand 48)"
setkv "$WEB" PREVIEW_TOKEN_SECRET "$(rand 48)"
setkv "$WEB" IOTX_PASS_SECRET "$(rand 48)"
setkv "$WEB" AUTH_TRUST_HOST true
setkv "$WEB" AUTH_URL "https://$DOMAIN"
setkv "$WEB" EDITOR_ORIGIN "https://$DOMAIN"
setkv "$WEB" PUBLIC_SITES_HOST "$DOMAIN"
setkv "$WEB" PUBLIC_SITES_CNAME "$DOMAIN"
setkv "$WEB" FORGE_PUBLIC_IP "$IP"
setkv "$WEB" FORGE_RESERVED_SUBDOMAINS "www,mail,admin,api,app,sbx"
setkv "$WEB" PROJECTS_ROOT "$ROOT/projects-data"
setkv "$WEB" FORGE_ADMIN_EMAILS "$ADMIN"
setkv "$WEB" FORGE_SIGNUP_ALLOW "$ADMIN"
setkv "$WEB" IOTX_SERVICE_KEY "$SERVICE_KEY"
setkv "$WEB" SANDBOX_PUBLIC_HOST "$DOMAIN"
setkv "$WSE" NODE_ENV production
setkv "$WSE" DATABASE_URL "postgresql://postgres:$PGPASS@127.0.0.1:5432/iotx_workspace"
setkv "$WSE" DB_POOL_MAX 10
setkv "$WSE" SUITE_URL "http://127.0.0.1:3000"
setkv "$WSE" SUITE_PUBLIC_URL ""
setkv "$WSE" WORKSPACE_PUBLIC_URL ""
setkv "$WSE" PUBLIC_ORIGIN "https://$DOMAIN"
setkv "$WSE" IOTX_SERVICE_KEY "$SERVICE_KEY"
setkv "$WSE" MEET_RECORDINGS_DIR "$ROOT/workspace/storage/meet-recordings"

echo "== services"
cat > /etc/systemd/system/iotx.service <<EOF
[Unit]
Description=IOTx Suite (web)
After=network.target docker.service
Requires=docker.service
[Service]
WorkingDirectory=$ROOT/web
ExecStart=/usr/bin/npm start -- -H 127.0.0.1
Restart=always
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=append:/var/log/iotx.log
StandardError=append:/var/log/iotx.log
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/iotx-workspace.service <<EOF
[Unit]
Description=IOTx Workspace (calendar, tasks, chat)
After=network.target docker.service iotx.service
[Service]
WorkingDirectory=$ROOT/workspace
ExecStart=/usr/bin/npx next start -p 3100 -H 127.0.0.1
Restart=always
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=append:/var/log/iotx-workspace.log
StandardError=append:/var/log/iotx-workspace.log
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable iotx iotx-workspace >/dev/null 2>&1

echo "== web server (Caddy) for $DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
{
	on_demand_tls {
		ask http://127.0.0.1:3000/api/tls-check
	}
}
www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}
https:// {
	tls {
		on_demand
	}
	@livekit {
		host $DOMAIN
		path /livekit /livekit/*
	}
	@sbx header_regexp sbxhost Host ^sbx-[0-9a-f-]+\.$(echo "$DOMAIN" | sed 's/\./\\./g')\$
	handle @sbx {
		reverse_proxy 127.0.0.1:3011
	}
	handle_path /livekit* {
		reverse_proxy 127.0.0.1:7880
	}
	@workspace {
		host $DOMAIN
		path /workspace /workspace/*
	}
	handle @workspace {
		reverse_proxy 127.0.0.1:3100 {
			flush_interval -1
		}
	}
	handle {
		reverse_proxy 127.0.0.1:3000
	}
}
http:// {
	redir https://{host}{uri} permanent
}
EOF
systemctl reload caddy || systemctl restart caddy

echo "== done: $DOMAIN on $IP. Next: add AI keys (set-env.sh), deploy the code (remote-deploy.sh), then Meet (meet-server-setup.sh)."
