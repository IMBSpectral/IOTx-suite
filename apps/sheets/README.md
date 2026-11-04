# Spectral Sheets

A browser spreadsheet for the Spectral Suite. The calculation engine is IMB Gridly
(`../../suite/gridcraft`), compiled to WebAssembly and run in a Web Worker. The page paints a
canvas grid and never holds the workbook.

```
web/ (Vite + TypeScript)                       engine-wasm/ (Rust → WASM)
┌─────────────────────────────┐  postMessage   ┌──────────────────────────────┐
│ canvas grid (visible window)│ ─────────────► │ SheetsEngine                 │
│ hidden <textarea> = keyboard│  viewport /    │  └ imbgridly Session         │
│ formula bar, tabs, toolbar  │  execute(cmd)  │     (313 commands, calc,     │
│                             │ ◄───────────── │      XLSX/ODS/CSV I/O)       │
└─────────────────────────────┘  cells+styles  └──────────────────────────────┘
```

- gridcraft is consumed **read-only** through a path dependency; nothing in `suite/` is modified.
- Every user action is an engine command (`cell.set`, `home.bold`, `edit.undo`, `sheet.activate`…),
  the same ids the desktop app, CLI and MCP use.

## Collaboration (`server/`)

Every edit is an engine command, so collaboration shares **commands**, not cell values:

1. A browser applies its own edit at once (a `SheetsReplica` in the worker) and sends the op.
2. The server (Rust, same engine natively) applies ops in arrival order, numbers them (`seq`),
   writes them to Postgres, and only then broadcasts them.
3. Every browser applies ops in `seq` order. When someone else's op arrives before ours is
   confirmed, the replica undoes its pending ops, applies the remote one and re-applies its own
   (a rebase). All of this lives in `engine-wasm/src/collab.rs`, shared by server and browser.

Per-person view state (open sheet, selection, clipboard) stays local; an in-app paste travels as
copy + paste so every replica pastes the same source. Undo/redo are shared (they take back the
last change by anyone) and make every client reload the server's state.

Storage: one snapshot (XLSX) plus the ops after it per workbook; a new snapshot every 100 ops and
when the last person leaves. Reconnecting tabs resend unconfirmed edits; the server drops
duplicates by (session, op id).

**Not yet:** accounts and permissions (anyone with the link can edit), per-person undo, and
adjusting addresses in ops when someone inserts rows concurrently.

## Build and run

Needs Rust with the `wasm32-unknown-unknown` target, `wasm-bindgen-cli` 0.2.129 and Node 24.

```sh
cd web
npm install
npm run engine      # cargo build → wasm-bindgen → src/engine/pkg   (add -- --dev for a fast build)
npm run dev         # http://localhost:5173 (solo; /api and /ws proxy to the server)
```

Collaboration server (another terminal, from `apps/sheets`):

```sh
docker run -d --name sheets-db -e POSTGRES_USER=sheets -e POSTGRES_PASSWORD=sheets-dev   -e POSTGRES_DB=sheets -p 127.0.0.1:5436:5432 -v sheets-db-data:/var/lib/postgresql/data postgres:17
DATABASE_URL=postgres://sheets:sheets-dev@127.0.0.1:5436/sheets cargo run --release -p sheets-server
```

Without `DATABASE_URL` it keeps workbooks in memory. `SHEETS_STATIC=web/dist` makes it serve the
built app too (one process for production).

## Tests

```sh
cargo test --release -p sheets-engine      # engine bridge + sync logic (SHEETS_FUZZ_ROUNDS=200 to soak)
SHEETS_TEST_DATABASE_URL=postgres://sheets:sheets-dev@127.0.0.1:5436/sheets   cargo test --release -p sheets-server    # server over real sockets, memory + Postgres
cd web
npm test                                   # unit (layout math, worker RPC)
npm run e2e                                # Playwright in Chrome (starts the server and a production build)
```

## Roadmap

1. ✅ Engine bridge (`engine-wasm`)
2. ✅ Canvas grid, editing, formula bar, undo/redo, formatting, sheet tabs, XLSX open/download
3. ✅ Clipboard, column/row resize, autosave to IndexedDB, New workbook
4. ✅ Collaboration: command-ordering server (Rust + Postgres), live edits, presence, reconnect
5. Deployment (needs server access)
6. Accounts and sharing permissions, per-person undo, smaller engine download
