#!/usr/bin/env bash
# Runs on the server: deploy one app from /opt/iotx/<app>-new.tgz with almost no downtime.
#   bash remote-deploy.sh web|workspace
# The new version is unpacked, installed and built in /opt/iotx/<app>.staging while the
# live one keeps serving (building in place deleted the live build's files and left pages
# unstyled for minutes). Then the service stops, the folders swap, runtime state (.env*,
# storage) moves across, and it starts again: a few seconds. The previous release stays in
# /opt/iotx/<app>.prev for a quick rollback (one older backup tarball is kept too).
# Schema changes are additive (prisma db push without --accept-data-loss stops on any warning).
set -euo pipefail
APP=$1
DIR=/opt/iotx/$APP
STAGE=/opt/iotx/$APP.staging
PREV=/opt/iotx/$APP.prev
SVC=$([ "$APP" = web ] && echo iotx || echo iotx-workspace)
PORT=$([ "$APP" = web ] && echo 3000 || echo 3100)
TS=$(date +%Y%m%d-%H%M%S)

tar --exclude=node_modules --exclude=.next --exclude=storage -czf "/opt/iotx/backup-$APP-$TS.tgz" -C "$DIR" .
rm -rf "$STAGE"
mkdir -p "$STAGE"
tar -xzf "/opt/iotx/$APP-new.tgz" -C "$STAGE"
rm -rf "$STAGE/.env.local" "$STAGE/.git" "$STAGE/.playwright-mcp"
cp -a "$DIR"/.env "$STAGE"/
# Reuse the installed packages so npm ci only fetches what changed.
cp -a "$DIR/node_modules" "$STAGE/node_modules"
cd "$STAGE"
npm ci --no-audit --no-fund --loglevel=error
npx prisma db push 2>&1 | tail -3
npx prisma generate >/dev/null 2>&1 || true
NODE_OPTIONS=--max-old-space-size=4096 npm run build > "/opt/iotx/build-$APP.log" 2>&1 || { echo "BUILD FAILED (live version untouched), see /opt/iotx/build-$APP.log"; tail -30 "/opt/iotx/build-$APP.log"; exit 1; }

# Swap: seconds of downtime.
systemctl stop "$SVC"
for f in "$DIR"/.env.bak.*; do [ -e "$f" ] && cp -a "$f" "$STAGE"/; done
if [ -d "$DIR/storage" ]; then rm -rf "$STAGE/storage"; mv "$DIR/storage" "$STAGE/storage"; fi
rm -rf "$PREV"
mv "$DIR" "$PREV"
mv "$STAGE" "$DIR"
systemctl start "$SVC"
for i in $(seq 1 30); do
  sleep 1
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/$([ "$APP" = workspace ] && echo workspace/)" || true)
  [ "$code" != "000" ] && break
done
# Keep the five newest backups of this app.
ls -1t /opt/iotx/backup-$APP-*.tgz 2>/dev/null | tail -n +6 | xargs -r rm -f
echo "$APP live, answers $code (previous release: $PREV, backup: /opt/iotx/backup-$APP-$TS.tgz)"
