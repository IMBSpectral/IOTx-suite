import { enforceInvariants } from "../src/lib/invariants";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = "D:/ImbSpectral/REA-V1/projects-data";

async function main() {
  const dirs = await fs.readdir(ROOT);
  for (const d of dirs) {
    const full = path.join(ROOT, d);
    const repairs = await enforceInvariants(full).catch(() => []);
    if (repairs.length) {
      console.log(`${d}:`);
      for (const r of repairs) console.log(`   ${r.file} — ${r.note}`);
    }
  }
}
main();
