"use client";
import { useState } from "react";
import { Video } from "lucide-react";

/**
 * Team Chat "Start a call": an instant IOTx Meet meeting for this channel or
 * DM, announced in the chat with a join link, then opened in a new tab.
 */
export default function StartCallButton({ channelId }: { channelId: string }) {
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    // Open the tab first (inside the click) so pop-up blockers allow it.
    const tab = window.open("about:blank", "_blank");
    try {
      const r = await fetch("/workspace/api/meet/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channelId }) });
      const d = (await r.json().catch(() => ({}))) as { meeting?: { code: string }; error?: string };
      if (!r.ok || !d.meeting) throw new Error(d.error ?? "Couldn't start a call.");
      const url = `/workspace/meet/${d.meeting.code}`;
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch (e) {
      tab?.close();
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="ws-btn" onClick={start} disabled={busy} title="Start a video call here">
      <Video size={14} /> <span className="ws-hide-mobile">{busy ? "Starting…" : "Start a call"}</span>
    </button>
  );
}
