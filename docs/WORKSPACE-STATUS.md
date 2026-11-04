# IOTx Workspace status

## Milestone 1: Calendar + Google sync (done, 2026-10-27)
- App: apps/workspace (Next 16.4.2, Prisma 7.10.1 + adapter-pg, basePath /workspace, port 3100, DB iotx_workspace on forge-postgres).
- SSO via suite pass (app=calendar|tasks|teamchat) -> /workspace/auth/callback -> POST /workspace/api/auth/session (verified with suite /api/iotx/verify) -> httpOnly cookie iotx_ws_session (path /workspace). Data scoped by suite workspace id.
- Calendar: day/week/month/agenda, click/drag to create, drag to move/resize, month drag, RRULE (daily/weekly days/monthly/yearly, this/all edits and deletes), all-day, time zones (UTC stored, wall-clock expansion), reminders -> in-app bell, colours, My calendar + team calendars, invites with Yes/No/Maybe, external guests, Find a time, Join button (Meet/Zoom/Teams).
- Google two-way sync: token from suite POST /api/iotx/google-token (x-iotx-key); full import -92d..+366d then syncToken increments (410 -> full), push on create/edit/delete, googleId kept, latest change wins, 60s poll for people who opened Calendar in last 15 min + on page load.
- Tests: scripts/test-calendar.mts 60/60 PASS; scripts/test-google.mts 35/35 PASS (mock Calendar API on :4800).
- Left: Tasks, Chat; suite bell integration; email invites.

## Milestone 2: Tasks (done, 2026-10-27)
- Projects with members (creator/owner manages members, archive), list (grouped by status) and board (Kanban, drag between columns and reorder) views, My tasks across projects.
- Task: assignee, due date, priority, status, labels, subtasks, checklist, links, comments; overdue flagged; due dates on the Calendar as all-day items; assignment and comments notify (bell).
- Switches: tasks.open, tasks.project.create, tasks.create, tasks.assign, tasks.delete (risky, off for Members by default).
- Tests: scripts/test-tasks.mts 37/37 PASS.
- Left: Chat.

## Milestone 3: Chat (done, 2026-10-27)
- Team Chat (suite app id "teamchat"; "chat" stays the AI Chat): public/private channels (#general auto-joined), DMs (one per pair), threads, @mentions (notify), emoji reactions, edit/delete own, pins, links, unread + mention counts, search, "Make this a task" (links back both ways), "Summarize this thread" (claude-haiku-5-5, max_tokens 2000).
- Real time: SSE GET /workspace/api/stream (heartbeat every 20s, x-accel-buffering: no) + POST to send; in-process bus (single instance).
- Tests: scripts/test-chat.mts 61/61 PASS (includes a live Claude summary call).
- Full run: calendar 60/60, google 35/35, tasks 37/37, chat 61/61 = 193/193. Web regressions: test-cycle37 60/60, test-cycle41 13/13.
- Left: suite bell integration, email invites for external guests, Meet (out of scope), multi-instance SSE (needs Redis/pg LISTEN), people list only shows people who have opened Workspace.

## Milestone 4: Calendar, Tasks and Chat as suite modules (done, 2026-10-27)
People never see "Workspace" now. Calendar, Tasks and Chat open inside the suite's own shell:
- the sidebar: Home, New chat, Recent chats, Apps and the user footer;
- the top bar: search, the nine-dot launcher, theme, bell and avatar;
- the person's theme, accent and background, with the right app highlighted.

The old Workspace brand bar, top bar and left nav are gone. The apps are still a separate process (port 3100, basePath /workspace) with their own database (iotx_workspace).

**How it works**
- **Pages:** every page (`src/app/{calendar,tasks,chat}/page.tsx`) calls `boot()` and renders `<Frame>` (`src/lib/page.tsx`).
  - `Frame` first writes the account's theme and palette for the before-paint script.
  - It then renders `components/suite/SuiteFrame`: brand, permissions, the launcher (Ctrl+J), search (Ctrl+K), appearance sync and the shell.
- **Shell data** comes from the suite: `GET /api/iotx/shell?userId=&ws=` with `x-iotx-key` (`src/lib/suite.ts`, cached 10 s per person). It returns:
  - `shellData()`: user, perms, appearance, workspace(s), recent chats;
  - `paint` and `brand`;
  - `apps`: only the apps the person can open;
  - `sidebar`: the suite's `SIDEBAR_APPS`.

  If the suite can't be reached, a stand-in shell keeps the page usable.
- **Links:** suite pages are `${SUITE_PUBLIC_URL}/…` ("" in production, http://localhost:3000 locally). Calendar, Tasks and Chat links stay `/workspace/…`.
- **Theme menu:** `POST /workspace/api/suite/appearance`, which calls the suite's `POST /api/iotx/shell` to save it to the account.
- **One bell:**
  - Workspace's `notify()` still writes its own row (for once-only reminder keys and the live stream). It also posts to the suite's `POST /api/iotx/notify` with a `/workspace/…` href.
  - The suite bell (web) shows it.
  - On Calendar, Tasks and Chat pages, the copied bell reads and marks the suite's notifications through `/workspace/api/suite/notifications`, and refreshes as soon as the live stream reports a new one.
- **Search** (Ctrl+K, top bar): `GET /workspace/api/search?q=` returns events, tasks and messages, plus "Ask IOTx", which opens AI Chat with the question.
- **Suite side (web):**
  - New routes `/api/iotx/shell`, `/api/iotx/notify` and `/api/iotx/context`, with `lib/iotx/service-key.ts` for the timing-safe key check.
  - `shellData(userId, workspaceId?)`: the workspace argument is new and optional.
  - `SIDEBAR_APPS` moved to `lib/iotx/manifests/index.ts` and now includes teamchat, calendar and tasks.
  - The teamchat manifest is now named "Chat".
  - Shell, Launcher, AppTile and NotificationsBell use plain links (full page loads) for /workspace hrefs. Clicking a notification also marks it read.
- **Tasks:** the project list is now a "My tasks ▾" menu on the toolbar.
- **Chat:** the channel list is part of the chat content, like Mail's folders. On phones it opens from the channel name.
- **Local dev:**
  - Web proxies `/workspace*` to :3100 when `WORKSPACE_DEV_PROXY=http://localhost:3100` is set at build time (`rewrites` in next.config.ts). It's unset in production, where Caddy does this.
  - `WORKSPACE_PUBLIC_URL=http://localhost:3000` (workspace .env), and `WORKSPACE_ORIGIN` now includes http://localhost:3000 (web .env), so local sign-in stays on :3000 as it does live.

**Copied from web: keep these in step**

| apps/workspace file | copy of (web) | differences |
|---|---|---|
| src/app/iotx.css | src/app/iotx.css | none (verbatim) |
| src/lib/suite-appearance.ts | src/lib/iotx/appearance.ts | none (verbatim) |
| src/components/suite/PermsProvider.tsx | src/components/iotx/PermsProvider.tsx | none |
| src/components/suite/icons.tsx | src/components/iotx/icons.tsx | BrandMark import path |
| src/components/suite/AppearanceSync.tsx | src/components/iotx/AppearanceSync.tsx | import path |
| src/components/suite/appearance-client.ts | src/components/iotx/appearance-client.ts | saves through /workspace/api/suite/appearance; no upload or startBuild |
| src/components/suite/BrandProvider.tsx | src/components/BrandProvider.tsx | brand comes from /api/iotx/shell |
| src/components/suite/Shell.tsx | src/components/iotx/Shell.tsx | the page canvas inside a suite tab (background + content); appearance import path |
| src/app/layout.tsx (THEME_SCRIPT, fonts) | src/app/layout.tsx | verbatim script; same Geist, Geist Mono and Instrument Serif fonts |
| tokens at the top of src/app/globals.css | src/app/globals.css | --shell, accents and the dark variant |

When web changes any of these, copy the change, keep the listed differences, and rebuild apps/workspace.

**2026-10-29: the slim app bar.** The suite became Google-style: a start page at /home, and every app in its own browser tab under one thin bar. Calendar, Tasks, Chat and Meet now render under that bar (`SuiteFrame` → `Shell`): the app's icon and name, search (Ctrl+K), the nine-dot launcher (other apps open in new tabs; the same tab on phones, where the bar has a back arrow to Home), the bell and the avatar menu (account, theme and accent, settings, workspaces, sign out). There's no suite sidebar any more, so the app has the whole page. Chat's unread count shows on the launcher button and its tile. `Frame`/`SuiteFrame` accept `active="meetings"`. `iotx.css` and `icons.tsx` were re-copied (new: back, people and clock icons; `.ix-appbar`, `.ix-badge`, `.ix-only-phone`, start page classes; `.ix-root` is now 100% high). Chat's GuestFrame is unchanged.

**2026-10-29: the suite is a browser.** The suite's top window is now a browser frame (web `components/iotx/browser`): a tab strip, a toolbar with back/forward/reload and an address bar, bell, launcher and avatar, and the apps in a left sidebar. Every page, Calendar, Tasks, Chat and Meet included, shows in a tab: a same-origin iframe.
- **Inside a tab** (`Sec-Fetch-Dest: iframe`) a Workspace page has no chrome: `SuiteFrame` renders permissions, brand, appearance and `Shell` (now just the page canvas with the account background). The copied Launcher, SearchPalette and NotificationsBell were removed (the frame has them); Ctrl+J/Ctrl+K pressed in a page reach the frame.
- **Opened on its own** (a bookmark, a shared link, or a refresh while a Workspace tab is active), `boot()` (`lib/page.tsx`) returns a tiny script that replaces the page with the suite's `/tab?u=<path+query+hash>`; the frame opens it as a tab and puts the Workspace URL back in the address bar. I chose this over a second copy of the frame: one implementation (web), and the address stays the Workspace URL. `SuiteFrame` does the same in the browser when the header is missing. Guests are never sent there: GuestFrame is unchanged.
- **Framing:** `next.config.ts` sends `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'` for /calendar, /tasks, /chat and /meet (public /embed, /book and /rsvp are untouched).

**Tests:** scripts/test-suite-shell.mts 60/60. It covers:
- the shell endpoint's key check and data shape;
- Calendar, Tasks, Chat and Meet pages inside a suite tab: no bar, sidebar or launcher of their own, no "Workspace" text, same-origin framing only; opened on their own they go to the suite's /tab?u=…;
- saving the theme;
- notify and the bell in both directions, including a Calendar invite reaching the invitee's suite bell;
- context limited to the person's own mailboxes;
- search.

## Milestone 5: Intelligent Calendar (done, 2026-10-27)
An AI layer on the existing calendar:
- **Models:** Claude Haiku 5.5 (max_tokens 2000, JSON-schema output) parses; Claude Sonnet 5.5 plans and uses tools.
- **Confirm first:** nothing is written without a confirm click. `POST /calendar/ai/apply` runs a draft with the person's own permissions.
- **People:** names are matched to the workspace directory in code. Unknown names are reported, not added; ambiguous ones offer a choice.
- **Times:** a missing time is either left to the person, or picked from real free time and labelled "suggested".

Features:
- **Add with AI** (bar under the toolbar, `POST /calendar/ai/quick`):
  - Understands requests like "Review with Priya and Ravi Friday 3pm for 45 min at Pune office, add a Meet link", "every Monday 10am" and "tomorrow after lunch", relative dates, and the person's time zone.
  - Shows a confirmation card: when, guests, place, repeat, a video link field, clashes and notes.
  - Buttons: Create, Edit details (opens the full event form) and Cancel.
- **Best time** (same bar, for example "Find the best time for me, Priya and Ravi next week, 1 hour"):
  - `findSlots` (`lib/cal-smart.ts`) checks everyone's busy time: their calendars, accepted and pending invites, and Google-synced events.
  - It respects each person's working hours (default 09:30–18:30 Mon–Sat, set in Calendars menu → Working hours), lunch and buffers.
  - It returns the 3 best slots, spread over days, each with a reason. Book in one click.
- **Ask Calendar** (Assistant → Ask, `POST /calendar/ai/ask`): Sonnet with list_events, find_free_time, create_event, update_event and delete_event. The write tools only return drafts, shown as cards with Confirm and Dismiss.
- **Daily brief** (Assistant → Today, `GET /calendar/ai/brief`; POST adds an AI headline):
  - agenda, meeting hours and free time;
  - conflicts, and focus windows with a Protect button;
  - tasks due or overdue;
  - prep notes per meeting: guests and replies, missing agenda, video link, related tasks.
- **Conflicts and overload** (`GET /calendar/ai/insights`):
  - Flags double-bookings, meetings outside working hours or on days off, back-to-back runs of 3 or more, and days with more than 5 h of meetings.
  - The suggested fix is a free slot for the event and its guests, applied with one click.
  - The toolbar shows "N issues" for the visible range.
- **Meeting prep** (Prepare on an event or in the agenda, `POST /calendar/ai/prep`):
  - guests and related open tasks;
  - related emails from the suite's Mail through `POST /api/iotx/context`, which searches only the person's own and assigned mailboxes and returns subject, from, date and snippet;
  - a 3-bullet briefing.
- **Plan my day** (Assistant → Today, `POST /calendar/ai/plan`):
  - Sonnet orders and sizes the open tasks; code places them in free working time, clear of meetings, buffers and lunch.
  - The blocks show as dashed tentative events, with Accept, Accept all and Dismiss.

Schema: `User.workHours Json?` (additive, applied with db push).

Tests: scripts/test-cal-ai.mts 57/57.
- 55 run against a mock Messages API on :4801, with a second server on :3101 started with ANTHROPIC_BASE_URL.
- 2 are LIVE: quick add with Haiku, and Ask with Sonnet and tools.

Full run, 2026-10-27: 305/305. Web test-cycle37: 60/60.

| Suite | Result |
|---|---|
| calendar | 60/60 |
| google | 35/35 |
| tasks | 37/37 |
| chat | 61/61 |
| suite-shell | 55/55 |
| cal-ai | 57/57 |

Left:
- The video link isn't generated; people paste it. The Meet session will add a toggle to the event form.
- Web's own Ctrl+K search on suite pages doesn't include events, tasks or messages yet.
- Mail results link to /mail, not to the message itself.

## Milestone 6: Meet, video meetings on self-hosted LiveKit (built locally, 2026-10-28; not deployed)

**Infrastructure:** LiveKit 1.13.10, Egress 1.15.0 and Redis 7.4.1 run in Docker. See `apps/workspace/livekit/README.md` for the local commands and the production steps.
- The key pair is only in `.env` and the git-ignored `livekit/*.yaml`.
- Env: `LIVEKIT_URL`, `LIVEKIT_PUBLIC_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and `OPENAI_API_KEY` (copied from web/.env).
- Client packages, pinned: livekit-client 2.22.4, @livekit/components-react 2.9.24, @livekit/components-styles 1.2.0.
- Server package: livekit-server-sdk 2.19.1. Tests also use @livekit/rtc-node 1.1.0 (a dev dependency).

**Data:** Prisma models `Meeting`, `MeetParticipant` and `MeetRecording` (additive, applied with db push).
- `Meeting` has a code like `abc-defg-hij`, a host, and an optional event, channel and message.
- Settings: waitingRoom, allowGuests, muteOnEntry, locked.
- It also holds the invitees and the AI notes fields.

**Server:** `src/lib/meet/{livekit,meetings,recording,notes}.ts` and `src/app/api/meet/**`.
- **Create and get:** `POST /api/meet` creates a meeting; `GET /api/meet` lists mine plus calendar events with Meet links.
- **Meeting:** `GET /api/meet/<code>` is public, and the host gets extra fields. `PATCH` changes settings.
- **Join:** `POST /api/meet/<code>/join`.
  - Members of the meeting's workspace join with their session.
  - Guests send a name and get a secret key; only its sha256 is stored. They are held in "waiting" until a host admits them, unless the waiting room is off.
- **Waiting room:** `GET|POST /api/meet/<code>/lobby` (host): admit, deny, admit all.
- **Host controls:** `POST /api/meet/<code>/control` (host only) runs mute_all, mute, remove, lock, unlock and end through LiveKit's RoomServiceClient. A removed person can't rejoin.
- **Raise hand:** `POST /api/meet/<code>/hand` sets a participant attribute.
- **Tokens:** AccessToken with roomJoin, publish, subscribe and data, a 15-minute TTL, and the role in metadata. No token ever carries roomAdmin or roomRecord, and canUpdateOwnMetadata is false.
- **Meeting started:** when the first person joins, invitees, event attendees and the host get a "meeting started" notification through `notify()` (so the suite bell shows it too).
- **Recording** (`POST /api/meet/<code>/record`, host plus `meetings.record`): an Egress room composite (grid) saved as MP4 under `storage/meet-recordings`. Room metadata `{recording}` drives the notice everyone sees.
- **AI notes** (host plus `meetings.ai_notes`):
  - An audio-only Egress records OGG/Opus at 32 kbps.
  - When AI notes stop (or the meeting ends), the OGG is transcribed with OpenAI `gpt-4o-transcribe` (falling back to `whisper-1`).
  - Claude Sonnet 5.5 (`output_config` JSON schema, `fallbacks: "default"`) writes the summary, decisions and action items.
  - The host is notified when the notes are ready.
  - `POST /notes` with `tasks` makes tasks in a project the host picks, or in "Meeting follow-ups", matching owners to project members. `post` puts the notes in the meeting's chat thread or a channel the host picks. `regenerate` writes them again.
- **Webhook and downloads:** `POST /api/meet/webhook` takes signed LiveKit webhooks and keeps recordings in step; Meet also polls Egress. `GET /api/meet/<code>/recordings/<id>` downloads a file (host, invitees and members who joined).

**UI:** `src/app/meet` has its own layout.
- **Landing page:** `/workspace/meet` is inside the suite shell (`Frame`). It has New meeting, Join with a code or link, upcoming meetings from Calendar, and recent meetings with links to their notes.
- **Meeting room:** `/workspace/meet/<code>` is full screen and dark. It goes through three steps:
  - **Pre-join:** camera preview, a mic level meter, camera, mic and speaker pickers, and a name field for guests ("Sign in instead" uses the suite pass with app=meetings).
  - **Waiting room:** guests' browsers check back every 2.5 s.
  - **Room:** grid and speaker layouts (speaker view is automatic while someone shares a screen), screen share, mute and camera, device menus, raise hand, emoji reactions (data channel), in-meeting chat (LiveKit chat), and a people panel with host mute and remove. Hosts also get the waiting room with Admit, Deny and Admit all, plus pop-up admit prompts. The room shows connection quality, a timer, the Recording and AI notes pills plus a pop-up for everyone, and a host menu: mute all, lock, waiting room on or off, guests on or off, record, AI notes.
  - Leaving: hosts choose Leave or End for all. The page tells people when they were removed, the meeting ended or they were disconnected.
  - Phone layout: the panels go full screen and the controls wrap.
- **Notes page:** `/workspace/meet/<code>/notes` is in the shell. It shows the summary, decisions and action items (pick which become tasks), Post to chat, the transcript (host only), and recordings to download.

**Links to the rest of the suite:**
- **Calendar:** the event form has "Add video meeting". `POST` and `PATCH /api/calendar/events` accept `videoMeeting: true`, which creates a meeting (invitees are the attendees), sets `conferenceUrl` to `<origin>/workspace/meet/<code>` and links the event. The Join button says "IOTx Meet". Saving again keeps the same meeting.
- **Chat:** a "Start a call" button in the channel or DM header (`components/meet/StartCallButton`, `POST /api/meet/call`) creates a members-only meeting for the channel's members and posts "📹 X started a call" with the link. The notes later go into that message's thread.
- **Suite manifest:** `web/src/lib/iotx/manifests/meetings.ts` is now live, with href `/workspace/meet` and the switches `meetings.create`, `meetings.guests`, `meetings.record` and `meetings.ai_notes`. Record and AI notes are on for Owner and Admin by default. The keys must start with the app id, so they are `meetings.*`, not `meet.*`. `apps/workspace/src/lib/auth.ts` asks for these keys, and the app id `meetings` was added for pass sign-in.

**Tests:** `scripts/test-meet.mts` 102/102. It covers:
- create and get a meeting;
- member, host and guest tokens and their grants;
- the waiting room, admit, deny, lock, remove, auto-admit, members-only meetings and other organizations;
- host-only controls refused for members and guests;
- the record and AI-notes permissions;
- a **real WebRTC participant** (rtc-node) publishing spoken audio and a camera while Egress records an MP4 and the notes OGG;
- live OpenAI transcription and Claude notes, with tasks and the chat post;
- the calendar's video meeting, the start notification, chat's Start a call, End for all and webhook signatures.

Regressions: calendar 60/60, google 35/35, tasks 37/37, chat 61/61, suite-shell 55/55, cal-ai 57/57. The total is 407/407.

**Left:**
- Production deployment (steps in livekit/README.md).
- Recordings over about 2 h of audio exceed the 25 MB transcription limit; long meetings would need chunking.
- In-meeting chat isn't saved.
- No co-hosts: only the creator is host.
- No TURN server yet, so guests behind strict firewalls rely on ICE over TCP on 7881.
- Recordings stay on local disk, with no retention or cleanup.
- Guests can't see the notes.
