#!/usr/bin/env bash
# Run Forge's test scripts in a safe order and print a summary table.
#   bash scripts/run-all-tests.sh <devToken> <usersJson> <outDir>
# Order: pure logic → HTTP API (server running) → scripts that also read the
# DB directly (they can disturb the single-connection local Postgres, so last).
cd "$(dirname "$0")/.." || exit 1
TOKEN="$1"; USERS="$2"; OUT="$3"; mkdir -p "$OUT"
SMOKE=d2f83ba4-7130-45f6-846a-ba7432fcefa2     # throwaway smoke-test project
LIVE=60c10f09-de43-4bd6-a22f-0177c865ee6a      # published "Stack parity test"

run() { # name, then the command
  local name="$1"; shift
  local start=$(date +%s)
  "$@" > "$OUT/$name.log" 2>&1
  local code=$?
  local pass=$(grep -c "^PASS" "$OUT/$name.log")
  local fail=$(grep -c "^FAIL" "$OUT/$name.log")
  printf "%-22s pass=%-3s fail=%-3s exit=%-3s %4ss\n" "$name" "$pass" "$fail" "$code" "$(( $(date +%s) - start ))" | tee -a "$OUT/summary.txt"
}

: > "$OUT/summary.txt"
echo "== pure logic" | tee -a "$OUT/summary.txt"
run cron          npx tsx scripts/test-cron.mts
run scan-rules    npx tsx scripts/test-scan-rules.mts
run guards        npx tsx scripts/test-guards.mts
run invariant     npx tsx scripts/test-invariant.mts

echo "== HTTP API" | tee -a "$OUT/summary.txt"
run sharing       npx tsx scripts/test-sharing.mts "$TOKEN" "$USERS"
run billing       npx tsx scripts/test-billing.mts "$TOKEN" "$USERS"
run comments      npx tsx scripts/test-comments.mts "$TOKEN" "$USERS"
run connectors    npx tsx scripts/test-connectors.mts "$TOKEN"
run growth        npx tsx scripts/test-growth.mts "$TOKEN"
run security      npx tsx scripts/test-security.mts
run cloud         npx tsx scripts/test-cloud.mts "$TOKEN"
run quick-edit    npx tsx scripts/test-quick-edit.mts "$TOKEN" "$SMOKE"
run monitoring    npx tsx scripts/test-monitoring.mts "$TOKEN" "$LIVE"
run automations   npx tsx scripts/test-automations.mts "$TOKEN" "$SMOKE"
run verify        npx tsx scripts/test-verify.mts "$SMOKE"

echo "== HTTP + direct DB reads (run last)" | tee -a "$OUT/summary.txt"
run chat-backend     npx tsx scripts/test-chat-backend.mts
run editor-features  npx tsx scripts/test-editor-features.mts
run publish-gates    npx tsx scripts/test-publish-gates.mts
echo "done" | tee -a "$OUT/summary.txt"
