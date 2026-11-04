"use client";

import { useEffect, useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import Link from "next/link";

type Settings = {
  config: {
    enabled: boolean;
    protocol?: "oidc" | "saml";
    saml?: { entityId: string; ssoUrl: string; cert: string; emailAttr: string; nameAttr: string; metadataUrl?: string } | null;
    domain: string;
    issuer: string;
    clientId: string;
    clientSecret: string | null;
    scopes: string;
    groupsClaim: string;
    allowedGroups: string[];
    groupRoles: Record<string, string>;
    check: { at: string; ok: boolean; error: string | null } | null;
    lastLoginAt: string | null;
  } | null;
  verifiedDomains: string[];
  callbackUrl: string;
  saml: { entityId: string; acsUrl: string; metadataUrl: string };
};

/** Single sign-on (OIDC or SAML) setup for the workspace. */
export default function SsoPanel() {
  const [s, setS] = useState<Settings | null>(null);
  const brand = useBrand();
  const [f, setF] = useState({
    protocol: "oidc" as "oidc" | "saml",
    domain: "",
    issuer: "",
    clientId: "",
    clientSecret: "",
    scopes: "openid email profile",
    metadataUrl: "",
    entityId: "",
    ssoUrl: "",
    cert: "",
    emailAttr: "",
    nameAttr: "",
    groupsClaim: "groups",
    allowedGroups: "",
    groupRoles: "",
  });
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const muted = { color: "var(--muted)" };
  const input = "w-full rounded-lg border bg-transparent px-3 py-2 text-sm";

  const load = () =>
    fetch("/api/workspace/sso")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "Only workspace owners and admins can set up SSO.");
        setS(d);
        const c = d.config as Settings["config"];
        setF((x) => ({
          ...x,
          protocol: c?.protocol ?? x.protocol,
          domain: c?.domain ?? d.verifiedDomains[0] ?? "",
          issuer: c?.protocol === "saml" ? "" : (c?.issuer ?? ""),
          clientId: c?.clientId ?? "",
          scopes: c?.scopes || x.scopes,
          metadataUrl: c?.saml?.metadataUrl ?? "",
          entityId: c?.saml?.entityId ?? "",
          ssoUrl: c?.saml?.ssoUrl ?? "",
          emailAttr: c?.saml?.emailAttr ?? "",
          nameAttr: c?.saml?.nameAttr ?? "",
          groupsClaim: c?.groupsClaim ?? "groups",
          allowedGroups: (c?.allowedGroups ?? []).join(", "),
          groupRoles: Object.entries(c?.groupRoles ?? {}).map(([g, r]) => `${g} = ${String(r).toLowerCase()}`).join("\n"),
        }));
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  async function post(body: Record<string, unknown>) {
    setError("");
    setNote("");
    const r = await fetch("/api/workspace/sso", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setError(d.error ?? "That didn't work");
    if (d.check) setNote(d.check.ok ? "Connected: the identity provider checks out." : `Saved, but the check failed: ${d.check.error}`);
    else setNote("Saved.");
    void load();
  }

  if (error && !s)
    return (
      <p className="text-sm text-red-500" role="alert">
        {error}
      </p>
    );
  if (!s) return null;
  const c = s.config;
  const saml = f.protocol === "saml";
  const copyRow = (label: string, value: string) => (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-32 shrink-0" style={muted}>
        {label}
      </span>
      <code className="min-w-0 flex-1 truncate">{value}</code>
      <button type="button" onClick={() => void navigator.clipboard?.writeText(value)} className="rounded border px-2 py-0.5">
        Copy
      </button>
    </div>
  );
  return (
    <div className="space-y-5 text-sm">
      <div>
        <h2 className="text-base font-semibold">Single sign-on</h2>
        <p className="mt-1" style={muted}>
          People with your company email sign in through your identity provider (Okta, Microsoft Entra ID, Google Workspace, OneLogin…) and join this workspace
          automatically. Use OpenID Connect or SAML 2.0, whichever your IT team prefers.
        </p>
      </div>
      {(note || error) && (
        <p className={error ? "text-red-500" : note.includes("failed") ? "text-amber-600" : "text-emerald-600"} role={error ? "alert" : "status"}>
          {error || note}
        </p>
      )}
      {c && (
        <p className="text-xs" style={muted}>
          {c.protocol === "saml" ? "SAML" : "OIDC"} · {c.enabled ? "On" : "Off"} · {c.check ? `${c.check.ok ? "healthy" : `failing: ${c.check.error}`} (checked ${new Date(c.check.at).toLocaleString()})` : "not checked"}
          {c.lastLoginAt ? ` · last sign-in ${new Date(c.lastLoginAt).toLocaleString()}` : ""}
        </p>
      )}
      {s.verifiedDomains.length === 0 ? (
        <p className="rounded-xl border p-4" style={muted}>
          SSO needs a verified email domain first.{" "}
          <Link href="/settings/security" className="underline">
            Verify a domain
          </Link>
        </p>
      ) : (
        <form
          className="space-y-2 rounded-xl border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            const groupRoles = Object.fromEntries(
              f.groupRoles
                .split("\n")
                .map((l) => l.split("="))
                .filter((p) => p.length === 2 && p[0].trim())
                .map(([g, r]) => [g.trim(), r.trim().toUpperCase()]),
            );
            const allowedGroups = f.allowedGroups.split(",").map((g) => g.trim()).filter(Boolean);
            const shared = { protocol: f.protocol, domain: f.domain, groupsClaim: f.groupsClaim, allowedGroups, groupRoles };
            void post(
              saml
                ? { ...shared, metadataUrl: f.metadataUrl, entityId: f.entityId, ssoUrl: f.ssoUrl, cert: f.cert || undefined, emailAttr: f.emailAttr, nameAttr: f.nameAttr }
                : { ...shared, issuer: f.issuer, clientId: f.clientId, clientSecret: f.clientSecret || undefined, scopes: f.scopes },
            );
          }}
        >
          <div role="radiogroup" aria-label="Protocol" className="flex gap-1 rounded-lg border p-1 text-xs">
            {(["oidc", "saml"] as const).map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={f.protocol === p}
                onClick={() => setF({ ...f, protocol: p })}
                className="flex-1 rounded-md px-3 py-1.5"
                style={f.protocol === p ? { background: "var(--accent)", color: "white" } : undefined}
              >
                {p === "oidc" ? "OpenID Connect" : "SAML 2.0"}
              </button>
            ))}
          </div>
          <div className="space-y-1 rounded-lg border p-3">
            <p className="text-xs font-medium">Give your identity provider these values for {brand.name}:</p>
            {saml ? (
              <>
                {copyRow("ACS (reply) URL", s.saml.acsUrl)}
                {copyRow("Entity ID (audience)", s.saml.entityId)}
                {copyRow("Metadata URL", s.saml.metadataUrl)}
                <p className="text-xs" style={muted}>
                  Name ID format: email address. Sign the assertion.
                </p>
              </>
            ) : (
              copyRow("Redirect URL", s.callbackUrl)
            )}
          </div>
          <label className="block text-xs">
            Email domain
            <select value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} className={`${input} mt-1`}>
              {s.verifiedDomains.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </label>
          {saml ? (
            <>
              <input value={f.metadataUrl} onChange={(e) => setF({ ...f, metadataUrl: e.target.value })} placeholder="IdP metadata URL (recommended: fills the rest and follows certificate changes)" aria-label="Identity provider metadata URL" className={input} />
              {f.metadataUrl.trim() ? (
                <p className="text-xs" style={muted}>
                  The entity ID, sign-in URL and certificate come from the metadata{c?.saml?.entityId ? `: ${c.saml.entityId}` : ""}.
                </p>
              ) : (
                <>
              <input value={f.entityId} onChange={(e) => setF({ ...f, entityId: e.target.value })} placeholder="Identity provider entity ID (issuer)" aria-label="Identity provider entity ID" className={input} />
              <input value={f.ssoUrl} onChange={(e) => setF({ ...f, ssoUrl: e.target.value })} placeholder="Sign-in URL (SSO URL), https://…" aria-label="Sign-in URL" className={input} />
              <textarea
                value={f.cert}
                onChange={(e) => setF({ ...f, cert: e.target.value })}
                rows={4}
                placeholder={c?.saml?.cert ? "Signing certificate (saved; paste a new one to replace it)" : "Signing certificate (X.509, PEM or base64)"}
                aria-label="Signing certificate"
                className={`${input} font-mono text-xs`}
              />
                </>
              )}
              <div className="grid gap-2 sm:grid-cols-2">
                <input value={f.emailAttr} onChange={(e) => setF({ ...f, emailAttr: e.target.value })} placeholder="Email attribute (optional; default Name ID)" aria-label="Email attribute" className={input} />
                <input value={f.nameAttr} onChange={(e) => setF({ ...f, nameAttr: e.target.value })} placeholder="Name attribute (optional)" aria-label="Name attribute" className={input} />
              </div>
            </>
          ) : (
            <>
              <input value={f.issuer} onChange={(e) => setF({ ...f, issuer: e.target.value })} placeholder="Issuer URL, e.g. https://acme.okta.com" aria-label="Issuer URL" className={input} />
              <input value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} placeholder="Client ID" aria-label="Client ID" className={input} />
              <input type="password" value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} placeholder={c?.clientSecret ? "Client secret (saved; leave empty to keep)" : "Client secret"} aria-label="Client secret" autoComplete="off" className={input} />
              <input value={f.scopes} onChange={(e) => setF({ ...f, scopes: e.target.value })} aria-label="Scopes" className={input} />
            </>
          )}
          <input value={f.groupsClaim} onChange={(e) => setF({ ...f, groupsClaim: e.target.value })} placeholder={saml ? "Groups attribute" : "Groups claim"} aria-label={saml ? "Groups attribute" : "Groups claim"} className={input} />
          <input value={f.allowedGroups} onChange={(e) => setF({ ...f, allowedGroups: e.target.value })} placeholder="Only these groups can sign in (optional, comma-separated)" aria-label="Allowed groups" className={input} />
          <textarea value={f.groupRoles} onChange={(e) => setF({ ...f, groupRoles: e.target.value })} rows={3} placeholder={"Group → role, one per line, e.g.\nIT Admins = admin"} aria-label="Group to role mapping" className={`${input} font-mono text-xs`} />
          <div className="flex flex-wrap justify-end gap-2">
            {c && (
              <>
                <button type="button" onClick={() => void post({ action: "check" })} className="rounded-lg border px-3 py-1.5 text-xs">
                  Check connection
                </button>
                {c.enabled && (
                  <button type="button" onClick={() => void post({ action: "disable" })} className="rounded-lg border px-3 py-1.5 text-xs">
                    Turn off
                  </button>
                )}
              </>
            )}
            <button className="rounded-lg px-3 py-1.5 text-xs font-medium text-white" style={{ background: "var(--accent)" }}>
              Save and check
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
