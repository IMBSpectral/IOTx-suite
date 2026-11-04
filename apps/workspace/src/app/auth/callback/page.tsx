"use client";
import { useEffect, useState } from "react";

/** Reads #iotx_pass=… from the fragment, trades it for a Workspace session, then goes on. */
export default function Callback() {
  const [error, setError] = useState("");
  useEffect(() => {
    const m = /iotx_pass=([^&]+)/.exec(window.location.hash);
    const nextRaw = new URLSearchParams(window.location.search).get("next") ?? "/calendar";
    const next = nextRaw.startsWith("/") && !nextRaw.startsWith("//") ? nextRaw : "/calendar";
    history.replaceState(null, "", window.location.pathname + window.location.search);
    if (!m) {
      setError("The sign-in pass is missing.");
      return;
    }
    fetch("/workspace/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pass: decodeURIComponent(m[1]), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Sign-in failed.");
        window.location.replace(`/workspace${next}`);
      })
      .catch((e) => setError((e as Error).message));
  }, []);
  return (
    <div className="ws-center">
      {error ? (
        <>
          <p className="ws-error">{error}</p>
          <a href="/workspace/calendar">Try again</a>
        </>
      ) : (
        <>
          <div className="ws-spinner" aria-hidden />
          <p>Signing you in…</p>
        </>
      )}
    </div>
  );
}
