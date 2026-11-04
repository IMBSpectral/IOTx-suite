// Promise-based client for the calculation worker. Requests are answered in order, so a
// viewport asked for after an edit always reflects that edit.
import type { Envelope, ExecResult, Info, Op, Reply, Request, Submit, Viewport } from "./protocol";

export interface Transport {
  postMessage(msg: Envelope, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<Reply>) => void) | null;
}

export class EngineClient {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private transport: Transport) {
    transport.onmessage = (ev) => {
      const r = ev.data;
      const p = this.pending.get(r.seq);
      if (!p) return;
      this.pending.delete(r.seq);
      if (r.ok) p.resolve(r.value);
      else p.reject(new Error(r.error));
    };
  }

  static spawn(): EngineClient {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    return new EngineClient(worker as unknown as Transport);
  }

  private call<T>(req: Request, transfer: Transferable[] = []): Promise<T> {
    const seq = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(seq, { resolve: resolve as (v: unknown) => void, reject });
      this.transport.postMessage({ seq, req }, transfer);
    });
  }

  info(): Promise<Info> {
    return this.call({ op: "info" });
  }
  viewport(r0: number, c0: number, r1: number, c1: number): Promise<Viewport> {
    return this.call({ op: "viewport", r0, c0, r1, c1 });
  }
  editText(row: number, col: number): Promise<string> {
    return this.call({ op: "editText", row, col });
  }
  /** Called with every command result (shared mode reads `send`, `pending`, `resync` from it). */
  onExecute: ((r: ExecResult) => void) | null = null;

  async execute(id: string, params: unknown = {}): Promise<ExecResult> {
    const r = await this.call<ExecResult>({ op: "execute", id, params });
    this.onExecute?.(r);
    return r;
  }
  open(name: string, bytes: Uint8Array): Promise<string[]> {
    return this.call({ op: "open", name, bytes }, [bytes.buffer]);
  }
  saveXlsx(): Promise<Uint8Array> {
    return this.call({ op: "saveXlsx" });
  }
  reset(): Promise<void> {
    return this.call({ op: "reset" });
  }
  join(sid: string, snapshot: Uint8Array, seq: number): Promise<void> {
    return this.call({ op: "join", sid, snapshot, seq }, [snapshot.buffer]);
  }
  remote(message: Op): Promise<ExecResult> {
    return this.call({ op: "remote", message });
  }
  rejected(cid: number): Promise<ExecResult> {
    return this.call({ op: "rejected", cid });
  }
  resync(snapshot: Uint8Array, seq: number, acked: number): Promise<Submit[]> {
    return this.call({ op: "resync", snapshot, seq, acked }, [snapshot.buffer]);
  }
  unshare(): Promise<void> {
    return this.call({ op: "unshare" });
  }
}
