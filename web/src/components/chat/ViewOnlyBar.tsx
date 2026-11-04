"use client";

import { useState } from "react";
import { Eye } from "lucide-react";

/** Takes the composer's place for someone with view access: "Request to edit". */
export default function ViewOnlyBar({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function send() {
    setState("sending");
    const res = await fetch(`/api/projects/${projectId}/access-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "edit", message }),
    });
    setState(res.ok ? "sent" : "error");
  }

  return (
    <div className="border-t p-3">
      <div className="rounded-xl border p-3 text-sm" style={{ background: "var(--panel)" }}>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5">
            <Eye className="h-4 w-4" style={{ color: "var(--muted)" }} /> You can view this project
          </span>
          {state === "sent" ? (
            <span className="text-xs" style={{ color: "var(--muted)" }}>
              Request sent
            </span>
          ) : (
            !open && (
              <button
                onClick={() => setOpen(true)}
                className="rounded-lg px-2.5 py-1 text-xs font-medium text-white"
                style={{ background: "var(--accent)" }}
              >
                Request to edit
              </button>
            )
          )}
        </div>
        {open && state !== "sent" && (
          <div className="mt-2">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              maxLength={500}
              aria-label="Message (optional)"
              placeholder="Add a message (optional)"
              className="w-full resize-none rounded-lg border bg-transparent px-2 py-1.5 text-xs outline-none"
            />
            <div className="mt-1.5 flex justify-end gap-1.5">
              <button onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-xs" style={{ color: "var(--muted)" }}>
                Cancel
              </button>
              <button
                onClick={send}
                disabled={state === "sending"}
                className="rounded-md px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                style={{ background: "var(--accent)" }}
              >
                Send request
              </button>
            </div>
            {state === "error" && (
              <p className="mt-1 text-xs text-red-500" role="alert">
                Couldn&apos;t send the request.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
