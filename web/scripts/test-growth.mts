/**
 * Growth & support over HTTP: support tickets (validation, screenshots,
 * confirmation notification), help and preferences pages, referral cookie.
 *   npx tsx scripts/test-growth.mts <devToken>
 */
import { searchHelp } from "../src/lib/help";

const BASE = "http://localhost:3000";
const cookie = `authjs.session-token=${process.argv[2]}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Smallest valid PNG (1x1).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

async function ticket(fields: Record<string, string>, files: { name: string; type: string; bytes: Buffer }[] = []) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append("files", new Blob([new Uint8Array(f.bytes)], { type: f.type }), f.name);
  const res = await fetch(`${BASE}/api/support`, { method: "POST", headers: { cookie }, body: fd });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  check("empty ticket refused", (await ticket({ subject: "", message: "" })).status === 400);
  check("non-image refused", (await ticket({ subject: "s", message: "m" }, [{ name: "a.txt", type: "text/plain", bytes: Buffer.from("x") }])).status === 400);
  const six = Array.from({ length: 6 }, (_, i) => ({ name: `${i}.png`, type: "image/png", bytes: PNG }));
  check("more than 5 files refused", (await ticket({ subject: "s", message: "m" }, six)).status === 400);
  const big = { name: "big.png", type: "image/png", bytes: Buffer.alloc(5 * 1024 * 1024 + 1) };
  check("over 5 MB refused", (await ticket({ subject: "s", message: "m" }, [big])).status === 400);
  check("unknown project refused", (await ticket({ subject: "s", message: "m", projectId: "nope" })).status === 400);
  const ok = await ticket({ subject: "Preview is blank", message: "After accepting a draft the preview stayed white." }, [
    { name: "shot.png", type: "image/png", bytes: PNG },
  ]);
  check("ticket created", ok.status === 201 && /^T-/.test(ok.body.id), JSON.stringify(ok.body));
  const notes = await (await fetch(`${BASE}/api/notifications`, { headers: { cookie } })).json();
  check("confirmation notification", notes.items.some((n: { title: string }) => n.title.includes(ok.body.id)));
  check("unauthenticated support 401", (await fetch(`${BASE}/api/support`, { method: "POST" })).status === 401);

  for (const path of ["/help?q=publish", "/settings/preferences", "/dashboard"]) {
    const res = await fetch(BASE + path, { headers: { cookie } });
    check(`page ${path}`, res.status === 200);
  }
  check("help search ranks publishing", searchHelp("publish")[0]?.slug === "publishing");
  check("help search: sharing password", searchHelp("preview password")[0]?.slug === "sharing");

  const ref = await fetch(`${BASE}/login?ref=abcdef123`, { redirect: "manual" });
  check("referral cookie set", (ref.headers.get("set-cookie") ?? "").includes("forge_ref=abcdef123"));
  const bad = await fetch(`${BASE}/login?ref=${encodeURIComponent("<x>")}`, { redirect: "manual" });
  check("bad referral ignored", !(bad.headers.get("set-cookie") ?? "").includes("forge_ref"));

  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
