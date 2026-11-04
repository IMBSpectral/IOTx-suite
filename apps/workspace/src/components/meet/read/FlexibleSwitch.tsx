"use client";
import { useEffect, useState } from "react";
import { Shuffle } from "lucide-react";

/**
 * Calendar event detail: "Flexible" for meetings the person organises. The
 * platform may then move it to a better time the same day (see Meet →
 * Recommendations).
 */
export default function FlexibleSwitch({ eventId }: { eventId: string }) {
  const [st, setSt] = useState<{ on: boolean; canSet: boolean; repeats: boolean } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    fetch(`/workspace/api/meet/read/flexible?eventId=${encodeURIComponent(eventId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setSt(d))
      .catch(() => {});
  }, [eventId]);
  if (!st || (!st.canSet && !st.on)) return null;
  const toggle = async (on: boolean) => {
    setErr("");
    const r = await fetch("/workspace/api/meet/read/flexible", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId, on }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setErr(d.error ?? "Couldn't change it.");
    setSt({ ...st, on });
  };
  return (
    <div>
      <Shuffle size={16} />
      <div style={{ flex: 1 }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={st.on} onChange={(e) => toggle(e.target.checked)} /> Flexible
        </label>
        <small className="ws-muted" style={{ display: "block", fontSize: 12 }}>
          {st.on
            ? "If it clashes with something, or with someone's focus time or working hours, it can move to a better time the same day. It moves by itself only when every guest is in your workspace (they're told); otherwise you're asked in Meet → Recommendations."
            : "Let the platform move this to a better time the same day when there's a clash."}
        </small>
        {err && <small style={{ color: "var(--ws-danger)" }}>{err}</small>}
      </div>
    </div>
  );
}
