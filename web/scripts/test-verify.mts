import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { verifyInSandbox } from "../src/lib/sandbox";
import { repoDir } from "../src/lib/paths";

const PID = process.argv[2];
const NL = String.fromCharCode(10);

async function check(label: string, prefix: string | null) {
  const app = path.join(repoDir(PID), "src/App.tsx");
  const orig = await fs.readFile(app, "utf8");
  if (prefix) await fs.writeFile(app, prefix + NL + orig);
  const t = Date.now();
  const r = await verifyInSandbox(PID);
  await fs.writeFile(app, orig);
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  const excerpt = (r.error ?? "").split(NL).filter(Boolean).slice(-2).join(" | ").slice(0, 260);
  console.log(label.padEnd(16), "ok=" + r.ok, "(" + secs + "s)", excerpt);
}

async function main() {
  await check("clean scaffold:", null);
  // Side-effect imports cannot be erased by the TS transform, so this must fail.
  await check("broken import:", 'import "@/components/DoesNotExist";');
  // Compiles under vite (types are stripped) but must fail the typecheck.
  await check("type error:", 'const n: number = "not a number";');
}
main().catch((e) => {
  console.error("THREW:", e.message);
  process.exit(1);
});
