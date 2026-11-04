/**
 * Variants end to end with real agent turns: validation, two variants of a
 * small change built in separate drafts, a second set refused while one is
 * open, choosing one (accepted onto main, the other discarded), and the set
 * closed afterwards. Uses a throwaway project, deleted at the end.
 *   npx tsx scripts/test-variants.mts <devToken>
 */
const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function call(path: string, json?: unknown, method?: string) {
  const res = await fetch(BASE + path, {
    method: method ?? (json === undefined ? "GET" : "POST"),
    headers: { cookie: `authjs.session-token=${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

let pid = "";

async function main() {
  pid = (await call("/api/projects", { name: "Variants test", force: true })).body.project.id;
  const V = `/api/projects/${pid}/variants`;
  check("no open set at first", (await call(V)).body.group === null);
  check("empty prompt refused", (await call(V, { action: "create", prompt: " " })).status === 400);

  const prompt = "Change the page heading text to a short friendly greeting. Only edit the heading, nothing else.";
  const made = await call(V, { action: "create", prompt, count: 2 });
  check("two variants queued", made.status === 201 && made.body.group.drafts.length === 2, `${made.status} ${made.body.error ?? ""}`);
  const groupId = made.body.group?.id;
  check("second set refused while one is open", (await call(V, { action: "create", prompt: "x" })).status === 400);
  check("can't choose while building", (await call(V, { action: "choose", groupId, draftId: made.body.group.drafts[0] })).status === 400);

  let group: any = null;
  for (let i = 0; i < 90; i++) {
    group = (await call(V)).body.group;
    if (group && group.variants.every((v: any) => v.state === "ready" || v.state === "failed")) break;
    await sleep(10_000);
  }
  const states = group?.variants.map((v: any) => v.state).join(",");
  check("both variants built", group?.variants.every((v: any) => v.state === "ready"), states);
  const [a, b] = group.variants;
  check("each variant has its own version", !!a.headSha && !!b.headSha && a.headSha !== b.headSha);

  const msgs = (await call(`/api/projects/${pid}/messages`)).body.messages as any[];
  const asks = msgs.filter((m) => m.role === "USER" && m.mode === "variant").map((m) => m.content as string);
  check("each variant got its own take", asks.length === 2 && asks[0].includes("Variant 1 of 2") && asks[1].includes("Variant 2 of 2"));


  const chosen = await call(V, { action: "choose", groupId, draftId: b.id });
  check("choosing variant 2 works", chosen.status === 200, chosen.body.error ?? "");
  check("set closed", (await call(V)).body.group === null);
  // The list also shows accepted drafts; only the chosen one may remain, as MERGED.
  const drafts = (await call(`/api/projects/${pid}/drafts`)).body.drafts as any[];
  check(
    "only the chosen variant remains, accepted",
    drafts.length === 1 && drafts[0].id === b.id && drafts[0].status === "MERGED",
    JSON.stringify(drafts.map((d) => ({ name: d.name, status: d.status }))),
  );
  // With nothing else on main, accepting fast-forwards to the variant's own commit.
  const after = (await call(`/api/projects/${pid}/history`)).body.commits as any[];
  check(
    "main moved to the chosen variant",
    // (History follows what's checked out, so a count taken earlier may already include the draft.)
    after[0]?.sha === b.headSha && !after.some((c) => c.sha === a.headSha),
    `head=${after[0]?.sha.slice(0, 7)} a=${a.headSha?.slice(0, 7)} b=${b.headSha?.slice(0, 7)} ` +
      after.slice(0, 4).map((c) => `${c.sha.slice(0, 7)}:${c.message.slice(0, 30)}`).join(" | "),
  );
  check("can start a new set now", (await call(V, { action: "create", prompt: " " })).status === 400 && (await call(V)).body.group === null);
}

main()
  .catch((e) => {
    console.log("FAIL crashed —", e);
    failures++;
  })
  .finally(async () => {
    if (pid) await call(`/api/projects/${pid}?permanent=1`, undefined, "DELETE");
    console.log(failures ? `\n${failures} failed` : "\nAll passed");
    process.exit(failures ? 1 : 0);
  });
