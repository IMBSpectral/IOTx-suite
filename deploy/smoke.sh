#!/usr/bin/env bash
# Production smoke test. Run from anywhere, against any server:
#   bash deploy/smoke.sh imbpraxintel.in [ssh-host] [ssh-key]
#   bash deploy/smoke.sh imbpraxintel            # server name from servers.conf
# Checks what a user and an operator each depend on. One PASS/FAIL per line;
# exits non-zero if anything failed.
DOMAIN=${1:?domain}
SSH_HOST=${2:-}
SSH_KEY=${3:-}

# A bare server name (no dot) is looked up in servers.conf, so that
# "smoke.sh imbpraxintel" does the right thing instead of silently testing a
# hostname that does not exist.
case "$DOMAIN" in
  *.*) ;;
  *)
    conf="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/servers.conf"
    line=$(awk -v n="$DOMAIN" '$1==n{print; exit}' "$conf" 2>/dev/null)
    [ -n "$line" ] || { echo "no server '$DOMAIN' in $conf" >&2; exit 2; }
    SSH_HOST=${SSH_HOST:-$(echo "$line" | awk '{print $2}')}
    DOMAIN=$(echo "$line" | awk '{print $3}' | sed -E 's|^https?://||')
    echo "server $1 -> $DOMAIN ($SSH_HOST)"
    ;;
esac

# Preflight. Without this, a domain that does not resolve makes every nc check
# report PASS ("port closed") and every curl check report a confusing 000 — a
# broken invocation would look like a mostly-healthy server.
host_ok=$(getent hosts "$DOMAIN" 2>/dev/null | head -1 | awk '{print $1}')
[ -n "$host_ok" ] || host_ok=$(dig +short "$DOMAIN" A 2>/dev/null | head -1)
[ -n "$host_ok" ] || { echo "FATAL: $DOMAIN does not resolve — nothing below would be meaningful" >&2; exit 2; }
if ! curl -s -o /dev/null -m 20 "https://$DOMAIN/" 2>/dev/null; then
  echo "FATAL: https://$DOMAIN/ did not answer at all — is the name right?" >&2; exit 2
fi

pass=0; fail=0

ok()  { printf '  PASS  %s\n' "$1"; pass=$((pass+1)); }
no()  { printf '  FAIL  %s — %s\n' "$1" "$2"; fail=$((fail+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else no "$1" "want '$2', got '$3'"; fi; }
code() { curl -s -o /dev/null -m 30 -w '%{http_code}' -L "$1" 2>/dev/null || echo 000; }
raw()  { curl -s -o /dev/null -m 30 -w '%{http_code}' "$1" 2>/dev/null || echo 000; }

echo "== public routes"
chk "suite root"          200 "$(code "https://$DOMAIN/")"
chk "sign-in page"        200 "$(code "https://$DOMAIN/login")"
chk "workspace tasks"     200 "$(code "https://$DOMAIN/workspace/tasks")"
chk "workspace calendar"  200 "$(code "https://$DOMAIN/workspace/calendar")"
chk "workspace chat"      200 "$(code "https://$DOMAIN/workspace/chat")"
chk "insights"            200 "$(code "https://$DOMAIN/analytics")"
chk "insights sign-in"    200 "$(code "https://$DOMAIN/analytics/login")"

echo "== transport"
chk "http redirects to https" 301 "$(raw "http://$DOMAIN/")"
end=$(echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [ -n "$end" ]; then
  exp=$(date -j -f "%b %d %T %Y %Z" "$end" +%s 2>/dev/null || date -d "$end" +%s 2>/dev/null)
  days=$(( (exp - $(date +%s)) / 86400 ))
  if [ "$days" -gt 14 ]; then ok "TLS cert valid ($days days left)"; else no "TLS cert" "only $days days left"; fi
else
  no "TLS cert" "could not read it"
fi

echo "== access control"
chk "unauthenticated API is refused" 401 "$(raw "https://$DOMAIN/api/projects")"
# A subdomain with no project must not get a certificate, so TLS fails outright
# (curl reports 000). Comparing "not 200" keeps this robust to curl's retries.
r=$(raw "https://nonexistent-$RANDOM.$DOMAIN/")
case "$r" in
  *200*) no "unknown subdomain gets no cert" "it answered 200" ;;
  *)     ok "unknown subdomain gets no cert" ;;
esac

echo "== closed ports"
for p in 5432 6379 7880 9090 3000 3100 3200; do
  if nc -z -G 5 "$DOMAIN" "$p" 2>/dev/null; then
    no "port $p closed" "it is open to the internet"
  else
    ok "port $p closed to the internet"
  fi
done

if [ -n "$SSH_HOST" ]; then
  echo "== server"
  # ONE ssh connection, not one per check: sshd is rate-limited (ufw limit
  # 22/tcp), so a burst of connections gets rejected by the running host and
  # every check then reports a false failure.
  tmp=$(mktemp)
  # shellcheck disable=SC2086
  ssh -o BatchMode=yes -o ConnectTimeout=20 ${SSH_KEY:+-i "$SSH_KEY"} "root@$SSH_HOST" \
    'for s in caddy iotx iotx-workspace iotx-site docker; do echo "svc.$s $(systemctl is-active $s 2>/dev/null)"; done
     for s in caddy iotx iotx-workspace iotx-site; do echo "boot.$s $(systemctl is-enabled $s 2>/dev/null)"; done
     for c in iotx-postgres iotx-livekit iotx-meet-redis iotx-meet-egress; do echo "ctr.$c $(docker inspect -f {{.State.Status}} $c 2>/dev/null)"; done
     echo "ufw $(ufw status 2>/dev/null | head -1 | cut -d: -f2 | tr -d " ")"
     echo "timer $(systemctl is-active iotx-backup.timer 2>/dev/null)"
     echo "dumps $(ls -1 /var/backups/iotx/daily/*.sql.gz 2>/dev/null | wc -l | tr -d " ")"
     echo "prev $(ls -d /opt/iotx/*.prev 2>/dev/null | wc -l | tr -d " ")"
     echo "db $(docker exec iotx-postgres psql -U postgres -d forge -tAc "select 1" 2>/dev/null | tr -d " ")"' \
    > "$tmp" 2>/dev/null

  # One key per line, so a lookup is an exact-match grep — no nested quoting.
  val() { grep -m1 "^$1 " "$tmp" 2>/dev/null | cut -d' ' -f2; }

  if [ ! -s "$tmp" ]; then
    no "server reachable over ssh" "no response (rate-limited? wait 30s and retry)"
  else
    for s in caddy iotx iotx-workspace iotx-site docker; do chk "$s running"        active  "$(val "svc.$s")";  done
    for s in caddy iotx iotx-workspace iotx-site;        do chk "$s starts at boot" enabled "$(val "boot.$s")"; done
    for c in iotx-postgres iotx-livekit iotx-meet-redis iotx-meet-egress; do chk "container $c up" running "$(val "ctr.$c")"; done
    chk "firewall on"        active "$(val ufw)"
    chk "backup timer armed" active "$(val timer)"
    n=$(val dumps);  if [ "${n:-0}" -ge 2 ] 2>/dev/null; then ok "database dumps present ($n)";   else no "database dumps"    "found ${n:-0}"; fi
    r=$(val prev);   if [ "${r:-0}" -ge 2 ] 2>/dev/null; then ok "rollback releases kept ($r)";   else no "rollback releases" "found ${r:-0}"; fi
    chk "database reachable" 1 "$(val db)"
  fi
  rm -f "$tmp"
fi

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
