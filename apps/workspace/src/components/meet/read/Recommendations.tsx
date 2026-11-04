"use client";
import { useState } from "react";
import { Check, Lightbulb, X } from "lucide-react";
import { meetApi } from "../api";
import { dayTime, Seg, useRead } from "./common";

type Item = {
  id: string; kind: string; title: string; reason: string; status: string; result: string; createdAt: string; reviewedAt: string | null;
  details: { from?: { start: string }; to?: { start: string; end: string }; auto?: boolean };
  event: { id: string; title: string; start: string; rrule: string | null } | null;
};
const WHAT: Record<string, string> = {
  decline: "Accept declines the whole series in your calendar.",
  suggest: "Accept sends the organiser a note with your reply.",
  shorter: "Accept shortens every meeting in the series; guests get the usual update.",
  less_often: "Accept changes how often it repeats; guests get the usual update.",
  move: "Accept moves the meeting; guests get the usual update.",
};

/** Recommendations: suggestions to decline, shorten or thin out meetings, and Flexible-meeting moves. Nothing changes until Accept. */
export default function Recommendations() {
  const [tab, setTab] = useState<"new" | "reviewed">("new");
  const { data, err, reload } = useRead<{ items: Item[] }>(`/read/recommendations?tab=${tab}`);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const act = async (it: Item, action: "accept" | "ignore") => {
    setBusy(it.id);
    setMsg("");
    try {
      const r = await meetApi<{ result?: string }>(`/read/recommendations/${it.id}`, { body: { action } });
      setMsg(action === "accept" ? r.result || "Done." : "Hidden. It's under Reviewed.");
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="rd-page">
      <div className="rd-head">
        <h2>Recommendations</h2>
        <Seg label="Tab" value={tab} onChange={setTab} options={[{ v: "new", label: "New" }, { v: "reviewed", label: "Reviewed" }]} />
      </div>
      <p className="rd-sub">From recurring meetings you often skip or that score low, and from your flexible meetings. Nothing changes in your calendar until you press Accept.</p>
      {err && <p className="mt-error">{err}</p>}
      {msg && <p className="mt-note" role="status">{msg}</p>}
      <section className="mt-card">
        {data && !data.items.length && <p className="rd-empty">{tab === "new" ? "No new recommendations." : "Nothing reviewed yet."}</p>}
        {data?.items.map((it) => (
          <div key={it.id} className="rd-item">
            <Lightbulb size={17} style={{ marginTop: 2, color: "var(--accent)" }} />
            <div className="body">
              <div className="t">{it.title}</div>
              <div style={{ fontSize: 13, marginTop: 3 }}>{it.reason}</div>
              <div className="m">
                {it.event ? <a href={`/workspace/calendar?event=${it.event.id}`}>{it.event.title}{it.event.rrule ? " (repeats)" : ""}</a> : "The event is gone"}
                {it.kind === "move" && it.details.to ? ` · ${it.details.from ? `${dayTime(it.details.from.start)} → ` : ""}${dayTime(it.details.to.start)}` : ""}
                {tab === "new" && WHAT[it.kind] ? ` · ${WHAT[it.kind]}` : ""}
              </div>
              {tab === "reviewed" && (
                <div className="m">{it.status === "accepted" ? <span className="rd-ok">Accepted</span> : it.status === "failed" ? <span className="rd-bad">Couldn't apply</span> : "Ignored"}{it.result ? ` · ${it.result}` : ""}{it.reviewedAt ? ` · ${dayTime(it.reviewedAt)}` : ""}</div>
              )}
            </div>
            {tab === "new" && (
              <div style={{ display: "flex", gap: 6 }}>
                <button className="mt-btn sm primary" disabled={!!busy || !it.event} onClick={() => act(it, "accept")}><Check size={13} /> Accept</button>
                <button className="mt-btn sm" disabled={!!busy} onClick={() => act(it, "ignore")}><X size={13} /> Ignore</button>
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
