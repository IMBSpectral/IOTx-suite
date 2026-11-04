/**
 * The Docs editor's data and saving, outside React. Google's copy (`base`,
 * with its revision) and what the screen shows (`view` = base + changes not
 * yet confirmed). Changes are applied locally at once and sent in batches
 * (debounced) with writeControl.requiredRevisionId; Google's reply comes with
 * the document read again. If someone else changed it meanwhile, our changes
 * are moved past theirs where they don't overlap and sent again.
 * Structural changes (tables, images, page breaks, replace all) can't be
 * simulated exactly, so editing waits for Google's copy after them.
 */
import { applyReq, diffRegion, fromGoogle, invert, LOCAL, rebase, type Flat, type Json, type Region, type Req } from "./model";

export type EditorFile = { id: string; name: string; webViewLink: string; starred?: boolean; modifiedTime: string; owners?: { displayName?: string }[]; capabilities?: { canEdit?: boolean } };
export type Meta = { file: EditorFile; canEdit: boolean; connection: { email: string; canEdit: boolean } };
export type SaveState = { state: "idle" | "saving" | "saved" | "error"; error?: string; at?: number };
export type Entry = {
  label: string;
  redo: Req[];
  undo: Req[] | null;
  /** Typing and deleting merge into one undo step while they continue. */
  group?: string;
  at?: number;
  /** For structural changes: the undo, worked out from Google's copy afterwards. */
  fix?: (f: Flat) => Req[] | null;
};

const clone = (f: Flat): Flat => ({ ...f, toks: f.toks.map((t) => ({ ...t })) as Flat["toks"], lists: { ...f.lists } });

export class DocEngine {
  meta: Meta | null = null;
  base: Flat | null = null;
  view: Flat | null = null;
  loadError: { text: string; connect?: boolean; reconnect?: boolean } | null = null;
  save: SaveState = { state: "idle" };
  /** A structural change is saving: the page waits for Google's copy. */
  locked = false;
  /** Set while the person is composing text with an input method: refreshes wait. */
  composing = false;
  /** Told how indexes moved when the page is replaced by a newer copy (to keep the caret in place). */
  onMoved: ((g: Region | null) => void) | null = null;
  onNotice: ((text: string) => void) | null = null;
  private pending: Req[] = [];
  private inflight = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failed: Req[] = [];
  private failedBase: string | null = null;
  private undos: Entry[] = [];
  private redos: Entry[] = [];
  private waitingFix: Entry | null = null;
  private conflicts = 0;

  constructor(
    readonly id: string,
    private change: () => void,
  ) {}

  private url(q = "") {
    return `/api/google/docs/${encodeURIComponent(this.id)}${q}`;
  }
  get canUndo() {
    return this.undos.length > 0;
  }
  get canRedo() {
    return this.redos.length > 0;
  }
  get busy() {
    return this.inflight || this.pending.length > 0;
  }

  // ── Loading ──
  async open(touch = false) {
    const r = await fetch(this.url(`?view=open${touch ? "&touch=1" : ""}`));
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (!this.meta) this.loadError = { text: d.error ?? "Couldn't open the document.", connect: !!d.connect, reconnect: !!d.reconnect };
      this.change();
      return false;
    }
    this.meta = { file: d.file, canEdit: d.canEdit, connection: d.connection };
    this.base = fromGoogle(d.doc);
    this.view = clone(this.base);
    this.loadError = null;
    this.change();
    return true;
  }

  private replace(fresh: Flat, pendingOnTop: Req[]) {
    const old = this.view;
    this.base = fresh;
    const v = clone(fresh);
    for (const r of pendingOnTop) applyReq(v, r);
    this.view = v;
    if (this.meta && fresh.title && fresh.title !== this.meta.file.name) this.meta = { ...this.meta, file: { ...this.meta.file, name: fresh.title } };
    this.onMoved?.(old ? diffRegion(old.toks, v.toks) : null);
  }

  /** Others' edits: read the document again unless our own changes are still saving. */
  async refresh() {
    if (this.busy || this.locked || this.composing || !this.base) return;
    const rev = this.base.revisionId;
    const r = await fetch(this.url("?view=doc")).catch(() => null);
    const d = r?.ok ? await r.json().catch(() => null) : null;
    if (!d?.doc || this.busy || this.locked || this.composing || this.base.revisionId !== rev) return;
    if (d.doc.revisionId === rev) return;
    const fresh = fromGoogle(d.doc);
    // Old undo steps point at old indexes.
    if (diffRegion(this.base.toks, fresh.toks)) (this.undos = []), (this.redos = []);
    this.replace(fresh, []);
    this.change();
  }

  // ── Changes ──
  /** Do a change: remember how to undo it, show it, and send it to Google. */
  apply(entry: Entry, opts: { structural?: boolean } = {}) {
    if (!this.view || this.locked) return false;
    const last = this.undos[this.undos.length - 1];
    const now = Date.now();
    if (entry.group && last?.group === entry.group && last.undo && entry.undo && now - (last.at ?? 0) < 1500) {
      last.redo.push(...entry.redo);
      last.undo = [...entry.undo, ...last.undo];
      last.at = now;
    } else {
      this.undos.push({ ...entry, at: now });
      if (this.undos.length > 200) this.undos.shift();
    }
    this.redos = [];
    this.queue(entry.redo, opts.structural);
    if (opts.structural) this.waitingFix = this.undos[this.undos.length - 1];
    return true;
  }

  /** Requests worked out against the view, with their undo, applied as one step. */
  run(label: string, reqs: Req[], group?: string) {
    if (!this.view) return false;
    const trial = clone(this.view);
    const undo: Req[] = [];
    let exact = true;
    for (const r of reqs) {
      const inv = invert(trial, r);
      if (!inv) exact = false;
      else undo.unshift(...inv);
      applyReq(trial, r);
    }
    return this.apply({ label, redo: reqs, undo: exact ? undo : null, group });
  }

  undo() {
    const e = this.undos.pop();
    if (!e) return null;
    if (!e.undo) {
      this.onNotice?.(`"${e.label}" can't be undone here.`);
      this.change();
      return e;
    }
    this.redos.push(e);
    this.queue(e.undo, e.undo.some((r) => !LOCAL.has(Object.keys(r)[0])));
    return e;
  }
  redo() {
    const e = this.redos.pop();
    if (!e) return null;
    this.undos.push({ ...e, at: 0 });
    this.queue(e.redo, e.redo.some((r) => !LOCAL.has(Object.keys(r)[0])));
    return e;
  }

  private queue(reqs: Req[], structural = false) {
    if (!this.view) return;
    if (!structural) for (const r of reqs) applyReq(this.view, r);
    for (const r of reqs) this.push(r);
    this.save = { state: "saving" };
    if (structural) this.locked = true;
    this.change();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), structural ? 0 : 700);
  }

  /** Neighbouring typing and deleting become one request. */
  private push(r: Req) {
    const last = this.pending[this.pending.length - 1];
    if (last?.insertText && r.insertText && last.insertText.location.index + last.insertText.text.length === r.insertText.location.index && last.insertText.text.length < 5000) {
      last.insertText = { ...last.insertText, text: last.insertText.text + r.insertText.text };
      return;
    }
    if (last?.deleteContentRange && r.deleteContentRange) {
      const a = last.deleteContentRange.range;
      const b = r.deleteContentRange.range;
      if (b.endIndex === a.startIndex) return void (last.deleteContentRange = { range: { startIndex: b.startIndex, endIndex: a.endIndex } });
      if (b.startIndex === a.startIndex) return void (last.deleteContentRange = { range: { startIndex: a.startIndex, endIndex: a.endIndex + (b.endIndex - b.startIndex) } });
    }
    this.pending.push(JSON.parse(JSON.stringify(r)));
  }

  /** Send what's waiting; on success Google's copy (read straight after) becomes the base. */
  async flush(): Promise<void> {
    if (this.inflight || !this.pending.length || !this.base) return;
    const reqs = this.pending.splice(0);
    const structural = reqs.some((r) => !LOCAL.has(Object.keys(r)[0]));
    const sentOn = this.base;
    this.inflight = true;
    let d: Json;
    try {
      const r = await fetch(this.url(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "write", requests: reqs, revisionId: sentOn.revisionId }) });
      d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Google didn't accept the change.");
    } catch (e) {
      this.inflight = false;
      this.failed = reqs;
      this.failedBase = sentOn.revisionId;
      const later = this.pending.splice(0);
      this.save = { state: "error", error: (e as Error).message || "Couldn't save to Google." };
      this.locked = false;
      // Show what Google actually has.
      const r = await fetch(this.url("?view=doc")).catch(() => null);
      const fresh = r?.ok ? await r.json().catch(() => null) : null;
      if (fresh?.doc) this.replace(fromGoogle(fresh.doc), []);
      if (later.length) this.onNotice?.("Changes made while that was failing weren't saved either.");
      this.undos = [];
      this.redos = [];
      this.change();
      return;
    }
    this.inflight = false;
    const fresh = fromGoogle(d.doc);
    if (d.conflict) {
      // Someone else saved first: move ours past their change and send again.
      this.conflicts++;
      const g = diffRegion(sentOn.toks, fresh.toks);
      const all = [...reqs, ...this.pending.splice(0)];
      const moved = structural || this.conflicts > 3 ? { reqs: [], dropped: all.length } : rebase(all, g);
      this.undos = [];
      this.redos = [];
      this.locked = false;
      this.replace(fresh, moved.reqs);
      this.pending = moved.reqs;
      if (moved.dropped) this.onNotice?.(`Someone else was editing the same part, so ${moved.dropped === all.length ? "your latest change" : "some of your latest changes"} couldn't be saved. The document now shows their version.`);
      this.change();
      if (this.pending.length) return this.flush();
      this.save = { state: "saved", at: Date.now() };
      this.change();
      return;
    }
    this.conflicts = 0;
    // What we expected Google to have; anything else is someone else's change made just after ours.
    let g: Region | null = null;
    if (!structural) {
      const expected = clone(sentOn);
      for (const r of reqs) applyReq(expected, r);
      g = diffRegion(expected.toks, fresh.toks);
    }
    const later = this.pending.splice(0);
    const moved = g ? rebase(later, g) : { reqs: later, dropped: 0 };
    if (g) (this.undos = []), (this.redos = []);
    this.locked = false;
    this.replace(fresh, moved.reqs);
    this.pending = moved.reqs;
    if (this.waitingFix && structural) {
      const e = this.waitingFix;
      this.waitingFix = null;
      e.undo = e.fix ? e.fix(fresh) : null;
    }
    this.save = { state: this.pending.length ? "saving" : "saved", at: Date.now() };
    this.change();
    if (this.pending.length) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.flush(), 300);
    }
  }
  retry() {
    const reqs = this.failed;
    this.failed = [];
    if (!reqs.length || !this.base) return;
    if (this.base.revisionId !== this.failedBase) {
      this.onNotice?.("The document changed since then, so that change can't be sent again.");
      this.dismissError();
      return;
    }
    this.queue(reqs, reqs.some((r) => !LOCAL.has(Object.keys(r)[0])));
  }
  dismissError() {
    this.failed = [];
    this.save = { state: "idle" };
    this.change();
  }
  setFile(patch: Partial<EditorFile>) {
    if (this.meta) this.meta = { ...this.meta, file: { ...this.meta.file, ...patch } };
    this.change();
  }
}
