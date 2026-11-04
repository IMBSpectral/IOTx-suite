"use client";

import { useEffect, useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import { ShieldCheck } from "lucide-react";

type Data = {
  digest: {
    on: boolean;
    lastSentAt: string | null;
    summary: string;
    preview: {
      findings: {
        projects: { id: string; name: string; open: number }[];
        total: number;
      };
      neverScanned: string[];
      exposure: {
        connectors: string[];
        openPreviewLinks: number;
        webhooks: number;
        inviteLinks: string[];
        published: number;
        mcp: { connected: number; appServers: string[] };
      };
      changes: { kind: string; detail: string; at: string }[];
    };
  };
  rules: {
    disabledChecks: string[];
    blockPublishOn: "critical" | "high" | "medium";
  };
  checks: { id: string; title: string; severity: string; category: string }[];
  domains: { domain: string; verified: boolean; record: string }[];
  inviteVerifiedOnly: boolean;
  domainJoin: "off" | "request" | "auto";
  previewSharing: "anyone" | "password" | "signin" | "off";
  cloudAutoApprove: boolean;
  enforcedByOrg?: string[];
  log: {
    id: string;
    kind: string;
    detail: string;
    actor: string;
    at: string;
  }[];
};

const card = "rounded-xl border p-4";
const muted = { color: "var(--muted)" };

/** Settings → Security: digest, publishing rules, verified domains, preview-link policy, activity. */
export default function WorkspaceSecurityPanel() {
  const [data, setData] = useState<Data | null>(null);
  const brand = useBrand();
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [domain, setDomain] = useState("");

  useEffect(() => {
    let live = true;
    fetch("/api/workspace/security")
      .then(async (r) => {
        const d = await r.json();
        if (!live) return;
        if (r.ok) setData(d);
        else
          setError(
            d.error ??
              "Only workspace owners and admins can see security settings.",
          );
      })
      .catch(() => live && setError("Couldn't load security settings."));
    return () => {
      live = false;
    };
  }, [version]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await fetch("/api/workspace/security", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || d.error) setError(d.error ?? "Something went wrong");
    if (d.summary) setNote(`Digest sent: ${d.summary}`);
    if (d.verified) setNote("Domain verified.");
    setVersion((v) => v + 1);
    return res.ok;
  }

  if (error && !data)
    return (
      <p className="text-sm" style={muted}>
        {error}
      </p>
    );
  if (!data)
    return (
      <p className="text-sm" style={muted}>
        Loading security…
      </p>
    );
  const verified = data.domains.some((d) => d.verified);

  return (
    <div className="space-y-8">
      {(error || note) && (
        <p
          role={error ? "alert" : "status"}
          className={`rounded-lg border px-3 py-2 text-xs ${error ? "border-red-500/40 text-red-600 dark:text-red-400" : ""}`}
        >
          {error ?? note}
        </p>
      )}

      <section>
        <h2 className="mb-3 text-sm font-medium">Security digest</h2>
        <div className={card} style={{ background: "var(--panel)" }}>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              Weekly digest to owners and admins
              <span className="block text-xs" style={muted}>
                Open findings, what&apos;s exposed (connectors, preview links,
                webhooks, invite links) and this week&apos;s security changes.
              </span>
            </span>
            <input
              type="checkbox"
              checked={data.digest.on}
              disabled={busy}
              onChange={(e) => act({ action: "digest", on: e.target.checked })}
            />
          </label>
          <div
            className="mt-3 rounded-lg border px-3 py-2 text-xs"
            aria-label="This week's digest"
          >
            <p className="flex items-center gap-1.5 font-medium">
              <ShieldCheck className="h-3.5 w-3.5" /> This week
            </p>
            <p className="mt-1" style={muted}>
              {data.digest.summary}
            </p>
            {data.digest.preview.findings.projects.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {data.digest.preview.findings.projects.map((p) => (
                  <li key={p.id}>
                    <a href={`/projects/${p.id}`} className="hover:underline">
                      {p.name}
                    </a>
                    <span style={muted}> · {p.open} open</span>
                  </li>
                ))}
              </ul>
            )}
            {data.digest.preview.exposure.connectors.length > 0 && (
              <p className="mt-1" style={muted}>
                Connectors: {data.digest.preview.exposure.connectors.join(", ")}
              </p>
            )}
            {(data.digest.preview.exposure.mcp.connected > 0 ||
              data.digest.preview.exposure.mcp.appServers.length > 0) && (
              <p className="mt-1" style={muted}>
                MCP exposure: {data.digest.preview.exposure.mcp.connected}{" "}
                server(s) connected
                {data.digest.preview.exposure.mcp.appServers.length > 0 &&
                  `; serving data: ${data.digest.preview.exposure.mcp.appServers.join(", ")}`}
              </p>
            )}
            {data.digest.preview.exposure.inviteLinks.length > 0 && (
              <p className="mt-1" style={muted}>
                Invite links on:{" "}
                {data.digest.preview.exposure.inviteLinks.join(", ")}
              </p>
            )}
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs">
            <button
              disabled={busy}
              onClick={() => act({ action: "sendDigest" })}
              className="rounded-lg border px-2.5 py-1 disabled:opacity-50"
            >
              Send it now
            </button>
            {data.digest.lastSentAt && (
              <span style={muted}>
                Last sent {new Date(data.digest.lastSentAt).toLocaleString()}
              </span>
            )}
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium">Workspace rules</h2>
        <div className={card} style={{ background: "var(--panel)" }}>
          <label className="flex flex-wrap items-center gap-2 text-sm">
            Block publishing when a project has
            <select
              value={data.rules.blockPublishOn}
              disabled={busy}
              onChange={(e) =>
                act({
                  action: "rules",
                  blockPublishOn: e.target.value,
                  disabledChecks: data.rules.disabledChecks,
                })
              }
              className="rounded-md border bg-transparent px-1.5 py-0.5 text-sm"
              aria-label="Block publishing on"
            >
              <option value="critical">critical findings</option>
              <option value="high">critical or high findings</option>
              <option value="medium">medium findings or worse</option>
            </select>
          </label>
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer">
              Checks for every project (
              {data.checks.length - data.rules.disabledChecks.length} of{" "}
              {data.checks.length} on)
            </summary>
            <ul className="mt-2 grid gap-1 sm:grid-cols-2">
              {data.checks.map((c) => {
                const on = !data.rules.disabledChecks.includes(c.id);
                return (
                  <li key={c.id}>
                    <label className="flex items-start gap-1.5">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={busy}
                        onChange={() =>
                          act({
                            action: "rules",
                            blockPublishOn: data.rules.blockPublishOn,
                            disabledChecks: on
                              ? [...data.rules.disabledChecks, c.id]
                              : data.rules.disabledChecks.filter(
                                  (x) => x !== c.id,
                                ),
                          })
                        }
                        className="mt-0.5"
                      />
                      <span>
                        {c.title} <span style={muted}>· {c.severity}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2" style={muted}>
              Turning a check off here turns it off in every project. Projects
              can turn off more on their own.
            </p>
          </details>
          <p className="mt-3 text-xs" style={muted}>
            Connected scanners (Aikido and others) need an account with that
            service; they aren&apos;t available in this build.
          </p>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium">Verified domains</h2>
        <div className={card} style={{ background: "var(--panel)" }}>
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act({ action: "addDomain", domain })) setDomain("");
            }}
          >
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="example.com"
              aria-label="Domain to verify"
              className="min-w-0 flex-1 rounded-lg border bg-transparent px-2 py-1.5 text-sm"
            />
            <button
              disabled={busy || !domain.trim()}
              className="btn-primary rounded-lg px-3 text-xs disabled:opacity-50"
            >
              Add domain
            </button>
          </form>
          {data.domains.length > 0 && (
            <ul className="mt-3 space-y-2 text-xs">
              {data.domains.map((d) => (
                <li key={d.domain} className="rounded-lg border px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{d.domain}</span>
                    <span className="flex items-center gap-1.5">
                      {d.verified ? (
                        <span className="rounded-full bg-emerald-500/15 px-1.5 py-px text-emerald-700 dark:text-emerald-300">
                          Verified
                        </span>
                      ) : (
                        <button
                          disabled={busy}
                          onClick={() =>
                            act({ action: "verifyDomain", domain: d.domain })
                          }
                          className="rounded-md border px-2 py-0.5"
                        >
                          Verify
                        </button>
                      )}
                      <button
                        disabled={busy}
                        onClick={() =>
                          act({ action: "removeDomain", domain: d.domain })
                        }
                        className="rounded-md px-1.5 py-0.5 text-red-500 hover:bg-red-500/[.08]"
                      >
                        Remove
                      </button>
                    </span>
                  </div>
                  {!d.verified && (
                    <p className="mt-1" style={muted}>
                      Add a TXT record to {d.domain}:{" "}
                      <code className="select-all rounded bg-black/[.05] px-1 dark:bg-white/[.08]">
                        {d.record}
                      </code>
                      , then Verify.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <label
            className={`mt-3 flex items-center justify-between gap-3 text-sm ${verified ? "" : "opacity-60"}`}
          >
            <span>
              Only invite people with a verified-domain email
              <span className="block text-xs" style={muted}>
                Applies to workspace members and project collaborators from
                outside the workspace.
              </span>
            </span>
            <input
              type="checkbox"
              checked={data.inviteVerifiedOnly}
              disabled={busy || !verified}
              onChange={(e) =>
                act({ action: "inviteVerifiedOnly", on: e.target.checked })
              }
            />
          </label>
          <label
            className={`mt-3 flex flex-wrap items-center justify-between gap-2 text-sm ${verified ? "" : "opacity-60"}`}
          >
            <span>
              People with a verified-domain email
              <span className="block text-xs" style={muted}>
                They see this workspace on their dashboard.
              </span>
            </span>
            <select
              value={data.domainJoin}
              disabled={busy || !verified}
              onChange={(e) =>
                act({ action: "domainJoin", domainJoin: e.target.value })
              }
              aria-label="Who can join with a verified-domain email"
              className="rounded-md border bg-transparent px-1.5 py-0.5 text-sm"
            >
              <option value="off">can&apos;t join on their own</option>
              <option value="request">can ask to join</option>
              <option value="auto">join automatically</option>
            </select>
          </label>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium">{brand.shortName} Cloud</h2>
        <label
          className={`${card} flex items-start gap-2 text-sm`}
          style={{ background: "var(--panel)" }}
        >
          <input
            type="checkbox"
            checked={data.cloudAutoApprove}
            disabled={busy || !!data.enforcedByOrg?.includes("cloudAutoApprove")}
            title={data.enforcedByOrg?.includes("cloudAutoApprove") ? "Set by your organization" : undefined}
            onChange={(e) =>
              act({
                action: "cloudAutoApprove",
                cloudAutoApprove: e.target.checked,
              })
            }
            className="mt-1"
          />
          <span>
            Let the agent set up {brand.shortName} Cloud
            <span className="block text-xs" style={muted}>
              The agent turns on a database and sign-in when an app needs them,
              and applies database changes as it builds. Turn this off to
              approve each step yourself.
            </span>
          </span>
        </label>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium">Preview links</h2>
        <div
          className={`${card} space-y-1.5 text-sm`}
          style={{ background: "var(--panel)" }}
        >
          {(
            [
              [
                "anyone",
                "Anyone with the link",
                "Members can share preview links freely.",
              ],
              [
                "password",
                "Password required",
                "Every new preview link must have a password.",
              ],
              [
                "signin",
                "Sign-in only",
                "Links open only for workspace members and signed-in people from your verified domains.",
              ],
              [
                "off",
                "Off",
                "Nobody in this workspace can create preview links.",
              ],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="flex items-start gap-2">
              <input
                type="radio"
                name="previewSharing"
                checked={data.previewSharing === value}
                disabled={busy || !!data.enforcedByOrg?.includes("previewSharing")}
                title={data.enforcedByOrg?.includes("previewSharing") ? "Set by your organization" : undefined}
                onChange={() =>
                  act({ action: "previewSharing", previewSharing: value })
                }
                className="mt-1"
              />
              <span>
                {label}
                <span className="block text-xs" style={muted}>
                  {hint}
                </span>
              </span>
            </label>
          ))}
          <p className="pt-1 text-xs" style={muted}>
            Existing links keep working until they expire or are revoked;
            Sign-in only applies to them straight away.
          </p>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium">Security activity</h2>
        {data.log.length === 0 ? (
          <p className="text-xs" style={muted}>
            No security changes recorded yet.
          </p>
        ) : (
          <ul
            className="divide-y rounded-xl border text-xs"
            style={{ background: "var(--panel)" }}
          >
            {data.log.map((e) => (
              <li
                key={e.id}
                className="flex items-baseline justify-between gap-3 px-3 py-2"
              >
                <span className="min-w-0">
                  <span className="font-medium">{e.actor}</span>{" "}
                  <span>{e.detail}</span>
                </span>
                <span className="shrink-0" style={muted}>
                  {new Date(e.at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
