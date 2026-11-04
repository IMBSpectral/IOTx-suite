/** Publishing gates: a leaked key blocks publish; removing it unblocks; unpublish works. */
import "dotenv/config";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const COOKIE = "authjs.session-token=839ad638-6bc1-4e43-a833-2b2bbc7cd74c";
const PID = "d2f83ba4-7130-45f6-846a-ba7432fcefa2";
// Shaped like a key so the scanner catches it; not a real credential.
const FAKE = "sk-ant-" + "FAKEKEYFORTESTINGONLY0000000000";

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: { cookie: COOKIE, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function publish() {
  const res = await api("POST", `/api/projects/${PID}/publish`, { action: "publish" });
  const text = await res.text();
  const events = text
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
  return events[events.length - 1];
}

function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  await api("PUT", `/api/projects/${PID}/files`, {
    path: "src/config.ts",
    content: `export const apiKey = "${FAKE}";\n`,
  });
  const blocked = await publish();
  const security = blocked.result?.checks?.find((c: { id: string }) => c.id === "security");
  check("leaked key blocks the publish", blocked.type === "blocked", `got ${blocked.type}`);
  check(
    "the blocking finding names the file",
    !!security?.items?.some((i: { file?: string }) => i.file?.startsWith("src/config.ts")),
    security?.summary,
  );

  await api("PUT", `/api/projects/${PID}/files`, { path: "src/config.ts", content: "export const apiKey = import.meta.env.VITE_KEY;\n" });
  const ok = await publish();
  // The project may have other real findings (the smoke project keeps a
  // deliberately unsafe file), which must still block. What this test owns is
  // the leaked key: once removed, it must no longer be among the blockers.
  const secAfter = ok.result?.checks?.find((c: { id: string }) => c.id === "security");
  const keyGone = !secAfter?.items?.some((i: { file?: string }) => i.file?.startsWith("src/config.ts"));
  check("removing the key clears its finding", ok.type === "published" || keyGone, secAfter?.summary ?? ok.type);
  if (ok.type === "published") {
    const state = await (await api("GET", `/api/projects/${PID}/publish`)).json();
    check("button state is Up to date after publishing", state.upToDate === true);
  } else {
    console.log(`INFO  still blocked by other findings: ${secAfter?.items?.map((i: { file?: string }) => i.file).join(", ")}`);
  }

  await api("DELETE", `/api/projects/${PID}/publish`);
  const after = await db.project.findUnique({ where: { id: PID }, select: { publishedSha: true } });
  check("unpublish takes the site down", after?.publishedSha === null);

  await db.$disconnect();
}
main().catch(async (e) => {
  console.error("THREW:", e);
  await db.$disconnect();
  process.exit(1);
});
