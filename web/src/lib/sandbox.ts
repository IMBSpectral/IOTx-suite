import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { PROJECTS_ROOT, repoDir } from "./paths";
import { scaffold } from "./scaffold";

/**
 * Per-project dev containers.
 *
 * Each project gets its own container running a real Vite dev server, which
 * is what makes npm dependencies, multi-file routing and HMR possible — none
 * of which an in-process esbuild bundle can do.
 *
 * Containers are disposable and idle-reaped: a project that nobody is looking
 * at should not hold a port and a few hundred MB of RAM.
 */

// Docker ships its credential helper beside the CLI, and a PATH without that
// directory fails every pull with a confusing credentials error.
// Docker Desktop on Windows; on Linux servers the docker CLI is on PATH.
const WINDOWS = process.platform === "win32";
const DOCKER_BIN = process.env.DOCKER_BIN ?? (WINDOWS ? "C:/Program Files/Docker/Docker/resources/bin" : "/usr/bin");
const DOCKER = path.join(DOCKER_BIN, WINDOWS ? "docker.exe" : "docker");

const IMAGE = process.env.SANDBOX_IMAGE ?? "node:22-alpine";
// A preview nobody is using is stopped after this long (SANDBOX_IDLE_MS overrides).
export const IDLE_MS = Number(process.env.SANDBOX_IDLE_MS) || 10 * 60 * 1000;
const BOOT_TIMEOUT_MS = 420_000;

/**
 * Install dependencies when the manifest changed since the last install.
 *
 * node_modules is a volume, so the directory always exists and its presence
 * says nothing. A copy of the package.json that was installed is kept inside
 * it instead: a differing manifest — the agent added a dependency — reinstalls.
 */
const INSTALL_IF_CHANGED =
  "cd /app && " +
  "if [ ! -f node_modules/.forge-installed ] || ! cmp -s package.json node_modules/.forge-installed; then " +
  "npm install --no-audit --no-fund --loglevel=error && cp package.json node_modules/.forge-installed; " +
  "fi";

/**
 * Vite config the dev server starts with: the project's own config plus the
 * editor bridge (Select, Comment, pins). Projects scaffolded before the bridge
 * existed get it too, and it never touches the project's files: it is
 * mounted read-only inside the node_modules volume, where `vite` resolves.
 */
const FORGE_VITE_CONFIG = `import { loadConfigFromFile, mergeConfig } from "vite";

const bridge = {
  name: "forge-editor-bridge",
  apply: "serve",
  transformIndexHtml(html) {
    if (html.includes("/inspector.js")) return html;
    const origin = process.env.EDITOR_ORIGIN || "http://localhost:3000";
    return html.replace("</body>", '<script src="' + origin + '/inspector.js"></script></body>');
  },
};

export default async (env) => {
  const loaded = await loadConfigFromFile(env, undefined, "/app");
  // Behind the HTTPS preview proxy, live reload connects back over wss on 443.
  const hmr = process.env.FORGE_HMR_CLIENT_PORT ? { clientPort: Number(process.env.FORGE_HMR_CLIENT_PORT), protocol: "wss" } : undefined;
  return mergeConfig(loaded ? loaded.config : {}, { plugins: [bridge], server: { allowedHosts: true, ...(hmr ? { hmr } : {}) } });
};
`;

async function forgeViteConfigPath() {
  const file = path.join(path.dirname(repoDir("_")), "_forge", "vite.forge.mjs");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const current = await fs.readFile(file, "utf8").catch(() => "");
  if (current !== FORGE_VITE_CONFIG) await fs.writeFile(file, FORGE_VITE_CONFIG);
  return file;
}

export type SandboxState =
  // "idle": paused by the reaper while nobody was looking.
  | { status: "stopped"; reason?: "idle" }
  // The dev server stopped answering while it was supposed to be running.
  | { status: "crashed"; since: number }
  | { status: "booting"; since: number }
  | { status: "ready"; port: number; since: number }
  | { status: "failed"; error: string; since: number };

type Entry = {
  state: SandboxState;
  lastSeen: number;
  booting?: Promise<SandboxState>;
  log: string[];
};

// One table per process (route bundles, instrumentation and the preview proxy all see it).
const g = globalThis as unknown as { __forgeSandboxes?: Map<string, Entry> };
const sandboxes = g.__forgeSandboxes ?? (g.__forgeSandboxes = new Map<string, Entry>());

function entry(projectId: string): Entry {
  let e = sandboxes.get(projectId);
  if (!e) {
    e = { state: { status: "stopped" }, lastSeen: Date.now(), log: [] };
    sandboxes.set(projectId, e);
  }
  return e;
}

export function containerName(projectId: string) {
  return `forge-dev-${projectId}`;
}

export function docker(args: string[], timeoutMs = 60_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(DOCKER, args, {
      env: { ...process.env, PATH: `${DOCKER_BIN}${path.delimiter}${process.env.PATH ?? ""}` },
      windowsHide: true,
    });
    let out = "";
    const done = (code: number) => resolve({ code, out });
    const timer = setTimeout(() => {
      child.kill();
      done(-1);
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code ?? -1);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      out += String(err);
      done(-1);
    });
  });
}

/** Ask the OS for a free port rather than guessing and colliding. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Wait until the dev server inside the container actually answers HTTP.
 *
 * A TCP connect is not enough: Docker's port forwarder accepts connections as
 * soon as the container exists, long before Vite is listening, so a socket
 * probe reports ready while `npm install` is still running.
 */
async function waitForHttp(port: number, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/", timeout: 3000 },
        (res) => {
          res.resume();
          // Any HTTP status means something is serving; Vite may 404 a path
          // but it will not answer at all before it is up.
          resolve((res.statusCode ?? 0) > 0);
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/** A running, answering container for this project, if one exists. */
async function adoptRunning(projectId: string): Promise<SandboxState | null> {
  const name = containerName(projectId);
  const running = await docker(["inspect", "-f", "{{.State.Running}}", name], 15_000);
  if (running.code !== 0 || running.out.trim() !== "true") return null;

  // "127.0.0.1:49904" — the host side of the dev server's port mapping.
  const mapped = await docker(["port", name, "5173/tcp"], 15_000);
  const port = Number(mapped.out.trim().split(String.fromCharCode(10))[0]?.split(":").pop());
  if (!Number.isInteger(port) || port <= 0) return null;

  const up = await waitForHttp(port, Date.now() + 5_000);
  return up ? { status: "ready", port, since: Date.now() } : null;
}

async function removeExisting(projectId: string) {
  await docker(["rm", "-f", containerName(projectId)], 30_000);
}

/**
 * Boot a dev container for a project. Idempotent: concurrent callers share
 * the same boot promise rather than racing to create duplicate containers.
 */
export async function ensureSandbox(projectId: string): Promise<SandboxState> {
  const e = entry(projectId);
  e.lastSeen = Date.now();

  if (e.state.status === "ready") return e.state;
  if (e.booting) return e.booting;

  e.booting = (async (): Promise<SandboxState> => {
    e.state = { status: "booting", since: Date.now() };
    e.log = [];

    try {
      const dir = repoDir(projectId);
      await fs.access(dir);

      // The registry is in-process memory, so a server restart forgets a
      // container that is still running fine. Adopt it rather than paying for
      // a fresh boot.
      const adopted = await adoptRunning(projectId);
      if (adopted) {
        e.state = adopted;
        return adopted;
      }
      await removeExisting(projectId);
      // First boot: copy the ready-made node_modules instead of installing.
      await seedFromTemplate(projectId).catch(() => false);

      const port = await freePort();

      // npm install runs inside the container so native deps match the
      // container's platform, not the host's.
      const script =
        "cd /app && " +
        INSTALL_IF_CHANGED + " && " +
        "npx vite --config node_modules/.forge/vite.forge.mjs --host 0.0.0.0 --port 5173 --strictPort";
      const forgeConfig = await forgeViteConfigPath();

      const run = await docker(
        [
          "run", "-d",
          "--name", containerName(projectId),
          "-p", `127.0.0.1:${port}:5173`,
          "-v", `${dir}:/app`,
          // node_modules lives in a container-owned volume, never in the git
          // working tree: git has to walk the tree to check out a branch, and
          // a half-million files of dependencies there make that slow on a
          // bind mount and outright fail on locked symlinks.
          "-v", `forge-nm-${projectId}:/app/node_modules`,
          // Shared npm cache: a new package downloads once for every project.
          "-v", `${NPM_CACHE_VOLUME}:/root/.npm`,
          "-v", `${forgeConfig}:/app/node_modules/.forge/vite.forge.mjs:ro`,
          "-w", "/app",
          // The bridge script is loaded by the visitor's browser, so it needs the public editor address.
          "-e", `EDITOR_ORIGIN=${process.env.EDITOR_ORIGIN ?? "http://localhost:3000"}`,
          ...(process.env.SANDBOX_PUBLIC_HOST ? ["-e", "FORGE_HMR_CLIENT_PORT=443"] : []),
          "--memory", "1g",
          "--cpus", "1.5",
          IMAGE,
          "sh", "-lc", script,
        ],
        120_000,
      );

      if (run.code !== 0) {
        const state: SandboxState = {
          status: "failed",
          error: run.out.trim().slice(0, 1000) || "docker run failed",
          since: Date.now(),
        };
        e.state = state;
        return state;
      }

      const up = await waitForHttp(port, Date.now() + BOOT_TIMEOUT_MS);
      if (!up) {
        const logs = await docker(["logs", "--tail", "40", containerName(projectId)], 20_000);
        const state: SandboxState = {
          status: "failed",
          error: logs.out.trim().slice(0, 2000) || "dev server did not start in time",
          since: Date.now(),
        };
        e.state = state;
        return state;
      }

      const state: SandboxState = { status: "ready", port, since: Date.now() };
      e.state = state;
      return state;
    } catch (err) {
      const state: SandboxState = {
        status: "failed",
        error: err instanceof Error ? err.message : "sandbox boot failed",
        since: Date.now(),
      };
      e.state = state;
      return state;
    } finally {
      e.booting = undefined;
    }
  })();

  return e.booting;
}

export function sandboxState(projectId: string): SandboxState {
  return entry(projectId).state;
}

export function touchSandbox(projectId: string) {
  entry(projectId).lastSeen = Date.now();
}

/** For a purged project: remove its container and its node_modules volume, which would otherwise stay forever. */
export async function destroySandbox(projectId: string) {
  await removeExisting(projectId);
  await docker(["volume", "rm", "-f", `forge-nm-${projectId}`], 60_000);
  sandboxes.delete(projectId);
}

export async function stopSandbox(projectId: string, reason?: "idle") {
  await removeExisting(projectId);
  const e = entry(projectId);
  e.state = reason ? { status: "stopped", reason } : { status: "stopped" };
}

/**
 * Confirm a "ready" sandbox still answers. A dev server that died (crashed,
 * out of memory, container removed) is marked "crashed" so the editor can
 * say so and restart it, instead of showing a dead frame.
 */
export async function checkAlive(projectId: string): Promise<SandboxState> {
  const e = entry(projectId);
  if (e.state.status !== "ready" || e.booting) return e.state;
  const up = await waitForHttp(e.state.port, Date.now() + 2_000);
  if (!up) e.state = { status: "crashed", since: Date.now() };
  return e.state;
}

/** Read the dev server's output — this is where Vite reports build errors. */
export async function sandboxLogs(projectId: string, tail = 60) {
  const r = await docker(["logs", "--tail", String(tail), containerName(projectId)], 20_000);
  return r.out;
}

/**
 * After a server restart, dev containers from before are still running but
 * unknown to the registry, so the reaper would never stop them. Take them
 * over, as if just used, so they're paused after the normal idle time.
 */
async function adoptOrphans() {
  const r = await docker(["ps", "--filter", "name=forge-dev-", "--format", "{{.Names}}"], 30_000);
  if (r.code !== 0) return;
  for (const name of r.out.split(/\s+/).filter(Boolean)) {
    const projectId = name.replace(/^forge-dev-/, "");
    const e = entry(projectId);
    if (e.state.status !== "stopped" || e.booting) continue;
    const state = await adoptRunning(projectId).catch(() => null);
    if (state) {
      e.state = state;
      e.lastSeen = Date.now();
    } else {
      // Running but not answering: nothing is using it.
      await removeExisting(projectId);
    }
  }
}

/** Reap idle containers so an open tab is the only thing holding resources. */
let reaper: ReturnType<typeof setInterval> | undefined;
export function ensureReaper() {
  if (reaper) return;
  void adoptOrphans();
  reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, e] of sandboxes) {
      if (e.state.status === "ready" && now - e.lastSeen > IDLE_MS) {
        void stopSandbox(id, "idle");
      }
    }
  }, Math.min(60_000, Math.max(5_000, IDLE_MS / 4)));
  reaper.unref?.();
}

// ── Warm starts ──────────────────────────────────────────────────────────
// Every new project used to run a full npm install on its first boot (one to
// two minutes). Instead, the standard project's node_modules is installed
// once into a template volume and copied into each new project's volume, and
// all containers share one npm cache, so a project that adds packages only
// downloads those.

const NPM_CACHE_VOLUME = "forge-npm-cache";
let template: Promise<string | null> | null = null;

/** The template volume for the standard package.json, built once (null if it can't be). */
function ensureTemplate(): Promise<string | null> {
  template ??= (async () => {
    const pkg = scaffold("template").find((x) => x.path === "package.json")?.content;
    if (!pkg) return null;
    const vol = `forge-nm-template-${createHash("sha1").update(pkg).digest("hex").slice(0, 12)}`;
    const ready = await docker(["run", "--rm", "-v", `${vol}:/nm`, IMAGE, "test", "-f", "/nm/.forge-template-ok"], 60_000);
    if (ready.code === 0) return vol;
    const dir = path.join(PROJECTS_ROOT, "_forge", "nm-template");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "package.json"), pkg);
    const built = await docker(
      [
        "run", "--rm",
        "-v", `${dir}:/app`,
        "-v", `${vol}:/app/node_modules`,
        "-v", `${NPM_CACHE_VOLUME}:/root/.npm`,
        "-w", "/app",
        IMAGE,
        "sh", "-lc",
        "npm install --no-audit --no-fund --loglevel=error && cp package.json node_modules/.forge-installed && touch node_modules/.forge-template-ok",
      ],
      600_000,
    );
    if (built.code !== 0) {
      template = null; // try again next time
      return null;
    }
    return vol;
  })();
  return template;
}

/** A brand-new project starts from the template instead of an empty node_modules. */
async function seedFromTemplate(projectId: string) {
  const vol = `forge-nm-${projectId}`;
  if ((await docker(["volume", "inspect", vol], 15_000)).code === 0) return false;
  const tmpl = await ensureTemplate();
  if (!tmpl) return false;
  const r = await docker(["run", "--rm", "-v", `${tmpl}:/from:ro`, "-v", `${vol}:/to`, IMAGE, "sh", "-c", "cp -a /from/. /to/ && rm -f /to/.forge-template-ok"], 300_000);
  return r.code === 0;
}

/** Start building the template in the background (called when the server starts using sandboxes). */
export function warmUp() {
  void dockerAvailable().then((ok) => (ok ? ensureTemplate() : null));
}

export async function dockerAvailable(): Promise<boolean> {
  const r = await docker(["version", "--format", "{{.Server.Version}}"], 15_000);
  return r.code === 0 && r.out.trim().length > 0;
}

/**
 * Run a shell command in the project's container, from /app. Dependencies are
 * brought up to date first unless `install` is false, so commands always see
 * the packages the manifest declares.
 */
export async function sandboxExec(
  projectId: string,
  command: string,
  timeoutMs = 120_000,
  opts: { install?: boolean } = {},
) {
  const script = opts.install === false ? `cd /app && ${command}` : `${INSTALL_IF_CHANGED} && ${command}`;
  // The agent working in the container counts as activity.
  touchSandbox(projectId);
  try {
    return await docker(["exec", containerName(projectId), "sh", "-lc", script], timeoutMs);
  } finally {
    touchSandbox(projectId);
  }
}

/**
 * Verify the project with its real toolchain: install whatever the manifest
 * now asks for, then run a production Vite build inside the project's
 * container. This is the same check a deploy would make, so it catches
 * missing dependencies, bad aliases and CSS errors that a standalone bundler
 * cannot see.
 */
export async function verifyInSandbox(
  projectId: string,
): Promise<{ ok: boolean; error?: string }> {
  const state = await ensureSandbox(projectId);
  if (state.status !== "ready") {
    return {
      ok: false,
      error: state.status === "failed" ? state.error : "Dev server is not running",
    };
  }
  const r = await docker(
    [
      "exec",
      containerName(projectId),
      "sh",
      "-lc",
      INSTALL_IF_CHANGED +
        // Typecheck first, as Lovable's own build check does: vite build
        // strips types without checking them, so type errors would pass.
        " && npx tsc -p . --noEmit" +
        " && npx vite build --outDir /tmp/forge-verify --emptyOutDir --logLevel error",
    ],
    240_000,
  );
  if (r.code === 0) return { ok: true };
  // Stack frames from the bundler are noise to the repair loop and cost
  // tokens on every retry; the error message itself is what it needs.
  const message = r.out
    .split(String.fromCharCode(10))
    .filter((l) => !/^\s+at\s/.test(l))
    .join(String.fromCharCode(10))
    .trim();
  return { ok: false, error: message.slice(-4000) || "Build failed" };
}
