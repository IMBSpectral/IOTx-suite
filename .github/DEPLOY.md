# Deployment

## How this fits with `deploy/ship.sh`

`ship.sh` is the source of truth for *what* goes to *which* server. Every
server runs its own release line, `release/<name>`, and only the changes
chosen for it are on that line, so servers can differ on purpose.

GitHub Actions does not change that. It does the last step — package, copy,
build, check — and gives it a visible run. **Pushing `main` deploys
nothing.** A deploy happens when a release line moves:

```bash
deploy/ship.sh status                      # what is live where, what is pending
deploy/ship.sh plan   <server> <change…>   # try it, deploy nothing
deploy/ship.sh deploy <server> <change…>   # move the line → Actions ships it
```

A change is a commit on `main`, by short hash, as `status` prints it.

You can also ship by hand from the Actions tab (**Deploy → Run workflow**),
naming the server and which apps to send.

## Servers

From `deploy/servers.conf` — one line each, and the workflow reads it, so
adding a server needs no change here:

| Name | Host | URL |
|---|---|---|
| `imbspectral` | DigitalOcean | https://imbspectral.online |
| `iforge` | DigitalOcean | https://iforge.online |
| `imbpraxintel` | Hostinger VPS | https://imbpraxintel.in |

Each runs two Next apps behind one Caddy origin:

| App | Path | Port | systemd unit |
|---|---|---|---|
| `web/` (suite) | `/` | 3000 | `iotx` |
| `apps/workspace/` (calendar, tasks, chat, meet) | `/workspace` | 3100 | `iotx-workspace` |

Postgres 17 runs in Docker bound to `127.0.0.1`, with the `forge` and
`iotx_workspace` databases. Caddy terminates TLS on demand.

## Why a bad commit cannot take a site down

The workflow only copies a tarball and runs `deploy/remote-deploy.sh` on the
server. **The build happens there**, into `<app>.staging`, while the live
release keeps serving. The directories swap only if the build succeeded, so a
broken commit fails the run and leaves the site untouched.

The previous release stays at `/opt/iotx/<app>.prev` and the five most recent
backup tarballs are kept, so a rollback is a directory swap, not a rebuild.

## Required secrets

The deploy job skips with a warning — it does not fail — until both exist:

| Secret | Value |
|---|---|
| `SHIP_SSH_KEY` | private deploy key, in full, including header and footer lines. Must be authorised on every server in `servers.conf` |
| `SHIP_KNOWN_HOSTS` | `ssh-keyscan -t ed25519,rsa <host>` for each server, concatenated, so connections are verified rather than blindly trusted |

```bash
R=IMBSpectral/IOTx-suite
gh secret set SHIP_SSH_KEY -R "$R" < ~/.ssh/<deploy-key>
for h in 139.59.6.116 139.59.9.18 189.72.159.25; do ssh-keyscan -t ed25519,rsa "$h"; done \
  | gh secret set SHIP_KNOWN_HOSTS -R "$R"
```

`ship.sh` uses `~/.ssh/iotx_do` by default (`SHIP_SSH_KEY` env var overrides
it). Use the same key here so local and CI deploys behave identically.

### This repository is public

The deploy job runs only on `push` to `release/*` and on `workflow_dispatch`
— never `pull_request` — so a fork cannot open a PR that runs with the key in
scope. Keep it that way. If a `pull_request` trigger is ever added, move the
credential-holding job into a separate workflow first.

## Server-side settings

`deploy/provision-instance.sh <domain> <admin-email>` prepares a blank Ubuntu
box: Node 22, Docker, Caddy, Postgres, both `.env` files with fresh secrets,
both systemd units, and the Caddy site. It is safe to re-run — existing
secrets, databases and settings are kept.

Those `.env` files are **not** in git and a deploy never overwrites them:
`remote-deploy.sh` copies them into each new release. AI keys
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) are added to them by hand after
provisioning.

### Where the public site is served

`apps/site` (the marketing page) always runs on `:3200`. What reaches it is a
provisioning choice:

| `SITE_ON_WWW` | `www.<domain>` | `<domain>` |
| --- | --- | --- |
| `off` (default) | redirects to the apex | the suite |
| `on` | the marketing site | the suite |

Pass it when provisioning: `SITE_ON_WWW=on bash deploy/provision-instance.sh …`.
**imbpraxintel.in runs with `on`.** The site's "Sign in" links come from
`NEXT_PUBLIC_APP_URL` in `/opt/iotx/site/.env`, which must be the suite's
origin; `deploy/smoke.sh` checks that those links actually point there.

Serving the site at the *apex* instead would need more than a Caddy change:
`web/src/app/api/tls-check/route.ts` only authorises a certificate for the
apex, `www`, and subdomains that match a project, so the suite's new hostname
(`app.<domain>`) would be refused one until it is added there.

## CI

`ci.yml` runs on pushes and pull requests: `npm ci`, `prisma generate`, then
`tsc --noEmit` for both apps. It uses no secrets, so it is safe on fork PRs.
Lint runs but is advisory (`continue-on-error`) — tighten that once the
existing warnings are cleared.
