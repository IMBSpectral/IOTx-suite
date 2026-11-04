/// <reference lib="webworker" />
// The calculation worker: owns the workbook and the IMB Gridly engine (WASM). The page only ever
// sees viewports and command results, so a long recalculation never blocks painting or typing.
//
// Solo mode uses a SheetsEngine. Shared mode uses a SheetsReplica: edits apply at once and come
// back as ops to send; the server's ops are rebased underneath them (see engine-wasm/src/collab.rs).
import init, { SheetsEngine, SheetsReplica } from "./pkg/sheets_engine.js";
import type { Envelope, Reply, Request } from "./protocol";

const ready = init();
let solo: SheetsEngine | null = null;
let shared: SheetsReplica | null = null;

/** Whichever engine is active; both have the same read methods. */
function active(): SheetsEngine | SheetsReplica {
  if (shared) return shared;
  solo ??= new SheetsEngine();
  return solo;
}

function handle(req: Request): { value: unknown; transfer?: Transferable[] } {
  switch (req.op) {
    case "info":
      return { value: JSON.parse(active().info()) };
    case "viewport":
      return { value: JSON.parse(active().viewport(req.r0, req.c0, req.r1, req.c1)) };
    case "editText":
      return { value: active().editText(req.row, req.col) };
    case "execute": {
      const params = JSON.stringify(req.params ?? {});
      if (shared) return { value: JSON.parse(shared.local(req.id, params)) };
      solo ??= new SheetsEngine();
      return { value: JSON.parse(solo.execute(req.id, params)) };
    }
    case "open": {
      if (shared) throw new Error("Open a file from a workbook that isn't shared.");
      return { value: JSON.parse((active() as SheetsEngine).open(req.name, req.bytes)) };
    }
    case "saveXlsx": {
      const bytes = active().saveXlsx();
      return { value: bytes, transfer: [bytes.buffer] };
    }
    case "reset":
      shared?.free();
      shared = null;
      solo?.free();
      solo = new SheetsEngine();
      return { value: null };
    case "join":
      shared?.free();
      shared = new SheetsReplica(req.sid, req.snapshot, BigInt(req.seq));
      return { value: null };
    case "remote":
      return { value: JSON.parse(need().remote(JSON.stringify(req.message))) };
    case "rejected":
      return { value: JSON.parse(need().rejected(BigInt(req.cid))) };
    case "resync":
      return { value: JSON.parse(need().resync(req.snapshot, BigInt(req.seq), BigInt(req.acked))) };
    case "unshare": {
      // Keep working on the current state, alone.
      const bytes = need().saveXlsx();
      shared?.free();
      shared = null;
      solo?.free();
      solo = new SheetsEngine();
      solo.open("shared.xlsx", bytes);
      return { value: null };
    }
  }
}

function need(): SheetsReplica {
  if (!shared) throw new Error("this workbook isn't shared");
  return shared;
}

self.onmessage = async (ev: MessageEvent<Envelope>) => {
  const { seq, req } = ev.data;
  let reply: Reply;
  let transfer: Transferable[] = [];
  try {
    await ready;
    const out = handle(req);
    reply = { seq, ok: true, value: out.value };
    transfer = out.transfer ?? [];
  } catch (e) {
    reply = { seq, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(reply, transfer);
};
