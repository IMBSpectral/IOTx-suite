// A shared workbook's connection: one WebSocket to the collaboration server, relaying ops between
// the server and the replica in the calculation worker. All sync logic lives in the replica
// (engine-wasm/src/collab.rs); this file only moves messages and keeps the connection alive.
import type { EngineClient } from "../engine/client";
import type { ExecResult, Op, Submit } from "../engine/protocol";

export interface Peer {
  sid: string;
  name: string;
  color: string;
  sheet: number;
  sel: string;
}

export type ConnectionState = "connecting" | "live" | "offline";

export interface CollabEvents {
  /** The workbook changed under the user (someone else's edit, or a resync). */
  changed(revision: number): void;
  /** Connection state, people present, and whether all of our edits reached the server. */
  status(state: ConnectionState, peers: Peer[], unsaved: number): void;
  title(title: string): void;
  notice(message: string): void;
}

type ServerMsg =
  | { t: "welcome"; seq: number; acked: number; title: string; snapshot: string; you: Peer; peers: Peer[] }
  | { t: "snapshot"; seq: number; acked: number; title: string; snapshot: string }
  | ({ t: "op" } & Op)
  | { t: "reject"; cid: number; error: string }
  | { t: "presence"; peer: Peer }
  | { t: "leave"; sid: string }
  | { t: "title"; title: string }
  | { t: "error"; error: string };

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** This tab's session id: kept across reconnects so the server recognises resent ops. */
export function tabSessionId(): string {
  const key = "sheets-sid";
  let sid = sessionStorage.getItem(key);
  if (!sid) {
    sid = crypto.randomUUID().replaceAll("-", "");
    sessionStorage.setItem(key, sid);
  }
  return sid;
}

const ANIMALS = ["Otter", "Heron", "Lynx", "Ibex", "Gecko", "Puffin", "Bison", "Marten", "Quokka", "Kestrel"];

export function displayName(): string {
  const key = "sheets-name";
  let name = localStorage.getItem(key);
  if (!name) {
    name = `Anonymous ${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]}`;
    localStorage.setItem(key, name);
  }
  return name;
}

export class CollabSession {
  private ws: WebSocket | null = null;
  private joined = false;
  private closed = false;
  private retry = 0;
  private peers = new Map<string, Peer>();
  private unsaved = 0;
  private state: ConnectionState = "connecting";
  /** Messages are handled one at a time, in arrival order. */
  private queue: Promise<void> = Promise.resolve();
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPresence = "";
  me: Peer | null = null;

  constructor(
    readonly book: string,
    private engine: EngineClient,
    private events: CollabEvents,
    private sid = tabSessionId(),
    private name = displayName(),
  ) {
    engine.onExecute = (r) => this.onLocal(r);
    this.connect();
  }

  private url(): string {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws/${this.book}?sid=${this.sid}&name=${encodeURIComponent(this.name)}`;
  }

  private connect(): void {
    this.setState("connecting");
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMsg;
      this.queue = this.queue.then(() => this.receive(msg)).catch((e) => this.events.notice(String(e)));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.setState("offline");
      if (this.closed) return;
      // Reconnect with backoff; the welcome brings us back in sync and resends our edits.
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => !this.closed && this.connect(), delay);
    };
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.engine.onExecute = null;
  }

  private send(msg: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private setState(s: ConnectionState): void {
    this.state = s;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.events.status(this.state, [...this.peers.values()], this.unsaved);
  }

  private track(r: ExecResult): void {
    if (typeof r.pending === "number") this.unsaved = r.pending;
    if (r.dropped?.length) this.events.notice(`${r.dropped.length} of your edits no longer applied after someone else's change`);
    this.emitStatus();
  }

  /** A local command finished in the replica: send its op. */
  private onLocal(r: ExecResult): void {
    if (r.send) this.send({ t: "op", ...r.send }); // if offline, the next welcome resends it
    this.track(r);
    if (r.resync) this.send({ t: "resync" });
  }

  private resend(ops: Submit[]): void {
    for (const op of ops) this.send({ t: "op", ...op });
  }

  private async receive(msg: ServerMsg): Promise<void> {
    switch (msg.t) {
      case "welcome": {
        this.retry = 0;
        this.me = msg.you;
        this.peers = new Map(msg.peers.map((p) => [p.sid, p]));
        if (!this.joined) {
          await this.engine.join(this.sid, b64(msg.snapshot), msg.seq);
          this.joined = true;
        } else {
          // Reconnected: reload the server's state, keep and resend what it hasn't seen.
          this.resend(await this.engine.resync(b64(msg.snapshot), msg.seq, msg.acked));
        }
        this.events.title(msg.title);
        this.setState("live");
        this.events.changed(-1);
        this.lastPresence = "";
        break;
      }
      case "snapshot": {
        this.resend(await this.engine.resync(b64(msg.snapshot), msg.seq, msg.acked));
        this.events.changed(-1);
        break;
      }
      case "op": {
        const r = await this.engine.remote(msg);
        this.track(r);
        if (r.resync) this.send({ t: "resync" });
        if (msg.sid !== this.sid || r.resync) this.events.changed(r.revision);
        break;
      }
      case "reject": {
        this.events.notice(`An edit wasn't saved: ${msg.error}`);
        const r = await this.engine.rejected(msg.cid);
        this.track(r);
        this.events.changed(r.revision);
        break;
      }
      case "presence":
        this.peers.set(msg.peer.sid, msg.peer);
        this.emitStatus();
        break;
      case "leave":
        this.peers.delete(msg.sid);
        this.emitStatus();
        break;
      case "title":
        this.events.title(msg.title);
        break;
      case "error":
        this.events.notice(msg.error);
        break;
    }
  }

  /** Where this user is; sent at most every 100 ms. */
  presence(sheet: number, sel: string): void {
    const key = `${sheet}|${sel}`;
    if (key === this.lastPresence) return;
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = setTimeout(() => {
      if (this.send({ t: "presence", sheet, sel })) this.lastPresence = key;
    }, 100);
  }

  setTitle(title: string): void {
    this.send({ t: "title", title });
  }
}

/** Creates a shared workbook on the server from the current one; returns its id. */
export async function createSharedBook(engine: EngineClient, title: string): Promise<string> {
  const bytes = await engine.saveXlsx();
  const res = await fetch(`/api/books?title=${encodeURIComponent(title)}`, { method: "POST", body: bytes as BodyInit });
  const body = (await res.json()) as { id?: string; error?: string };
  if (!res.ok || !body.id) throw new Error(body.error ?? `server said ${res.status}`);
  return body.id;
}
