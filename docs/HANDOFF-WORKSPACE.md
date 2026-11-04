# Handoff: IOTx Workspace (Calendar, Tasks, Chat, Meet)

This chat owns the Workspace apps from now on. Another chat owns the AI Builder (`web/`). Read this file fully before doing anything.

## The product, in one paragraph
IOTx Suite is a business suite for Indian companies (the brand is configurable per client in Settings → Branding). The main app, `web/` (Next.js 16, Prisma 7 + Postgres, Auth.js), provides:
- the suite shell: sidebar, top bar, nine-dot launcher and one notification bell;
- roles and permissions, with a feature switch for each app;
- Mail, Google Docs/Sheets/Slides, the AI Builder and AI Chat.

**Calendar, Tasks, Chat and Meet** are a separate Next.js app, `apps/workspace` (basePath `/workspace`, port 3100, its own database `iotx_workspace`). To users they must look like modules of the suite, never like another app: same sidebar and top bar, no "Workspace" wording anywhere.

## What the user decided (don't change without asking)
- **Calendar** is our own, with two-way Google Calendar sync for people who connect Google.
- **Meet and Chat are entirely our own.** Meet runs on LiveKit (open source, self-hosted). People outside the company join meetings as guests through a link, with a waiting room, like Zoom.
- **Recording and AI notes are a permission:** hosts only for now (switches `meetings.record`, `meetings.ai_notes`).
- **Outlook sync is on hold.**
- **Calendar must be "highly intelligent".** It has AI quick add, best-time finding, an Ask panel, a daily brief, conflicts, meeting prep and Plan my day; keep improving it.
- **Never deploy to the live server (imbspectral.online) until the user has tested locally and said "approved".**

## Where things are
- `apps/workspace/src/lib`: auth (single sign-on via the suite's pass), calendar, rrule, google (sync), tasks, chat, notify, cal-smart, cal-ai, meet/*.
- `apps/workspace/src/components/suite/*`: copies of the suite shell (Frame, Shell, Launcher…). The table of files to keep in step with `web/` is in `docs/WORKSPACE-STATUS.md`.
- **Suite server-to-server routes** (header `x-iotx-key` = `IOTX_SERVICE_KEY`):
  - `web/src/app/api/iotx/{pass,verify,shell,notify,context,google-token}`.
- **Manifests** (switches): `web/src/lib/iotx/manifests/{calendar,tasks,teamchat,meetings}.ts`. The sidebar list is `SIDEBAR_APPS` in `manifests/index.ts`.
- **LiveKit (local Docker):** `iotx-livekit`, `iotx-meet-egress`, `iotx-meet-redis`. Production steps are in `apps/workspace/livekit/README.md`.
- **Status and history:** `docs/WORKSPACE-STATUS.md` (milestones 1–6) and `docs/WORKLOG.md`.

## Running it locally (Windows)
- **Docker Desktop must be running.** Containers: `forge-postgres` (127.0.0.1:15433, postgres/postgres) and the LiveKit trio. The docker CLI is `"C:/Program Files/Docker/Docker/resources/bin/docker.exe"`; Git Bash needs `MSYS_NO_PATHCONV=1`.
- **Start the suite** from PowerShell: `Start-Process cmd.exe -ArgumentList '/c',"cd /d D:\ImbSpectral\REA-V1\web && set AUTH_TRUST_HOST=true&& npm start >> .logs\server.log 2>&1" -WindowStyle Hidden` (no space before `&&`).
  - `WORKSPACE_DEV_PROXY` in `web/.env` makes `http://localhost:3000/workspace/*` reach port 3100.
- **Start Workspace** the same way from `apps\workspace`.
- **Stop either:** find the port owner (`Get-NetTCPConnection -LocalPort 3100 -State Listen`) and run `taskkill /PID <pid> /T /F`.
- **Rebuild** with `npm run build` after changes.
- **Coordinate:** the Builder chat also rebuilds `web/`. Only edit the `web/` files listed above, re-read them right before editing, and don't run a `web` build while another is running.
- **Sign in locally:** `http://localhost:3000/api/dev-login?token=<DEV_LOGIN_TOKEN from web/.env>`.
  - Test session tokens are in `web/.logs/test-users.json`; the dev session token for scripts is `839ad638-6bc1-4e43-a833-2b2bbc7cd74c`.
- **Tests:** `apps/workspace/scripts/test-*.mts` (calendar, google, tasks, chat, suite-shell, cal-ai, meet; 407 checks at last run). Run them as `npx tsx scripts/test-<name>.mts <devToken> <web/.logs/test-users.json>`.

## Rules
- **Never print or copy secrets** (anything in `.env` files).
- **Coding:** use the Write and Edit tools for code; long bash heredocs and `node -e` with quotes break in this shell. Type-check with `npx tsc --noEmit -p .`.
- **Playwright:** use only the standard tools (navigate, click, type, snapshot, screenshot), never `browser_run_code_unsafe`. That browser may be signed in to the user's real account on imbspectral.online; work on localhost only.
- **Every reply** to the user ends with a short parity note: Builder vs Lovable 86.1% counted, ~89% weighted, ~90% output (the Builder chat updates these numbers).

## Open items for Workspace (from the last reports)
- In-meeting chat isn't saved; no co-hosts; no recording retention or cleanup; guests can't see notes; notes over ~2 h need the audio split.
- The suite's own Ctrl+K search doesn't include events, tasks or messages.
- Mail results in meeting prep link to /mail, not to the message.
- The phone drawer shadow leaks on suite pages (web `iotx.css`).
- **Production deploy (only after "approved"):**
  - Workspace service and Caddy route (already live for Calendar, Tasks and Chat as of 2026-10-27);
  - the LiveKit containers with firewall 7881/tcp and 7882/udp;
  - `prisma db push` on the server for the new tables.
