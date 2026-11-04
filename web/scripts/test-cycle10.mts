/**
 * Design system from an app (token extraction), hiding projects from your
 * own lists, and the approved-plan marker. Throwaway projects only.
 *   npx tsx scripts/test-cycle10.mts <devToken>
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { hslToHex, readTokens, tokensFromApp } from "../src/lib/design-systems";
import { commit, writeFiles } from "../src/lib/repo";
import { APPROVED_PLAN_PREFIX } from "../src/lib/generate";

const BASE = "http://localhost:3000";
const [token] = process.argv.slice(2);
const cookie = `authjs.session-token=${token}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const json = (method: string, body: unknown) => ({ method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const projects: string[] = [];

try {
  // ── Colours ──
  check("hsl → hex", hslToHex("0 100% 50%") === "#ff0000" && hslToHex("hsl(240 100% 50%)") === "#0000ff" && hslToHex("0 0% 100%") === "#ffffff");
  check("not a colour", hslToHex("var(--x)") === null);

  // ── Design system from an app ──
  const created = await (await fetch(`${BASE}/api/projects`, json("POST", { name: "Brand source app", force: true }))).json();
  const app = created.project.id as string;
  projects.push(app);
  await writeFiles(app, [
    {
      path: "src/index.css",
      content: `@import url("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700&display=swap");
@tailwind base;
:root {
  --background: 0 0% 100%;
  --foreground: 222 47% 11%;
  --primary: 160 84% 39%;
  --secondary: 210 40% 96%;
  --accent: 38 92% 50%;
  --muted-foreground: 215 16% 47%;
  --border: 214 32% 91%;
  --destructive: 0 84% 60%;
  --radius: 0.5rem;
}
.dark { --background: 222 47% 11%; }
`,
    },
  ]);
  await db.project.update({ where: { id: app }, data: { headSha: await commit(app, "Brand colours") } });
  const tokens = await tokensFromApp(app, "Test DS");
  check("colours read from the app's CSS variables", tokens.colors.primary === hslToHex("160 84% 39%") && tokens.colors.background === "#ffffff", JSON.stringify(tokens.colors));
  check("light theme used, not .dark", tokens.colors.background === "#ffffff");
  check("radius and font", tokens.radius === "0.5rem" && tokens.fonts.body === "Space Grotesk", `${tokens.radius} ${tokens.fonts.body}`);
  const ex = await fetch(`${BASE}/api/projects/${app}/design-system`, json("POST", { action: "extract" }));
  const eb = await ex.json();
  if (eb.designSystemId) projects.push(eb.designSystemId);
  check("extract creates a published design system", ex.status === 201 && eb.version === 1 && !!eb.designSystemId, JSON.stringify(eb).slice(0, 120));
  if (eb.designSystemId) {
    const ds = await db.project.findUniqueOrThrow({ where: { id: eb.designSystemId } });
    check("…with the app's tokens", ds.kind === "design_system" && (await readTokens(ds.id)).colors.primary === tokens.colors.primary && ds.name === "Brand source app design system");
    const attach = await (await fetch(`${BASE}/api/projects/${app}/design-system`, json("POST", { action: "attach", designSystemId: ds.id }))).json();
    check("the app can attach it", attach.ok === true && attach.version === 1);
  }
  check("only apps can be extracted", (await fetch(`${BASE}/api/projects/${eb.designSystemId}/design-system`, json("POST", { action: "extract" }))).status === 400);

  // ── Hide from my lists ──
  await fetch(`${BASE}/api/projects/bulk`, json("POST", { action: "hide", ids: [app] }));
  const all = await (await fetch(`${BASE}/api/projects?view=all`, { headers: { cookie } })).json();
  const hidden = await (await fetch(`${BASE}/api/projects?view=hidden`, { headers: { cookie } })).json();
  const ids = (x: unknown) => ((x as { projects?: { id: string }[] }).projects ?? (x as { id: string }[])).map((p) => p.id);
  check("hidden project leaves All", !ids(all).includes(app));
  check("…and shows under Hidden", ids(hidden).includes(app));
  await fetch(`${BASE}/api/projects/bulk`, json("POST", { action: "unhide", ids: [app] }));
  const back = await (await fetch(`${BASE}/api/projects?view=all`, { headers: { cookie } })).json();
  check("unhide brings it back", ids(back).includes(app));

  // ── Approved plan marker ──
  check("approved-plan instruction matches the editor's", `Implement this approved plan. Follow it step by step.\n\nplan`.startsWith(APPROVED_PLAN_PREFIX));
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  for (const id of projects) await fetch(`${BASE}/api/projects/${id}?permanent=1`, { method: "DELETE", headers: { cookie } });
  await db.projectHide.deleteMany({ where: { projectId: { in: projects } } });
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}
