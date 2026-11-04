# Platform Architecture

Target: an AI app-building platform functionally equivalent to Lovable.
Derived from black-box observation (Playwright) of the live product's routes,
UI structure and network surface. All code in this repo is an original
implementation; no third-party source or brand asset is reproduced.

## 1. Domain model

The observed API is strictly three-tier multi-tenant:

    User --< WorkspaceMembership >-- Workspace --< Project

Everything billable hangs off **Workspace**, not User. Everything buildable
hangs off **Project**.

### Workspace-scoped concerns
| Concern | Observed endpoints |
|---|---|
| Credits | `credit-balance`, `credit-limits`, `balance/auto-topup`, `auto-topup/status`, `user-monthly-usage` |
| Grants | `ai-grant-status`, `cloud-grant-status` |
| Members | `memberships/search`, project invitations |
| Integrations | `connectors/standard`, `connectors/seamless`, `connections/standard` |
| Commerce | `contract-status`, `enterprise-self-serve-offer` |
| Content | `chats`, `projects`, `inbox/summary` |
| Domains | `registrar-domains/viewer-verification-banner` |

### Project-scoped concerns
| Concern | Observed endpoints |
|---|---|
| Chat | `messages`, `chat/queue/status` |
| Source | `git/files`, `git/file`, `edits`, `drafts`, `artifacts` |
| Preview | `sandbox/url`, `trajectory/main/pages` |
| Backend | `cloud/config`, `cloud/status`, `cloud/resume`, `cloud/exhaustion/status` |
| Collab | `collaborators`, `presence`, `mark-viewed` |
| Ship | `publish-approval`, `published-access`, `gitsync` |
| Safety | `security/data`, `security/hvt-status`, `health-check-findings/brief` |
| Integrations | `integrations/ai_gateway`, `integrations/shopify`, `mcp-server-info` |

## 2. Load-bearing design decisions

**2.1 Source of truth is a git repo per project.**
`git/files` + `git/file` (not `files`) means each project is a real
repository, not a blob of rows. This buys version history, diffing, revert
and GitHub sync (`gitsync`) from one mechanism instead of four.

**2.2 Preview is an isolated origin, not an iframe of the app.**
Observed preview URL shape:

    https://id-preview--<projectId>.<preview-domain>/?token=<JWT>&sha=<contentHash>

- Per-project **subdomain** => browser origin isolation. Generated code cannot
  touch the parent app's cookies, localStorage or DOM.
- **RS256 JWT**, 24h TTL, claims `{user_id, project_id, access_type:"project",
  aud:["app"]}` => preview access is authorized independently of the session.
- **Content SHA** in the query => cache-bust per build, so a rebuild is a new
  immutable URL.

This is the single most important thing to copy. Serving generated code from
the main origin would be a stored-XSS factory.

**2.3 Generated backends are provisioned, metered and suspended.**
The `cloud/*` lifecycle (`config` -> `status` -> `exhaustion/status` ->
`resume`) says each project's backend sleeps when idle and is explicitly
resumed. Cost control is in the architecture, not bolted on.

**2.4 Generation is a queued job, not a request.**
`chat/queue/status` is polled separately from `messages`. A build can outlive
an HTTP request, survive a page reload and be observed from another tab.

**2.5 Generated apps are scanned before they ship.**
`security/data`, `security/hvt-status` and `health-check-findings/brief` gate
`publish-approval`. An LLM writing the code means auth bugs and leaked keys
are expected failure modes, so review is a pipeline stage.

**2.6 Mixed transport.**
Most routes are REST; some are Connect-RPC
(`<pkg>.v1.<Service>/<Method>`, POST). Newer services are schema-first.

## 3. Our stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js 15 App Router + TS | One deployable for UI + API |
| DB | Postgres + Prisma | Relational multi-tenancy |
| Auth | Auth.js — Google, GitHub, email | Matches observed providers |
| Source | isomorphic-git on disk | Real git, no binary dependency |
| Codegen | Anthropic SDK (streaming, tools) | Tool-calls map to file writes |
| Jobs | Postgres-backed queue | No Redis dependency |
| Preview | esbuild + per-project subdomain + JWT | Mirrors 2.2 without Docker |
| Realtime | SSE | Chat stream + presence; no WS server |

Docker is unavailable on this host, so the preview sandbox bundles with
esbuild in-process and serves to an isolated origin, rather than running a
container per project.

## 4. Route map (ours, mirroring observed IA)

    /login  /signup
    /dashboard                 hero composer + project tabs
    /dashboard/projects        full grid, scope filter
    /chats                     cross-project chat history
    /projects/:id              editor: chat | Preview/Files/Code/More
    /@:handle                  public profile
    /settings/*                account, workspace, billing, domains
    /pricing
