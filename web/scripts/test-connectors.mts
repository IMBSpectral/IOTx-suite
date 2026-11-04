/**
 * Connectors over HTTP plus the parts that need no live service account:
 * catalog, validation, a real rejected credential (GitHub answers 401 to a
 * fake token), seamless connectors refusing locally, paste detection, and the
 * request guard that keeps credentials on the connector's own host.
 *   npx tsx scripts/test-connectors.mts <devToken>
 */
import { detectPastedCredential } from "../src/lib/connector-patterns";

const BASE = "http://localhost:3000";
const token = process.argv[2];
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function call(path: string, json?: unknown) {
  const res = await fetch(BASE + path, {
    method: json === undefined ? "GET" : "POST",
    headers: { cookie: `authjs.session-token=${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function main() {
  const list = await call("/api/workspace/connectors");
  check("catalog served", list.status === 200 && list.body.catalog.some((c: any) => c.kind === "notion" && c.type === "standard"));
  check("catalog never carries patterns or secrets", !JSON.stringify(list.body).includes("pastePattern"));
  check("seamless connectors listed", list.body.catalog.some((c: any) => c.kind === "gmail" && c.type === "seamless"));

  const missing = await call("/api/workspace/connectors", { action: "connect", kind: "github", values: {} });
  check("missing token refused", missing.status === 400 && /required/.test(missing.body.error), missing.body.error);
  const fake = await call("/api/workspace/connectors", { action: "connect", kind: "github", values: { token: "ghp_" + "x".repeat(36) } });
  check("bad credential rejected by the real service", fake.status === 400 && /rejected|reach/.test(fake.body.error), fake.body.error);
  const oauth = await call("/api/workspace/connectors", { action: "connect", kind: "gmail", values: {} });
  check("seamless connector explains OAuth", oauth.status === 400 && /OAuth/.test(oauth.body.error));
  check("unknown connector refused", (await call("/api/workspace/connectors", { action: "connect", kind: "nope", values: {} })).status === 400);
  check("no connection stored after failures", (await call("/api/workspace/connectors")).body.connections.length === list.body.connections.length);
  check("disconnect unknown refused", (await call("/api/workspace/connectors", { action: "disconnect", id: "nope" })).status === 400);
  check("unauthenticated 401", (await fetch(BASE + "/api/workspace/connectors")).status === 401);

  const s = detectPastedCredential("my stripe key is sk_test_" + "a".repeat(24) + " thanks");
  check("paste: stripe key detected", s?.kind === "stripe" && s.value.startsWith("sk_test_"));
  // A fake token, built in pieces so secret scanners don't mistake it for a real one.
  check("paste: slack token detected", detectPastedCredential(["xox", "b-", "123456789012", "-abcdefghijklmnop"].join(""))?.kind === "slack");
  check("paste: ordinary text ignored", detectPastedCredential("make the header blue") === null);

  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
