"use client";
import { useState } from "react";
import { meetApi } from "../api";
import { useRead } from "./common";

type S = { prefs: { dailyRead: boolean; dailyHour: number }; recap: { recapTo: "attendees" | "invitees" | "me" }; optedOut: boolean; admin: boolean; email: string };

/** Meet settings: the Daily Read, report sharing (who gets recaps, admins), and opting out of being summarised. */
export default function ReadSettings() {
  const { data, setData, err } = useRead<S>("/read/settings");
  const [msg, setMsg] = useState("");
  const save = async (b: Record<string, unknown>, next: Partial<S>) => {
    setMsg("");
    try {
      await meetApi("/read/settings", { body: b });
      setData((d) => d && { ...d, ...next, prefs: { ...d.prefs, ...(next.prefs ?? {}) } });
      setMsg("Saved.");
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div className="rd-page">
      <div className="rd-head"><h2>Meet settings</h2></div>
      {err && <p className="mt-error">{err}</p>}
      {msg && <p className="mt-note" role="status">{msg}</p>}
      {data && (
        <>
          <section className="mt-card" style={{ display: "grid", gap: 10 }}>
            <h2>Daily Read</h2>
            <label className="mt-check">
              <input type="checkbox" checked={data.prefs.dailyRead} onChange={(e) => save({ dailyRead: e.target.checked }, { prefs: { ...data.prefs, dailyRead: e.target.checked } })} />
              Email me a morning digest: yesterday&rsquo;s meetings, my open action items, and today&rsquo;s meetings with prep links
            </label>
            <label className="rd-rule"><span className="mt-note">Arrives around</span>
              <select className="mt-select" style={{ maxWidth: 140 }} value={data.prefs.dailyHour} disabled={!data.prefs.dailyRead} onChange={(e) => save({ dailyHour: Number(e.target.value) }, { prefs: { ...data.prefs, dailyHour: Number(e.target.value) } })}>
                {[5, 6, 7, 8, 9, 10].map((h) => <option key={h} value={h}>{h}:00</option>)}
              </select>
            </label>
            <p className="rd-help" style={{ margin: 0 }}>Sent to {data.email}, in your time zone. Also shown under <a href="/workspace/meet/daily">Daily Read</a>.</p>
          </section>
          <section className="mt-card" style={{ display: "grid", gap: 10 }}>
            <h2>Report sharing</h2>
            <p className="rd-help" style={{ margin: 0 }}>Who gets meeting recaps automatically, for the whole workspace.{data.admin ? "" : " Only admins can change this."}</p>
            {(["attendees", "invitees", "me"] as const).map((v) => (
              <label key={v} className="mt-check">
                <input type="radio" name="recap" disabled={!data.admin} checked={data.recap.recapTo === v} onChange={() => save({ recapTo: v }, { recap: { recapTo: v } })} />
                {v === "attendees" ? "Everyone who attended" : v === "invitees" ? "Everyone invited (Meet invitees and calendar guests), even if they didn't join" : "Only the host"}
              </label>
            ))}
            <p className="rd-help" style={{ margin: 0 }}>Anyone can still share a report with a colleague, or put it in a shared folder.</p>
          </section>
          <section className="mt-card" style={{ display: "grid", gap: 10 }}>
            <h2>Don&rsquo;t summarise me</h2>
            <label className="mt-check">
              <input type="checkbox" checked={data.optedOut} onChange={(e) => save({ optOut: e.target.checked }, { optedOut: e.target.checked })} />
              Leave what I say out of transcripts and reports in meetings I attend
            </label>
            <p className="rd-help" style={{ margin: 0 }}>Your lines are dropped before a report is written. People outside the workspace can ask for the same at <a href="/workspace/meet/opt-out">/workspace/meet/opt-out</a>.</p>
          </section>
        </>
      )}
    </div>
  );
}
