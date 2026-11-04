import "./styles.css";
import { CollabSession, createSharedBook, type Peer } from "./collab/session";
import { EngineClient } from "./engine/client";
import type { Info } from "./engine/protocol";
import { a1, parseRange, rangeA1 } from "./grid/axis";
import { Grid } from "./grid/grid";
import { Debounced, storage } from "./store/autosave";
import { FilterMenu } from "./ui/filter";
import { initMenus, renderSheetTabs, showGridMenu } from "./ui/menubar";
import { initToolbar } from "./ui/toolbar";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const engine = EngineClient.spawn();
const namebox = $<HTMLInputElement>("namebox");
const formula = $<HTMLInputElement>("formula");
const status = $<HTMLSpanElement>("status");
const tabs = $<HTMLDivElement>("sheet-tabs");
const title = $<HTMLInputElement>("title");
const people = $<HTMLDivElement>("people");
const shareButton = $<HTMLButtonElement>("share");
let info: Info | null = null;
const UNTITLED = "Untitled spreadsheet";

/** Set while this tab edits a shared workbook; then the server, not the browser, stores it. */
let session: CollabSession | null = null;
let peers: Peer[] = [];
let sharedUnsaved = 0;

// Solo mode: every edit bumps `edits`; a save records the count it captured. "Saved" is only
// claimed when nothing changed while the save was being written.
let edits = 0;
let savedEdits = 0;
const unsaved = () => (session ? sharedUnsaved > 0 : edits !== savedEdits);

const autosave = new Debounced(async () => {
  if (session) return;
  const target = edits;
  flash("Saving…");
  try {
    const bytes = await engine.saveXlsx();
    await storage.save({ title: title.value.trim() || UNTITLED, bytes, savedAt: Date.now() });
    savedEdits = Math.max(savedEdits, target);
    flash(unsaved() ? "Unsaved changes" : "Saved in this browser");
  } catch (e) {
    flash(`Couldn't save in this browser: ${e instanceof Error ? e.message : e}`, "error");
  }
}, 800);

function edited(): void {
  if (session) return; // the session reports saving
  edits++;
  flash("Unsaved changes");
  autosave.schedule();
}

function flash(message: string, kind: "info" | "error" = "info"): void {
  status.textContent = message;
  status.dataset.kind = kind;
}

const grid = new Grid($("grid"), engine, {
  selection(active, range) {
    const sel = range.r0 === range.r1 && range.c0 === range.c1 ? a1(active.row, active.col) : rangeA1(range);
    namebox.value = sel;
    if (grid?.isEditing) formula.value = grid.input.value;
    else void engine.editText(active.row, active.col).then((t) => (formula.value = t));
    session?.presence(info?.active ?? 0, sel.length > 20 ? a1(active.row, active.col) : sel);
    toolbar?.refresh();
  },
  changed() {
    edited();
    void refreshInfo();
    toolbar?.refresh();
    if (!grid.isEditing) void engine.editText(grid.active.row, grid.active.col).then((t) => (formula.value = t));
  },
  filterButton(at) {
    void filterMenu.open(at);
  },
  error(message) {
    flash(message, "error");
  },
  copied(range, cut) {
    flash(`${cut ? "Cut" : "Copied"} ${range}`);
  },
  contextMenu(at) {
    void showGridMenu(at);
  },
});

const filterMenu = new FilterMenu(grid, engine);
// Menu bar, right-click and tab menus, Find (Ctrl+F) and Find and replace (Ctrl+H).
initMenus({ grid, engine, info: () => info, refreshInfo, flash });

async function refreshInfo(): Promise<void> {
  const before = info?.active;
  info = await engine.info();
  if (before !== undefined && before !== info.active) grid.reset();
  grid.applyInfo(info);
  renderTabs(info);
  renderPeers();
}

/** Tabs: click switches; double-click renames; right-click / ▾ opens the tab menu (src/ui/menu-tabs.ts). */
function renderTabs(i: Info): void {
  renderSheetTabs(tabs, i);
}

/** Avatars in the top bar, and other people's selections on the sheet this user is viewing. */
function renderPeers(): void {
  people.replaceChildren(
    ...peers.map((p) => {
      const d = document.createElement("span");
      d.className = "avatar";
      d.style.background = p.color;
      d.textContent = (p.name.replace(/^Anonymous /, "")[0] ?? "?").toUpperCase();
      d.title = `${p.name} · ${p.sel}`;
      d.dataset.testid = "avatar";
      return d;
    }),
  );
  const here = info?.active ?? 0;
  grid.setPeers(
    peers
      .filter((p) => p.sheet === here)
      .flatMap((p) => {
        const range = parseRange(p.sel);
        return range ? [{ name: p.name, color: p.color, range }] : [];
      }),
  );
}

// Toolbar.
const toolbar = initToolbar(document.querySelector<HTMLElement>(".toolbar")!, grid, engine);

// Formula bar: edits the active cell; Enter commits, Escape restores.
formula.addEventListener("keydown", async (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const saved = grid.run("cell.set", { cell: a1(grid.active.row, grid.active.col), input: formula.value });
    grid.select({ row: grid.active.row + 1, col: grid.active.col }, false);
    grid.focus();
    await saved;
  } else if (e.key === "Escape") {
    formula.value = await engine.editText(grid.active.row, grid.active.col);
    grid.focus();
  }
});
grid.input.addEventListener("input", () => (formula.value = grid.input.value));

// Name box: jump to a cell or range.
namebox.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const r = parseRange(namebox.value);
  if (!r) return flash(`Not a cell reference: ${namebox.value}`, "error");
  grid.select({ row: r.r0, col: r.c0 }, false);
  if (r.r1 !== r.r0 || r.c1 !== r.c0) grid.select({ row: r.r1, col: r.c1 }, true);
  grid.focus();
});

$("add-sheet").addEventListener("click", async () => {
  if (await grid.run("home.insertSheet", {})) {
    grid.reset();
    await refreshInfo();
  }
  grid.focus();
});

// Files.
$<HTMLInputElement>("open-file").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (session) {
    flash("Opening a file replaces the workbook: use New first, then share the opened file.", "error");
    return;
  }
  try {
    const warnings = await engine.open(file.name, new Uint8Array(await file.arrayBuffer()));
    grid.reset();
    await refreshInfo();
    grid.markChanged(info?.revision ?? 0);
    title.value = info?.title ?? file.name;
    flash(warnings.length ? `Opened with ${warnings.length} warning(s): ${warnings[0]}` : `Opened ${file.name}`);
  } catch (err) {
    flash(`Couldn't open ${file.name}: ${err instanceof Error ? err.message : err}`, "error");
  }
  grid.focus();
});

$("download").addEventListener("click", async () => {
  const bytes = await engine.saveXlsx();
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title.value.trim() || UNTITLED}.xlsx`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$("new").addEventListener("click", async () => {
  if (session) {
    location.href = location.pathname; // leave the shared workbook
    return;
  }
  await autosave.flush();
  await engine.reset();
  await storage.clear();
  edits = savedEdits = 0;
  title.value = UNTITLED;
  grid.reset();
  await refreshInfo();
  flash("New workbook");
  grid.focus();
});

title.addEventListener("change", () => {
  if (session) session.setTitle(title.value.trim() || UNTITLED);
  else edited();
});
title.addEventListener("keydown", (e) => {
  if (e.key === "Enter") grid.focus();
});
window.addEventListener("pagehide", () => void autosave.flush());
// Closing the tab before the last edit is saved asks first (the browser's own prompt).
window.addEventListener("beforeunload", (e) => {
  if (!unsaved()) return;
  void autosave.flush();
  e.preventDefault();
});

// ---------- sharing ----------

async function startSession(book: string): Promise<void> {
  grid.readOnly = true;
  flash("Connecting…");
  shareButton.textContent = "Copy link";
  session = new CollabSession(book, engine, {
    changed(revision) {
      grid.readOnly = false;
      grid.markChanged(revision < 0 ? (info?.revision ?? 0) + 1 : revision);
    },
    status(state, list, pendingOps) {
      peers = list;
      sharedUnsaved = pendingOps;
      if (state === "live") flash(pendingOps ? "Saving…" : `Live · ${list.length ? `${list.length + 1} people` : "only you"} · all changes saved`);
      else if (state === "connecting") flash("Connecting…");
      else flash(pendingOps ? `Offline · ${pendingOps} edit(s) will be sent when back` : "Offline · reconnecting…", "error");
      renderPeers();
    },
    title(t) {
      if (document.activeElement !== title) title.value = t;
    },
    notice(message) {
      flash(message, "error");
    },
  });
}

shareButton.addEventListener("click", async () => {
  try {
    if (!session) {
      flash("Sharing…");
      const id = await createSharedBook(engine, title.value.trim() || UNTITLED);
      history.replaceState(null, "", `?book=${id}`);
      await startSession(id);
    }
    await navigator.clipboard.writeText(location.href).catch(() => {});
    flash("Link copied: anyone with it can edit");
  } catch (e) {
    flash(`Couldn't share: ${e instanceof Error ? e.message : e}`, "error");
  }
  grid.focus();
});

// ---------- start ----------

title.value = UNTITLED;
const book = new URLSearchParams(location.search).get("book");
if (book) {
  await refreshInfo();
  await startSession(book);
} else {
  // Restore the workbook this browser was last editing.
  try {
    const saved = await storage.load();
    if (saved) {
      await engine.open("restored.xlsx", saved.bytes);
      title.value = saved.title;
    }
  } catch (e) {
    flash(`Couldn't restore the saved workbook: ${e instanceof Error ? e.message : e}`, "error");
  }
  await refreshInfo();
  if (status.dataset.kind !== "error") flash("Ready");
}
grid.focus();
// Exposed for end-to-end tests and debugging.
Object.assign(window, { sheets: { engine, grid, session: () => session } });
