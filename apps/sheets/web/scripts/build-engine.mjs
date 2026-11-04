// Builds engine-wasm for the browser and writes the wasm-bindgen glue into src/engine/pkg.
// Usage: npm run engine            (release, the default)
//        npm run engine -- --dev   (faster build, slower engine)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const crate = resolve(here, "../../engine-wasm");
const target = resolve(crate, "../target");
const out = resolve(here, "../src/engine/pkg");
const dev = process.argv.includes("--dev");
const profile = dev ? "debug" : "release";

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

run("cargo", ["build", "--lib", "--target", "wasm32-unknown-unknown", ...(dev ? [] : ["--release"])], {
  cwd: crate,
  env: { ...process.env, CARGO_TARGET_DIR: target },
});

const wasm = join(target, "wasm32-unknown-unknown", profile, "sheets_engine.wasm");
if (!existsSync(wasm)) throw new Error(`missing ${wasm}`);
mkdirSync(out, { recursive: true });
run("wasm-bindgen", ["--target", "web", "--out-dir", out, "--out-name", "sheets_engine", wasm]);
console.log(`engine written to ${out}`);
