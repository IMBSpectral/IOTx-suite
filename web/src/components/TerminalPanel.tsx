"use client";

import { useEffect, useRef, useState } from "react";
import { RotateCcw, SquareTerminal } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

// The shell outlives tab switches: reopening the Terminal tab reattaches to it.
const openSessions = new Map<string, string>();

/**
 * A real terminal in the project's container (bash or sh with a TTY), so
 * full-screen programs like vi and top work. Output arrives as server-sent
 * events; keystrokes and size changes are posted back in order.
 */
export default function TerminalPanel({ projectId }: { projectId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<
    "connecting" | "ready" | "exited" | "error"
  >("connecting");
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    const base = `/api/projects/${projectId}/terminal`;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !hostRef.current) return;
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 13,
        theme: {
          background: "#0d0d10",
          foreground: "#e4e4e7",
          cursor: "#a78bfa",
          selectionBackground: "#6d4aff66",
        },
        scrollback: 5000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      fit.fit();

      // Posts go one after another so keystrokes never arrive out of order.
      let queue = Promise.resolve();
      let session = openSessions.get(projectId) ?? "";
      const post = (body: Record<string, unknown>) => {
        const p = queue.then(() =>
          fetch(base, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ session, ...body }),
          }).then((r) => r.json().then((d) => ({ ok: r.ok, d }))),
        );
        queue = p.then(
          () => undefined,
          () => undefined,
        );
        return p;
      };

      let events: EventSource | null = null;
      const attach = () =>
        new Promise<boolean>((resolve) => {
          let any = false;
          events = new EventSource(`${base}?session=${session}`);
          events.onmessage = (m) => {
            const ev = JSON.parse(m.data) as { type: string; b64?: string };
            if (ev.type === "data" && ev.b64) {
              any = true;
              term.write(Uint8Array.from(atob(ev.b64), (c) => c.charCodeAt(0)));
              resolve(true);
            } else if (ev.type === "exit") {
              events?.close();
              if (!any) return resolve(false);
              openSessions.delete(projectId);
              if (!disposed) setStatus("exited");
              term.write(
                "\r\n\x1b[90m[The shell exited. Restart to open a new one.]\x1b[0m\r\n",
              );
            }
          };
          // A live session with nothing new to show is still attached.
          setTimeout(() => resolve(true), 1500);
        });

      const start = async () => {
        if (session && (await attach())) return true;
        events?.close();
        const r = await post({
          action: "open",
          cols: term.cols,
          rows: term.rows,
        });
        if (!r.ok) {
          setError(r.d.error ?? "Couldn't open a terminal.");
          setStatus("error");
          return false;
        }
        session = r.d.session;
        openSessions.set(projectId, session);
        await attach();
        return true;
      };

      if (!(await start()) || disposed) return;
      setStatus("ready");
      void post({ action: "resize", cols: term.cols, rows: term.rows });
      term.focus();

      // Batch fast typing and pastes into one request.
      let pending = "";
      let timer: ReturnType<typeof setTimeout> | null = null;
      const input = term.onData((data) => {
        pending += data;
        timer ??= setTimeout(() => {
          const data = pending;
          pending = "";
          timer = null;
          void post({ action: "input", data });
        }, 8);
      });
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const observer = new ResizeObserver(() => {
        fit.fit();
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(
          () =>
            void post({ action: "resize", cols: term.cols, rows: term.rows }),
          150,
        );
      });
      observer.observe(hostRef.current!);

      cleanup = () => {
        observer.disconnect();
        input.dispose();
        events?.close();
        term.dispose();
      };
    })().catch(() => {
      if (!disposed) {
        setError("Couldn't start the terminal.");
        setStatus("error");
      }
    });

    return () => {
      disposed = true;
      cleanup();
    };
  }, [projectId, generation]);

  function restart() {
    const old = openSessions.get(projectId);
    if (old)
      void fetch(`/api/projects/${projectId}/terminal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "close", session: old }),
      });
    openSessions.delete(projectId);
    setError("");
    setStatus("connecting");
    setGeneration((g) => g + 1);
  }

  return (
    <div className="flex h-full flex-col bg-[#0d0d10] text-zinc-200">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-white/10 px-3 text-xs text-zinc-400">
        <span className="flex items-center gap-1.5">
          <SquareTerminal className="h-3.5 w-3.5" /> Terminal
          {status === "connecting" && (
            <span className="text-zinc-500">· connecting…</span>
          )}
          {status === "exited" && (
            <span className="text-zinc-500">· exited</span>
          )}
        </span>
        <button
          onClick={restart}
          aria-label="Restart terminal"
          title="Close this shell and open a new one"
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-white/10"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Restart
        </button>
      </div>
      {status === "error" && (
        <p role="alert" className="px-3 py-2 text-xs text-red-400">
          {error}
        </p>
      )}
      <div
        ref={hostRef}
        className="min-h-0 flex-1 px-2 py-1"
        aria-label="Terminal"
      />
    </div>
  );
}
