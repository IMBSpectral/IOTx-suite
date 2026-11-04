import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { enforceInvariants } from "../src/lib/invariants";

/** Does a second run add a second import? That is the bug to prove fixed. */
async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "inv-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src/index.css"), "@tailwind base;\n");

  // Case 1: entry missing the import
  await fs.writeFile(
    path.join(dir, "src/main.tsx"),
    'import React from "react";\nimport App from "./App";\n\ncreateRoot(el).render(<App />);\n',
  );
  const first = await enforceInvariants(dir);
  const afterFirst = await fs.readFile(path.join(dir, "src/main.tsx"), "utf8");
  console.log("run1 repairs:", first.length, "| imports:", (afterFirst.match(/index\.css/g) ?? []).length);

  // Case 2: idempotency — running again must change nothing
  const second = await enforceInvariants(dir);
  const afterSecond = await fs.readFile(path.join(dir, "src/main.tsx"), "utf8");
  console.log("run2 repairs:", second.length, "| imports:", (afterSecond.match(/index\.css/g) ?? []).length);

  console.log(afterSecond.trim().split("\n").slice(0, 4).join(" | "));
  await fs.rm(dir, { recursive: true, force: true });
}
main();
