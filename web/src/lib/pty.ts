import http from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { containerName, touchSandbox } from "./sandbox";

/**
 * Interactive terminals in a project's container. The Docker Engine API runs
 * the shell with a real TTY and hands back the raw connection, so full-screen
 * programs (vi, top, prompts) work. Output is buffered so a reconnecting tab
 * sees the screen it left.
 */

const SOCKET =
  process.platform === "win32"
    ? "//./pipe/docker_engine"
    : "/var/run/docker.sock";
const BACKLOG_BYTES = 64 * 1024;
const IDLE_MS = 15 * 60 * 1000;

type Session = {
  id: string;
  projectId: string;
  userId: string;
  execId: string;
  socket: Duplex;
  backlog: Buffer[];
  backlogBytes: number;
  listeners: Set<(e: PtyEvent) => void>;
  exited: boolean;
  lastActive: number;
};
export type PtyEvent = { type: "data"; data: Buffer } | { type: "exit" };

const g = globalThis as unknown as {
  __forgePty?: Map<string, Session>;
  __forgePtyReaper?: ReturnType<typeof setInterval>;
};
const sessions = (g.__forgePty ??= new Map());

export class PtyError extends Error {}

function engine(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        socketPath: SOCKET,
        method,
        path,
        headers: { "content-type": "application/json" },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            json: d ? JSON.parse(d) : {},
          }),
        );
      },
    );
    r.on("error", reject);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function own(projectId: string, id: string, userId: string) {
  const s = sessions.get(id);
  if (!s || s.userId !== userId || s.projectId !== projectId)
    throw new PtyError("That terminal has closed.");
  s.lastActive = Date.now();
  return s;
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(Number(n) || lo)));

export async function openPty(
  projectId: string,
  userId: string,
  cols: number,
  rows: number,
): Promise<string> {
  const created = await engine(
    "POST",
    `/containers/${containerName(projectId)}/exec`,
    {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      // bash when the image has it, else the busybox shell.
      Cmd: [
        "sh",
        "-c",
        "command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l",
      ],
      Env: ["TERM=xterm-256color", "COLORTERM=truecolor"],
      WorkingDir: "/app",
    },
  ).catch(() => null);
  if (!created || created.status !== 201)
    throw new PtyError(
      "The project's container isn't running. Start the preview first.",
    );
  const execId = String(created.json.Id);

  const socket = await new Promise<Duplex>((resolve, reject) => {
    const r = http.request({
      socketPath: SOCKET,
      method: "POST",
      path: `/exec/${execId}/start`,
      headers: {
        "content-type": "application/json",
        Connection: "Upgrade",
        Upgrade: "tcp",
      },
    });
    r.on("upgrade", (_res, sock, head) => {
      if (head.length) sock.unshift(head);
      resolve(sock);
    });
    r.on("response", (res) =>
      reject(new PtyError(`Couldn't attach to the shell (${res.statusCode}).`)),
    );
    r.on("error", reject);
    r.end(JSON.stringify({ Detach: false, Tty: true }));
  });

  const s: Session = {
    id: randomUUID(),
    projectId,
    userId,
    execId,
    socket,
    backlog: [],
    backlogBytes: 0,
    listeners: new Set(),
    exited: false,
    lastActive: Date.now(),
  };
  socket.on("data", (data: Buffer) => {
    s.backlog.push(data);
    s.backlogBytes += data.length;
    while (s.backlogBytes > BACKLOG_BYTES && s.backlog.length > 1)
      s.backlogBytes -= s.backlog.shift()!.length;
    for (const l of s.listeners) l({ type: "data", data });
  });
  const end = () => {
    if (s.exited) return;
    s.exited = true;
    for (const l of s.listeners) l({ type: "exit" });
  };
  socket.on("end", end);
  socket.on("close", end);
  socket.on("error", end);
  sessions.set(s.id, s);
  await resizePty(projectId, s.id, userId, cols, rows).catch(() => undefined);
  startReaper();
  return s.id;
}

export function writePty(
  projectId: string,
  id: string,
  userId: string,
  data: string,
) {
  const s = own(projectId, id, userId);
  if (s.exited) throw new PtyError("The shell has exited.");
  // Typing in the terminal keeps the container from being paused.
  touchSandbox(projectId);
  s.socket.write(data.slice(0, 64 * 1024));
}

export async function resizePty(
  projectId: string,
  id: string,
  userId: string,
  cols: number,
  rows: number,
) {
  const s = own(projectId, id, userId);
  await engine(
    "POST",
    `/exec/${s.execId}/resize?h=${clamp(rows, 2, 300)}&w=${clamp(cols, 10, 500)}`,
  );
}

/** Listen to a terminal: the buffered screen first, then live output. */
export function subscribePty(
  projectId: string,
  id: string,
  userId: string,
  fn: (e: PtyEvent) => void,
) {
  const s = own(projectId, id, userId);
  if (s.backlog.length) fn({ type: "data", data: Buffer.concat(s.backlog) });
  if (s.exited) fn({ type: "exit" });
  s.listeners.add(fn);
  return () => {
    s.listeners.delete(fn);
    s.lastActive = Date.now();
  };
}

export function closePty(projectId: string, id: string, userId: string) {
  const s = sessions.get(id);
  if (!s || s.userId !== userId || s.projectId !== projectId) return;
  s.socket.destroy();
  sessions.delete(id);
}

/** Close terminals nobody has looked at for a while, and ones whose shell exited. */
function startReaper() {
  if (g.__forgePtyReaper) return;
  g.__forgePtyReaper = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if ((s.exited || !s.listeners.size) && now - s.lastActive > IDLE_MS) {
        s.socket.destroy();
        sessions.delete(s.id);
      }
    }
  }, 60_000);
  g.__forgePtyReaper.unref?.();
}
