/**
 * Design systems and canvases end to end over the API: create a design
 * system, reject bad tokens, save and publish versions, attach to an app
 * (CSS block, font imports, tokens.json), update to a new version without
 * duplicating anything, detach; create a canvas, save and read shapes,
 * reject junk. Everything it creates is permanently deleted at the end.
 *   npx tsx scripts/test-design-canvas.mts <devToken>
 */
const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function call(path: string, json?: unknown, method?: string) {
  const res = await fetch(BASE + path, {
    method: method ?? (json === undefined ? "GET" : "POST"),
    headers: { cookie: `authjs.session-token=${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
const file = async (pid: string, path: string) =>
  (await call(`/api/projects/${pid}/files?path=${encodeURIComponent(path)}`)).body.content as string | undefined;

const created: string[] = [];

async function main() {
  // ── Design system ─────────────────────────────────────────────
  const ds = await call("/api/projects", { kind: "design_system", name: "Test Brand" });
  check("design system created", ds.status === 201 && ds.body.project.kind === "design_system", `status ${ds.status}`);
  const dsId = ds.body.project.id as string;
  created.push(dsId);
  const DS = `/api/projects/${dsId}/design-system`;

  const g = await call(DS);
  check("starts at version 0 with default tokens", g.body.version === 0 && g.body.tokens.name === "Test Brand");
  check("style guide written", (await file(dsId, "src/App.tsx"))?.includes("design-system.json") === true);

  const tokens = { ...g.body.tokens, colors: { ...g.body.tokens.colors, primary: "#e11d48" }, fonts: { heading: "Playfair Display", body: "Inter" } };
  check("bad colour refused", (await call(DS, { action: "save", tokens: { ...tokens, colors: { ...tokens.colors, primary: "red" } } })).status === 400);
  check("bad radius refused", (await call(DS, { action: "save", tokens: { ...tokens, radius: "big" } })).status === 400);
  check("empty font refused", (await call(DS, { action: "save", tokens: { ...tokens, fonts: { heading: " ", body: "Inter" } } })).status === 400);
  const saved = await call(DS, { action: "save", tokens });
  check("tokens saved", saved.status === 200 && saved.body.tokens.colors.primary === "#e11d48");
  check("saved tokens are in the repo", JSON.parse((await file(dsId, "design-system.json")) ?? "{}").colors?.primary === "#e11d48");

  // An app can't attach an unpublished system.
  const app = await call("/api/projects", { name: "DS test app" });
  const appId = app.body.project?.id as string;
  created.push(appId);
  check("app created", app.status === 201 && !!appId, `status ${app.status}`);
  const AP = `/api/projects/${appId}/design-system`;
  check("unpublished system can't be attached", (await call(AP, { action: "attach", designSystemId: dsId })).status === 400);
  check("unpublished system isn't offered", !(await call(AP)).body.available.some((s: any) => s.id === dsId));

  const p1 = await call(DS, { action: "publish" });
  check("published v1", p1.body.version === 1);
  check("v1 snapshot kept", JSON.parse((await file(dsId, "versions/v1.json")) ?? "{}").colors?.primary === "#e11d48");
  check("published system is offered", (await call(AP)).body.available.some((s: any) => s.id === dsId));

  check("can't publish an app as a version", (await call(AP, { action: "publish" })).status === 400);
  check("can't attach a system to itself or another system", (await call(DS, { action: "attach", designSystemId: dsId })).status === 400);
  check("unknown system refused", (await call(AP, { action: "attach", designSystemId: "nope" })).status === 400);

  const att = await call(AP, { action: "attach", designSystemId: dsId });
  check("attached v1", att.status === 200 && att.body.version === 1);
  const css1 = (await file(appId, "src/index.css")) ?? "";
  check("CSS block installed", css1.includes("forge-design-system:start Test Brand v1") && css1.includes("--primary: 347 77% 50%"));
  check("font imports lead the file", css1.trimStart().startsWith("@import") && css1.includes("Playfair%20Display"));
  check("tokens.json for the agent", JSON.parse((await file(appId, "src/design-system/tokens.json")) ?? "{}").version === 1);
  let info = (await call(AP)).body.attached;
  check("attached, no update pending", info?.id === dsId && info.installed === 1 && info.updateAvailable === false);

  // New version: different heading font and primary colour.
  await call(DS, { action: "save", tokens: { ...tokens, colors: { ...tokens.colors, primary: "#2563eb" }, fonts: { heading: "Lora", body: "Inter" } } });
  check("published v2", (await call(DS, { action: "publish" })).body.version === 2);
  info = (await call(AP)).body.attached;
  check("app sees update to v2", info?.latest === 2 && info.updateAvailable === true);

  const up = await call(AP, { action: "update" });
  check("updated to v2", up.status === 200 && up.body.version === 2);
  const css2 = (await file(appId, "src/index.css")) ?? "";
  const count = (s: string, needle: string) => s.split(needle).length - 1;
  check("one managed block after update", count(css2, "forge-design-system:start") === 1 && css2.includes("Test Brand v2"));
  check("old font import replaced", !css2.includes("Playfair") && css2.includes("family=Lora"));
  check("body font imported once", count(css2, "family=Inter") === 1, `${count(css2, "family=Inter")} imports`);
  check("app's own CSS kept", css2.includes("@tailwind") || css2.length > css2.indexOf("forge-design-system:end"));
  check("new colour installed", css2.includes("--primary: 221 83% 53%"));
  check("no update pending", (await call(AP)).body.attached?.updateAvailable === false);

  check("detached", (await call(AP, { action: "detach" })).status === 200 && (await call(AP)).body.attached === null);
  check("update needs an attached system", (await call(AP, { action: "update" })).status === 400);
  check("tokens stay in code after detach", ((await file(appId, "src/index.css")) ?? "").includes("Test Brand v2"));

  // ── Canvas ────────────────────────────────────────────────────
  const cv = await call("/api/projects", { kind: "canvas", name: "Test sketch" });
  const cvId = cv.body.project?.id as string;
  created.push(cvId);
  check("canvas created", cv.status === 201 && cv.body.project.kind === "canvas");
  const CV = `/api/projects/${cvId}/canvas`;
  check("starts empty", (await call(CV)).body.shapes?.length === 0);
  const shapes = [
    { id: "a", type: "rect", x: 10, y: 10, w: 200, h: 120, stroke: "#16141f", fill: "transparent" },
    { id: "b", type: "arrow", x: 210, y: 70, x2: 400, y2: 70, stroke: "#6d4aff" },
    { id: "c", type: "text", x: 20, y: 40, text: "Login", size: 500, stroke: "#16141f" },
    { id: "d", type: "draw", points: [[0, 0], [5, 5], [10, 3]], stroke: "#e11d48" },
    { id: "e", type: "rect", x: "oops", y: 0, w: 1, h: 1 },
    { id: "f", type: "script", src: "evil" },
    { id: "g", type: "ellipse", x: 0, y: 0, w: 50, h: 50, stroke: "url(javascript:x)", fill: "#fff" },
  ];
  const put = await call(CV, { version: 1, shapes }, "PUT");
  check("saved, junk shapes dropped", put.status === 200 && put.body.shapes === 5, `kept ${put.body.shapes}`);
  const back = (await call(CV)).body.shapes as any[];
  check("shapes read back in order", back.map((s) => s.id).join("") === "abcdg");
  check("text size clamped", back.find((s) => s.id === "c")?.size === 200);
  check("unsafe colour replaced", back.find((s) => s.id === "g")?.stroke === "#16141f");
  check("canvas API refuses apps", (await call(`/api/projects/${appId}/canvas`)).status === 400);
  check("design-system save refuses canvases", (await call(`/api/projects/${cvId}/design-system`, { action: "save", tokens })).status === 400);
  check("too many shapes refused", (await call(CV, { shapes: Array.from({ length: 5001 }, (_, i) => ({ id: `s${i}`, type: "line", x: 0, y: 0, x2: 1, y2: 1 })) }, "PUT")).status === 400);

  // Listing shows the kinds for the dashboard badges.
  const list = (await call("/api/projects?view=all")).body.projects as any[] | undefined;
  if (list) {
    check("listing carries kinds", list.find((p) => p.id === dsId)?.kind === "design_system" && list.find((p) => p.id === cvId)?.kind === "canvas");
  }
}

main()
  .catch((e) => {
    console.log("FAIL crashed —", e);
    failures++;
  })
  .finally(async () => {
    for (const id of created.filter(Boolean)) await call(`/api/projects/${id}?permanent=1`, undefined, "DELETE");
    console.log(failures ? `\n${failures} failed` : "\nAll passed");
    process.exit(failures ? 1 : 0);
  });
