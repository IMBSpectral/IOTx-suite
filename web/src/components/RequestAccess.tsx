"use client";

import { useState } from "react";
import Link from "next/link";
import { Lock } from "lucide-react";

/** Shown instead of the editor to someone who can't open a project. */
export default function RequestAccess({ projectId }: { projectId: string }) {
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function send() {
    setState("sending");
    const res = await fetch(`/api/projects/${projectId}/access-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "view", message }),
    });
    setState(res.ok ? "sent" : "error");
  }

  return (
    <main className="grid flex-1 place-items-center p-6">
      <div className="w-full max-w-sm rounded-2xl border p-6 text-center" style={{ background: "var(--panel)" }}>
        <Lock className="mx-auto h-6 w-6" style={{ color: "var(--muted)" }} />
        <h1 className="mt-3 text-lg font-semibold">You need access</h1>
        {state === "sent" ? (
          <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
            Request sent. You&apos;ll get a notification when the owner responds.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
              This project is private. Ask its owner for access.
            </p>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              maxLength={500}
              aria-label="Message (optional)"
              placeholder="Add a message (optional)"
              className="mt-4 w-full resize-none rounded-lg border bg-transparent px-2.5 py-2 text-sm outline-none"
            />
            <button
              onClick={send}
              disabled={state === "sending"}
              className="mt-3 w-full rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              style={{ background: "var(--accent)" }}
            >
              {state === "sending" ? "Sending…" : "Request access"}
            </button>
            {state === "error" && (
              <p className="mt-2 text-xs text-red-500" role="alert">
                Couldn&apos;t send the request.
              </p>
            )}
          </>
        )}
        <Link href="/dashboard" className="mt-4 inline-block text-xs hover:underline" style={{ color: "var(--muted)" }}>
          Back to dashboard
        </Link>
      </div>
    </main>
  );
}
