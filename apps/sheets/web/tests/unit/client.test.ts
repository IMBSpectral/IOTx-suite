import { describe, expect, it } from "vitest";
import { EngineClient, type Transport } from "../../src/engine/client";
import type { Envelope, Reply } from "../../src/engine/protocol";

class FakeWorker implements Transport {
  onmessage: ((ev: MessageEvent<Reply>) => void) | null = null;
  sent: Envelope[] = [];
  postMessage(msg: Envelope): void {
    this.sent.push(msg);
  }
  reply(r: Reply): void {
    this.onmessage?.({ data: r } as MessageEvent<Reply>);
  }
}

describe("EngineClient", () => {
  it("matches replies to requests by sequence number", async () => {
    const w = new FakeWorker();
    const c = new EngineClient(w);
    const a = c.editText(0, 0);
    const b = c.execute("cell.set", { cell: "A1", input: "1" });
    expect(w.sent.map((m) => m.req.op)).toEqual(["editText", "execute"]);
    w.reply({ seq: w.sent[1].seq, ok: true, value: { result: null, revision: 2 } });
    w.reply({ seq: w.sent[0].seq, ok: true, value: "=A2" });
    await expect(a).resolves.toBe("=A2");
    await expect(b).resolves.toEqual({ result: null, revision: 2 });
  });

  it("turns engine errors into rejections", async () => {
    const w = new FakeWorker();
    const c = new EngineClient(w);
    const p = c.execute("no.such");
    w.reply({ seq: w.sent[0].seq, ok: false, error: "unknown command" });
    await expect(p).rejects.toThrow("unknown command");
  });
});
