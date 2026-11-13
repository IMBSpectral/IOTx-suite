#!/usr/bin/env bash
# Controlled deploys: each server runs its own release line, release/<server>, and only the
# changes chosen for it go there. Run from the repo root in Git Bash.
#
#   deploy/ship.sh status [server]             what is live where; changes not yet on each server
#   deploy/ship.sh plan   <server> <change…>   try the changes on that server's line (nothing is deployed)
#   deploy/ship.sh deploy <server> <change…>   add the changes to the line, build, deploy, check
#   deploy/ship.sh revert <server> <change…>   undo changes on that server only, then deploy
#   deploy/ship.sh redeploy <server>           deploy the line as it is (e.g. after a server rebuild)
#   deploy/ship.sh log                         rewrite deploy/DEPLOYMENTS.md (servers, who they are for, every deploy)
#
# A change is a commit on main (its short hash, as status prints it). A change that needs an
# earlier one that isn't on the server yet stops with "needs …": ship them together or not at all.
# Servers are listed in deploy/servers.conf. Apps (web, workspace) are deployed only when the
# chosen changes touch them.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
ROOT=$PWD
KEY=${SHIP_SSH_KEY:-$HOME/.ssh/iotx_do}
CONF=deploy/servers.conf
SHIP=$ROOT/.ship

die() { echo "✗ $*" >&2; exit 1; }
server_line() { awk -v n="$1" '!/^#/ && $1==n {print; f=1} END {exit !f}' "$CONF" || die "unknown server '$1' (see $CONF)"; }
host_of() { server_line "$1" | awk '{print $2}'; }
url_of() { server_line "$1" | awk '{print $3}'; }
servers() { awk '!/^#/ && NF {print $1}' "$CONF"; }
branch_of() { echo "release/$1"; }
# Paths that are not part of what servers run.
app_of_path() {
  case "$1" in
    web/*) echo web ;;
    apps/workspace/*) echo workspace ;;
    *) ;;
  esac
}

fetch() { git fetch -q origin main 'refs/heads/release/*:refs/remotes/origin/release/*' --tags 2>/dev/null || true; }

# Commits on main whose change isn't on the server's line yet (cherry-picked ones count as there).
pending() {
  local b; b=$(branch_of "$1")
  git log --no-merges --cherry-pick --right-only --reverse --format='%h%x09%ad%x09%s' --date=short "origin/$b...origin/main" -- web apps/workspace
}

worktree() {
  local s=$1 b dir
  b=$(branch_of "$s")
  dir="$SHIP/$s"
  if [ ! -d "$dir/.git" ] && [ ! -f "$dir/.git" ]; then
    git worktree prune
    git worktree add -q -B "$b" "$dir" "origin/$b" >/dev/null
  fi
  git -C "$dir" checkout -q -B "$b" "origin/$b"
  git -C "$dir" reset -q --hard "origin/$b"
  echo "$dir"
}

status() {
  fetch
  for s in ${1:-$(servers)}; do
    local b; b=$(branch_of "$s")
    git rev-parse -q --verify "origin/$b" >/dev/null || { echo "== $s: no release line yet"; continue; }
    local live; live=$(git describe --tags --abbrev=0 --match "$s/*" "origin/$b" 2>/dev/null || echo "?")
    echo "== $s ($(url_of "$s"))  live: $live  line: $b @ $(git log -1 --format='%h %s' "origin/$b")"
    local p; p=$(pending "$s")
    if [ -z "$p" ]; then echo "   up to date with main"; else
      echo "   not on $s yet (oldest first):"
      echo "$p" | while IFS=$'\t' read -r h d sub; do
        apps=$(git show --name-only --format= "$h" | while read -r f; do app_of_path "$f"; done | sort -u | tr '\n' ' ')
        printf "   %s  %s  %-70.70s  [%s]\n" "$h" "$d" "$sub" "${apps% }"
      done
    fi
  done
}

# Cherry-pick changes onto the server's line in its worktree. Leaves the result committed (not pushed).
apply() {
  local s=$1; shift
  [ $# -gt 0 ] || die "name the changes (short hashes from: deploy/ship.sh status $s)"
  local dir; dir=$(worktree "$s")
  local b; b=$(branch_of "$s")
  # Oldest first, whatever order they were typed in.
  local ordered; ordered=$(for c in "$@"; do git log -1 --format='%ct %H' "$c" || die "no change $c"; done | sort -n | awk '{print $2}')
  for c in $ordered; do
    if git -C "$dir" log --format=%H "origin/$b" | grep -q "^$c$"; then echo "· $(git log -1 --format='%h %s' "$c"): already on $s"; continue; fi
    if ! git -C "$dir" cherry-pick -x "$c" >/dev/null 2>&1; then
      local files; files=$(git -C "$dir" diff --name-only --diff-filter=U | tr '\n' ' ')
      git -C "$dir" cherry-pick --abort 2>/dev/null || true
      echo "✗ $(git log -1 --format='%h %s' "$c") can't go to $s on its own: it builds on changes not there yet." >&2
      echo "  Conflicting files: $files" >&2
      echo "  Earlier changes to those files that $s doesn't have:" >&2
      pending "$s" | while IFS=$'\t' read -r h d sub; do
        [ "$(git rev-parse "$h")" = "$c" ] && continue
        for f in $files; do git show --name-only --format= "$h" | grep -qx "$f" && { echo "    $h  $sub" >&2; break; }; done
      done
      echo "  Ship it together with those (deploy/ship.sh deploy $s <those> $c), or not yet." >&2
      git -C "$dir" reset -q --hard "origin/$b"
      exit 2
    fi
    echo "✓ $(git log -1 --format='%h %s' "$c")"
  done
}

apps_changed() { # apps touched between two commits
  git diff --name-only "$1" "$2" | while read -r f; do app_of_path "$f"; done | sort -u
}

push_and_deploy() {
  local s=$1 before=$2 dir; dir="$SHIP/$s"
  local b; b=$(branch_of "$s")
  local after; after=$(git -C "$dir" rev-parse HEAD)
  local apps; apps=$(apps_changed "$before" "$after")
  [ "${FORCE_APPS:-}" ] && apps=$FORCE_APPS
  [ -n "$apps" ] || { echo "Nothing that runs on the server changed."; return; }
  local n=1 tag; while git rev-parse -q --verify "refs/tags/$s/$(date +%Y.%m.%d).$n" >/dev/null; do n=$((n + 1)); done
  tag="$s/$(date +%Y.%m.%d).$n"
  git -C "$dir" tag "$tag"
  git -C "$dir" push -q origin "$b" "$tag"
  local host; host=$(host_of "$s")
  for app in $apps; do
    local sub=$([ "$app" = web ] && echo web || echo apps/workspace)
    mkdir -p deploy/out
    git archive "$tag:$sub" -o "deploy/out/$app-$s.tgz"
    scp -q -i "$KEY" "deploy/out/$app-$s.tgz" "root@$host:/opt/iotx/$app-new.tgz"
    scp -q -i "$KEY" deploy/remote-deploy.sh "root@$host:/opt/iotx/remote-deploy.sh"
    echo "→ $s: deploying $app ($tag); runs on the server, survives a dropped connection"
    ssh -i "$KEY" -o ConnectTimeout=15 "root@$host" "cd /opt/iotx; echo '$tag' > /opt/iotx/$app.release; (setsid nohup bash remote-deploy.sh $app > /opt/iotx/deploy-$app.log 2>&1 < /dev/null &)"
    local i last=""
    for i in $(seq 1 80); do
      sleep 15
      last=$(ssh -i "$KEY" -o ConnectTimeout=10 "root@$host" "tail -1 /opt/iotx/deploy-$app.log" 2>/dev/null || true)
      case "$last" in *" live, answers "*) break ;; *FAILED*|*rror*) break ;; esac
    done
    echo "  $last"
    case "$last" in *" live, answers "*) ;; *) die "$app on $s did not finish cleanly: see /opt/iotx/deploy-$app.log on the server (the live version is untouched if the build failed)" ;; esac
  done
  local code; code=$(curl -s -o /dev/null -w "%{http_code}" "$(url_of "$s")/login" || true)
  echo "✓ $s is on $tag (sign-in page answers $code)"
  write_log
}

# Keep deploy/DEPLOYMENTS.md current: rewrite it and record it on main (it touches no app).
write_log() {
  fetch
  bash deploy/log.sh >/dev/null || { echo "  (deployment log not updated)"; return; }
  if ! git diff --quiet -- deploy/DEPLOYMENTS.md 2>/dev/null || [ -n "$(git ls-files --others -- deploy/DEPLOYMENTS.md)" ]; then
    git add deploy/DEPLOYMENTS.md && git commit -q -m "Deployment log: $(git describe --tags --abbrev=0 --match "$s/*" "origin/release/$s" 2>/dev/null || echo update)" -- deploy/DEPLOYMENTS.md && echo "  log: deploy/DEPLOYMENTS.md updated"
  fi
}

cmd=${1:-status}; shift || true
case "$cmd" in
  status) status "${1:-}" ;;
  log) fetch; bash deploy/log.sh ;;
  plan)
    s=${1:?server}; shift; fetch; apply "$s" "$@"
    echo "OK: these can go to $s. Nothing was deployed (deploy/ship.sh deploy $s $*)."
    git -C "$SHIP/$s" reset -q --hard "origin/$(branch_of "$s")" ;;
  deploy)
    s=${1:?server}; shift; fetch
    before=$(git rev-parse "origin/$(branch_of "$s")")
    apply "$s" "$@"
    push_and_deploy "$s" "$before" ;;
  revert)
    s=${1:?server}; shift; fetch
    dir=$(worktree "$s"); before=$(git -C "$dir" rev-parse HEAD)
    for c in "$@"; do
      # The commit on this server's line that carries the change (its cherry-pick).
      onto=$(git -C "$dir" log --format=%H --grep="cherry picked from commit $(git rev-parse "$c")" HEAD | head -1)
      [ -n "$onto" ] || onto=$(git rev-parse "$c")
      git -C "$dir" revert --no-edit "$onto" >/dev/null || { git -C "$dir" revert --abort; die "can't undo $c alone on $s: later changes depend on it"; }
      echo "✓ undone on $s: $(git log -1 --format='%h %s' "$c")"
    done
    push_and_deploy "$s" "$before" ;;
  redeploy)
    s=${1:?server}; fetch; worktree "$s" >/dev/null
    FORCE_APPS=${FORCE_APPS:-web} push_and_deploy "$s" "$(git rev-parse "origin/$(branch_of "$s")")" ;;
  *) sed -n '2,17p' "$0"; exit 1 ;;
esac
