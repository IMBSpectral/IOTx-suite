# IOTx Suite: ecosystem shell and permissions

IOTx Suite is one home for every IOTx app. It grows out of the existing Builder (`web/`, "Forge"): the
platform (accounts, workspaces, organizations, roles, billing, audit, AI) lives there, and the other apps
(`apps/sheets`, `apps/tally`, `suite/wordcraft`, `suite/deckcraft`) will mount under paths on the same
domain and receive a short-lived signed pass. The approved design is `docs/design/iotx-shell.html`.

## Architecture

```
web/  (Next.js 16, Auth.js database sessions, Prisma + Postgres)
├─ IOTx Suite platform
│   ├─ lib/iotx/manifests/*.ts     one manifest per app: features, groups, risk, plan, limits, scopes
│   ├─ lib/iotx/roles.ts           built-in role defaults + role templates (pure, client-safe)
│   ├─ lib/iotx/permissions.ts     can() / limit() / appsFor() / requirePerm(), role admin, audit
│   ├─ lib/iotx/pass.ts            short-lived JWT pass for apps under the domain
│   ├─ lib/iotx/appearance.ts      theme, presets + custom accent (contrast-checked), background
│   └─ lib/iotx/shell.ts           per-request shell data (user, workspace, perms, appearance, chats)
├─ IOTx Suite shell (components/iotx)
│   ├─ Shell.tsx                   start page's slim sidebar + top bar; inside an app, just the canvas
│   ├─ StartPage.tsx               Google-style Home: search everything / Ask AI, app grid, Recent
│   ├─ AppBar.tsx                  the slim bar inside every app (layout); TopActions.tsx: launcher, bell, avatar menu
│   ├─ search.ts                   "search everything" (start page and Ctrl+K)
│   ├─ Launcher.tsx                nine-dot launcher (Ctrl+J anywhere); apps open in their own tab (same tab on phones)
│   ├─ HomeView.tsx                the 2-in-1 AskBox (Chat | Plan | Build), used by AI Chat
│   ├─ ChatView.tsx                AI Chat (the workspace assistant) inside the shell
│   ├─ RolesAdmin.tsx              Roles & permissions screen generated from the manifests
│   ├─ ComingSoon.tsx              apps not built yet
│   ├─ AppearanceSettings.tsx      Settings → Appearance
│   └─ PermsProvider.tsx           usePerms() for the client
└─ Builder (the existing Forge app): /dashboard, /projects/[id] editor, settings, APIs
```

Routes added: `/` → `/home`, `/home` (landing after sign-in), `/home/chat`, `/apps/[app]` (Coming soon or
redirect to a live app), `/admin/roles`, `/settings/roles`, `/settings/appearance`; APIs `/api/permissions`,
`/api/iotx/pass`, `/api/iotx/verify`, `/api/account/appearance`.

Since 2026-10-29 the suite is Google-style: `/home` is a start page (search everything / Ask AI, app grid,
Recent) and every app opens in its own browser tab (the same tab on phones) under one slim app bar (app name,
Ctrl+K search, launcher, bell, avatar), mounted with the launcher, "Preview as" banner and appearance sync in
`app/(app)/layout.tsx`, so they work on every screen including the editor. The Builder keeps its own sidebar
as its inner navigation.

## Permission model

A person can do something only if **the plan includes it**, **one of their roles grants it** (roles add up),
**the app is open to them**, and **nothing denies it**. Owners always have everything their plan includes.

| Layer | Where |
|---|---|
| Plan | `Feature.plan` (FREE < PRO < BUSINESS < ENTERPRISE); locked switches show "Upgrade". |
| App access | the `<app>.open` key per role (Home is always open). Off hides the app everywhere and removes all its features. |
| Features | switches and numeric limits declared in the manifest. |
| Data scope | `PermRole.scopes` (e.g. `tally.company`, `tally.branch`), stored and shown; enforced by the apps once they join. |
| Item sharing | unchanged: project collaborators, restricted projects and folders (`lib/workspace.ts`). |

Storage (Prisma, additive): `PermRole` (built-in / template / custom; `perms` map, `limits`, `scopes`),
`PermAssignment` (role → user or role → group from Members → groups), `PermOverride` (per-person `deny` or
`grant`, optional `expiresAt`). `User.theme / accent / accentCustom / shellBg` hold appearance.

Mapping of existing memberships: OWNER → Owner, ADMIN → Admin, MEMBER → Member, VIEWER → Guest. The built-in
roles are created on first use per workspace; a key an admin never changed falls back to the manifest
default, so new features arrive with sensible defaults. Defaults keep today's behaviour: **Member has the
Builder switch and every builder feature on**; Admin has everything except `tally.period_unlock`; Guest has
Ask IOTx, AI Chat, Docs and Files; new custom roles start with Ask only (Builder off). Templates: Builder,
Accountant, Sales executive, Store keeper, Plant head, Dispatch clerk.

Evaluation rules (`permissions.ts`): a role's features count only for apps that role opens; a person-level
grant of `<app>.open` opens the app for their roles; a deny wins over everything except Owner; plan gating
and app gating apply last. Limits: the most generous value among roles that open the app (a role without a
value means no limit). Decisions are cached for 5 s on `globalThis` and dropped on every change (and on group
changes); the membership is read on every call so role changes apply at once.

Who manages roles: the Owner, plus anyone whose own roles include `admin.roles`. The Owner role can't be
edited and the owner can't be denied; built-in roles can't be deleted (they can be reset).

Every change writes a `permissions.changed` audit event; refusals write `permissions.refused` (at most once a
minute per person and key).

**Preview as**: `POST /api/permissions {action:"preview", roleId}` sets the `iotx_preview` cookie (only for
role managers). While set, the screens *and the server* act as that role; a banner offers "Exit preview".
Managing roles keeps using the real permissions, so the admin can always exit.

### API

```ts
can(userId, workspaceId, key): Promise<boolean>       // follows Preview as
limit(userId, workspaceId, key): Promise<number|null> // null = no limit
appsFor(userId, workspaceId): Promise<string[]>
requirePerm(userId, workspaceId, ...keys)              // throws a 403 Response { error, permission, code }
requireProjectPerm(userId, projectId, ...keys)
effective(userId, workspaceId)                          // everything, for passes and workers
```
Client: `usePerms()` → `{ can, opens, limit, builder, canManage, preview, roles }`.

## The Builder switch (2 in 1)

`builder.open` is the **Builder** switch. The same AI interface is used by everyone:

* **Off**: Home's prompt and AI Chat offer Chat only; the assistant has no `create_project` tool and
  `send_to_project` works in Ask mode only; in a project the composer offers Ask only ("Chat only" hint);
  the editor hides Publish, Code, Cloud, Design, Terminal, Browser, Settings; `/dashboard` sends them Home.
* **On**: Home and AI Chat add Plan and Build (Build starts a project and hands the first turn to the
  editor; Plan does the same with a Plan turn); the composer shows every mode; all builder features return,
  each subject to its own switch.

Server enforcement (refuses without the switch, whatever the UI shows):

| Key | Enforced in |
|---|---|
| `builder.project.create` | `POST /api/projects`, `/api/projects/import`, `/api/projects/[id]/duplicate`, assistant + agent `create_project` |
| `builder.project.delete` | `DELETE /api/projects/[id]`, bulk delete/purge |
| `builder.project.transfer` | project `folderId` PATCH, bulk move/transfer/moveWorkspace |
| `builder.build` | messages in build/design/goal mode, variants, undo, revert, draft accept/revert/…, automations (create/update/run/resume/webhook), MCP `send_message` build, assistant `send_to_project`, agent `switch_project` |
| `builder.plan` | messages in plan mode, MCP plan, assistant plan |
| `home.ask` | messages in ask mode, `/api/assistant` |
| `builder.visual_edit` | `/api/projects/[id]/quick-edit` |
| `builder.code.view` / `builder.code.edit` | file contents GET / file PUT, terminal, env vars, git maintenance, agent `run_command` |
| `builder.images` | image-edit; agent `generate_image` / `edit_image` |
| `builder.publish` | publish POST/PATCH/DELETE, MCP `publish_project` |
| `builder.domain.subdomain` | subdomain changes (project PATCH, publish PATCH) |
| `builder.domain.custom` (Pro plan) | custom domain PATCH |
| `builder.preview_links` | preview links POST/DELETE |
| `builder.security.override` | ignoring a security finding (what lets a publish through despite it) |
| `builder.cloud.*` | `/cloud` actions (enable → `cloud.enable`, secrets → `cloud.secrets`, policy → `cloud.rows`) and every Cloud manager action/view (`cloudKey()`): users, rows, sql/backups, storage, functions, jobs/workflows; agent cloud tools |
| `builder.connectors` / `builder.github` | connector connect/disconnect; agent `connector_request`, `http_request`, `mcp_*` |
| `builder.api_keys` | API keys admin; every MCP tool call checks the key creator's role |
| `builder.browser` | project browser actions, browser settings, agent `browser_*` |
| `builder.cloud.secrets` | workspace secrets |
| `builder.credits.monthly` (limit) | messages: refuses with 402 `limit_reached` once the person's month's spend reaches it |

Not yet enforced server-side (UI only or stored only): `home.web`, `home.deep_research`, `home.attach`,
`chat.*`, the `admin.*` keys other than `admin.roles` (existing admin routes still check OWNER/ADMIN), and every
key of apps that aren't integrated yet.

## Permission keys

Access switches: `<app>.open` for builder, docs, sheets, slides, tally, chat, mail, tasks, files, calendar,
meetings, notes, store, read, admin. Features (see `lib/iotx/manifests/*` for labels, groups, risk, plan):

* **home**: ask, web, deep_research (Business), attach
* **builder**: project.create, project.delete, project.transfer, build, plan, visual_edit, code.view, code.edit,
  images, publish, domain.subdomain, domain.custom (Pro), preview_links, security.override, cloud.enable,
  cloud.rows, cloud.sql, cloud.storage, cloud.functions, cloud.jobs, cloud.users, cloud.secrets, connectors,
  github, api_keys, browser; limit credits.monthly
* **sheets**: create, edit, comment, delete, share.internal, share.external, export, import, ai, pivot,
  scripts (Business), history.restore
* **docs**: create, edit, suggest, share.external, export, ai
* **slides**: create, edit, present, export, ai
* **tally**: company.view, company.create, masters.view/create/alter/delete, reports.daybook/trial/pl/bs/gst/stock,
  period_unlock, audit, export; limits amount_limit (INR), backdate (days); vouchers
  `tally.voucher.<sales|purchase|receipt|payment|journal|contra|credit_note|debit_note>.<create|alter|delete|approve>`;
  scopes tally.company, tally.branch
* **tasks**: board.create, create, assign, sprints, workflow, delete
* **files**: upload, share.external, delete, restricted; scope files.department
* **store**: use, install, publish
* **chat**: projects, files
* **mail**: connect, send, ai · **calendar**: create, share · **meetings**: host, record · **notes**: create, share · **read**: view, publish
* **admin**: people, roles, billing, audit, sso

Ledger and Books are not separate launcher apps: the Tally ledger (`apps/tally`) is the one accounting app for
now, with the voucher matrix under `tally.*`; Books is left out until it is integrated.

## How another app joins

1. **Manifest**: add `lib/iotx/manifests/<app>.ts` (features, groups, risk, plan, limits, scopes, vouchers)
   and list it in `manifests/index.ts`. The launcher, Home, admin screen and permission service pick it up.
   Set `status: "live"` and `href`/`mountPath` when it opens.
2. **Mount** it under a path on the one domain (`/sheets`, `/tally`, `/docs`, `/slides`), e.g. a reverse
   proxy rule or a Next rewrite, so the session cookie is shared and there are no cross-site sign-in problems.
3. **Sign in with the pass**: when there's no app session, send the browser to
   `/api/iotx/pass?app=<id>&redirect=/<app>/…`; it comes back with `#iotx_pass=<jwt>` in the fragment. Or call
   `GET /api/iotx/pass?app=<id>` from the platform side. The pass (HS256, 5 minutes, `iss: iotx-suite`,
   `aud: <app>`) carries `sub` (user id), `email`, `name`, `ws` (workspace = tenant), `plan`, `roles`, the
   person's keys for that app only, its limits and `owner`. It is signed with `IOTX_PASS_SECRET` (or a key
   derived from `AUTH_SECRET` when that isn't set).
4. **Verify and decide**: `POST /api/iotx/verify { token, app, keys: [...] }` → `{ valid, claims, decisions }`.
   Use `decisions` for live checks (a switch turned off applies before the pass expires); cache a few
   seconds. Apps that share `IOTX_PASS_SECRET` may verify locally with any JWT library.
5. **Enforce on the app's server** with the same keys; hide what the person can't use in its UI. Keep the
   workspace id on every record.

## Appearance

Settings → Appearance and the sun menu in the top bar: light / dark / system; Indigo (default), Ember, Teal,
Graphite or a **custom colour** (hover, soft and gradient partner derived from it; lightness nudged in each
theme until accent text and button text read at 4.5:1); a **background** for Home and the shell: none, a solid
colour (gets an automatic overlay when text wouldn't read), or an uploaded image (JPG/PNG/WebP, 5 MB) with dim
and blur. Saved to the account and mirrored to localStorage so the root layout applies it before first paint.

## Done / next

Done: manifests for every app, permission service with roles, templates, groups, denies, temporary grants,
limits, plan gating, Preview as, audit; Roles & permissions screen (shell and Settings); IOTx Suite shell,
Home, AI Chat, launcher, Coming soon pages, theme/appearance, phone layout; 2-in-1 Builder gating in UI and on
the server (routes, assistant, agent tools, MCP); app pass endpoints. Tests: `scripts/test-cycle37.mts`.

Next: enforce `admin.*` keys in the existing admin routes; Web search / Deep Research / attachments on Home;
SSO/SCIM group → role mapping (groups from the IdP into `PermAssignment`); integrate Tally and Sheets with the
pass and their own switches; a shared design-system package for the other apps; per-person scope values
("Assigned per person").
