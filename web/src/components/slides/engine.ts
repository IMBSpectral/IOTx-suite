/**
 * The Slides editor's data and saving, outside React: Google's copy (`base`,
 * with its revision) and what the screen shows (`view` = base + changes not
 * yet confirmed). Changes are applied locally and sent in batches
 * (debounced) with writeControl.requiredRevisionId; the reply carries the
 * presentation read again. If someone else saved first, our changes to
 * objects they didn't touch are sent again; changes to the same objects are
 * dropped (and said so). New slides, copies, images and tables can't be
 * shown before Google makes them, so editing waits for Google's copy.
 */
import { applyReq, findEl, invert, LOCAL, slideOf, touches, type Json, type Req } from "./model";

export type EditorFile = { id: string; name: string; webViewLink: string; starred?: boolean; modifiedTime: string; capabilities?: { canEdit?: boolean } };
export type Meta = { file: EditorFile; canEdit: boolean; connection: { email: string; canEdit: boolean } };
export type SaveState = { state: "idle" | "saving" | "saved" | "error"; error?: string; at?: number };
export type Entry = { label: string; redo: Req[]; undo: Req[] | null; group?: string; at?: number };

const clone = (x: Json) => JSON.parse(JSON.stringify(x));

export class SlidesEngine {
  meta: Meta | null = null;
  base: Json = null;
  view: Json = null;
  loadError: { text: string; connect?: boolean; reconnect?: boolean } | null = null;
  save: SaveState = { state: "idle" };
  locked = false;
  /** Bumped when Google's copy replaces the view (the filmstrip asks for new pictures). */
  synced = 0;
  editing = false;
  onNotice: ((t: string) => void) | null = null;
  private pending: Req[] = [];
  private inflight = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failed: Req[] = [];
  private failedBase: string | null = null;
  private undos: Entry[] = [];
  private redos: Entry[] = [];
  private conflicts = 0;

  constructor(
    readonly id: string,
    private change: () => void,
  ) {}
  private url(q = "") {
    return `/api/google/slides/${encodeURIComponent(this.id)}${q}`;
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

  async open(touch = false) {
    const r = await fetch(this.url(`?view=open${touch ? "&touch=1" : ""}`));
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (!this.meta) this.loadError = { text: d.error ?? "Couldn't open the presentation.", connect: !!d.connect, reconnect: !!d.reconnect };
      this.change();
      return false;
    }
    this.meta = { file: d.file, canEdit: d.canEdit, connection: d.connection };
    this.base = d.pres;
    this.view = clone(d.pres);
    this.synced++;
    this.loadError = null;
    this.change();
    return true;
  }

  private replace(fresh: Json, on: Req[]) {
    this.base = fresh;
    const v = clone(fresh);
    for (const r of on) {
      try {
        applyReq(v, r);
      } catch {}
    }
    this.view = v;
    this.synced++;
    if (this.meta && fresh.title && fresh.title !== this.meta.file.name) this.meta = { ...this.meta, file: { ...this.meta.file, name: fresh.title } };
  }

  async refresh() {
    if (this.busy || this.locked || this.editing || !this.base) return;
    const rev = this.base.revisionId;
    const r = await fetch(this.url("?view=pres")).catch(() => null);
    const d = r?.ok ? await r.json().catch(() => null) : null;
    if (!d?.pres || this.busy || this.locked || this.editing || this.base.revisionId !== rev || d.pres.revisionId === rev) return;
    this.undos = [];
    this.redos = [];
    this.replace(d.pres, []);
    this.change();
  }

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
    return true;
  }
  /** Requests worked out against the view, with their undo, as one step. */
  run(label: string, reqs: Req[], group?: string, structural = false) {
    if (!this.view || !reqs.length) return false;
    const trial = clone(this.view);
    const undo: Req[] = [];
    let exact = true;
    for (const r of reqs) {
      const inv = LOCAL.has(Object.keys(r)[0]) ? invert(trial, r) : null;
      if (!inv) exact = false;
      else undo.unshift(...inv);
      if (LOCAL.has(Object.keys(r)[0])) applyReq(trial, r);
    }
    return this.apply({ label, redo: reqs, undo: exact ? undo : null, group }, { structural });
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
    if (!structural)
      for (const r of reqs) {
        try {
          applyReq(this.view, r);
        } catch {}
      }
    for (const r of reqs) this.push(r);
    this.save = { state: "saving" };
    if (structural) this.locked = true;
    this.change();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), structural ? 0 : 700);
  }
  /** Moving the same thing again replaces the last move; typing runs together. */
  private push(r: Req) {
    const last = this.pending[this.pending.length - 1];
    if (last?.updatePageElementTransform && r.updatePageElementTransform && last.updatePageElementTransform.objectId === r.updatePageElementTransform.objectId) {
      last.updatePageElementTransform = r.updatePageElementTransform;
      return;
    }
    const a = last?.insertText;
    const b = r.insertText;
    if (a && b && a.objectId === b.objectId && JSON.stringify(a.cellLocation) === JSON.stringify(b.cellLocation) && a.insertionIndex + a.text.length === b.insertionIndex) {
      last.insertText = { ...a, text: a.text + b.text };
      return;
    }
    this.pending.push(clone(r));
  }

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
      this.pending = [];
      this.locked = false;
      this.save = { state: "error", error: (e as Error).message || "Couldn't save to Google." };
      const r = await fetch(this.url("?view=pres")).catch(() => null);
      const fresh = r?.ok ? await r.json().catch(() => null) : null;
      if (fresh?.pres) this.replace(fresh.pres, []);
      this.undos = [];
      this.redos = [];
      this.change();
      return;
    }
    this.inflight = false;
    this.locked = false;
    if (d.conflict) {
      // Someone else saved first: keep our changes to things they didn't touch.
      this.conflicts++;
      const fresh = d.pres;
      const all = [...reqs, ...this.pending.splice(0)];
      const changed = (id: string) => {
        if (id === "#order") return JSON.stringify((sentOn.slides ?? []).map((s: Json) => s.objectId)) !== JSON.stringify((fresh.slides ?? []).map((s: Json) => s.objectId));
        const a = findEl(sentOn, id)?.el ?? slideOf(sentOn, id);
        const b = findEl(fresh, id)?.el ?? slideOf(fresh, id);
        return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
      };
      const keep = structural || this.conflicts > 3 ? [] : all.filter((r) => touches(r).every((id) => !changed(id)));
      this.undos = [];
      this.redos = [];
      this.replace(fresh, keep);
      this.pending = keep;
      if (keep.length < all.length) this.onNotice?.("Someone else changed the same thing, so some of your latest changes weren't saved. The slide now shows their version.");
      this.change();
      if (this.pending.length) return this.flush();
      this.save = { state: "saved", at: Date.now() };
      this.change();
      return;
    }
    this.conflicts = 0;
    const later = this.pending.splice(0);
    this.replace(d.pres, later);
    this.pending = later;
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
      this.onNotice?.("The presentation changed since then, so that change can't be sent again.");
      return this.dismissError();
    }
    this.queue(reqs, reqs.some((r) => !LOCAL.has(Object.keys(r)[0])));
  }
  dismissError() {
    this.failed = [];
    this.save = { state: "idle" };
    this.change();
  }
  setEditing(v: boolean) {
    this.editing = v;
  }
  setFile(patch: Partial<EditorFile>) {
    if (this.meta) this.meta = { ...this.meta, file: { ...this.meta.file, ...patch } };
    this.change();
  }
}
