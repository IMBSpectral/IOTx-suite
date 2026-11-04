"use client";

import { useEffect, useState } from "react";
import { useEscape } from "./useEscape";
import { useRouter } from "next/navigation";
import { Check, Copy, Link2, Lock, RotateCw, X } from "lucide-react";

type Collab = {
  id: string;
  userId: string;
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
  name: string | null;
  email: string;
  external: boolean;
  you: boolean;
};
type PreviewLink = {
  id: string;
  name: string;
  url: string;
  expiresAt: string | null;
  hasPassword: boolean;
  allowComments: boolean;
  views: number;
  status: "active" | "expired" | "revoked";
};
type Request = { id: string; kind: "view" | "edit"; message: string | null; name: string | null; email: string };
type Share = {
  access: "view" | "edit" | "admin";
  canManage: boolean;
  isCollaborator: boolean;
  restricted: boolean;
  allowGuestComments: boolean;
  allowExternal: boolean;
  inviteLink: { access: "view" | "edit"; url: string } | null;
  collaborators: Collab[];
  previewLinks: PreviewLink[];
  requests: Request[];
};

const ROLES = [
  { value: "VIEWER", label: "Can view" },
  { value: "MEMBER", label: "Can edit" },
  { value: "ADMIN", label: "Admin" },
] as const;

const EXPIRIES = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "never", label: "Never" },
] as const;

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => undefined);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      aria-label={`${label}: ${text}`}
      className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-black/[.04]"
    >
      {done ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {done ? "Copied" : label}
    </button>
  );
}

export default function ShareDialog({
  projectId,
  projectName,
  open,
  onClose,
  onPublish,
}: {
  projectId: string;
  projectName?: string;
  open: boolean;
  onClose: () => void;
  /** "Publish" or "Publish privately" from the share menu. */
  onPublish?: (audience: "public" | "private") => void;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"people" | "links">("people");
  useEscape(open ? onClose : null);
  const [data, setData] = useState<Share | null>(null);
  const [version, setVersion] = useState(0);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Collab["role"]>("MEMBER");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkForm, setLinkForm] = useState({ name: "", expires: "7d", password: "", allowComments: false });

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch(`/api/projects/${projectId}/share`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d) setData(d);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open, projectId, version]);

  if (!open) return null;
  const reload = () => setVersion((v) => v + 1);

  async function call(url: string, method: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Something went wrong");
      reload();
      return d;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      return null;
    } finally {
      setBusy(false);
    }
  }

  const base = `/api/projects/${projectId}`;
  const manage = data?.canManage ?? false;

  async function invite() {
    const address = email.trim();
    if (!address) return;
    if (await call(`${base}/collaborators`, "POST", { email: address, role })) setEmail("");
  }

  async function leave() {
    if (!confirm("Leave this project? You'll lose access unless someone invites you again.")) return;
    if (await call(`${base}/leave`, "POST")) router.push("/dashboard");
  }

  async function createLink() {
    const d = await call(`${base}/preview-links`, "POST", linkForm);
    if (d) {
      setLinkForm({ name: "", expires: "7d", password: "", allowComments: false });
      await navigator.clipboard.writeText(d.url).catch(() => undefined);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Share project"
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border p-5 shadow-2xl"
        style={{ background: "var(--panel)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="truncate text-sm font-semibold">Share {projectName ?? "project"}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 hover:bg-black/[.05]">
            <X className="h-4 w-4" />
          </button>
        </div>

        {manage && (
          <div className="mt-3 flex gap-0.5" role="tablist">
            {(
              [
                ["people", "People"],
                ["links", "Preview links"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`rounded-md px-2.5 py-1 text-xs ${tab === id ? "bg-black/[.06] font-medium dark:bg-white/[.08]" : ""}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {error && (
          <p className="mt-3 text-xs text-red-500" role="alert">
            {error}
          </p>
        )}

        {!data && <p className="mt-4 text-xs" style={{ color: "var(--muted)" }}>Loading…</p>}

        {data && tab === "people" && (
          <>
            {manage && (
              <div className="mt-4 flex gap-2">
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void invite()}
                  type="email"
                  placeholder="Add people by email"
                  aria-label="Email to invite"
                  className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
                />
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as Collab["role"])}
                  aria-label="Role for the invite"
                  className="rounded-lg border bg-transparent px-2 text-xs"
                >
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={invite}
                  disabled={busy || !email.trim()}
                  className="rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
                  style={{ background: "var(--accent)" }}
                >
                  Invite
                </button>
              </div>
            )}

            {manage && data.requests.length > 0 && (
              <section className="mt-4 rounded-lg border p-3" aria-label="Access requests">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-medium">Requests ({data.requests.length})</h3>
                  {data.requests.length > 1 && (
                    <button
                      onClick={() => call(`${base}/access-requests`, "PATCH", { declineAll: true })}
                      className="text-[11px] hover:underline"
                      style={{ color: "var(--muted)" }}
                    >
                      Decline all
                    </button>
                  )}
                </div>
                <ul className="mt-2 space-y-2">
                  {data.requests.map((r) => (
                    <li key={r.id} className="flex items-start justify-between gap-2 text-sm">
                      <span className="min-w-0">
                        <span className="block truncate">{r.name ?? r.email}</span>
                        <span className="block text-xs" style={{ color: "var(--muted)" }}>
                          Wants to {r.kind}
                          {r.message ? ` · “${r.message}”` : ""}
                        </span>
                      </span>
                      <span className="flex shrink-0 gap-1">
                        <button
                          onClick={() => call(`${base}/access-requests`, "PATCH", { requestId: r.id, decision: "decline" })}
                          className="rounded-md border px-2 py-1 text-xs"
                        >
                          Decline
                        </button>
                        <button
                          onClick={() => call(`${base}/access-requests`, "PATCH", { requestId: r.id, decision: "approve" })}
                          className="rounded-md px-2 py-1 text-xs font-medium text-white"
                          style={{ background: "var(--accent)" }}
                        >
                          Approve
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {data.collaborators.length > 0 && (
              <ul className="mt-4 divide-y rounded-lg border" aria-label="People with access">
                {data.collaborators.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="min-w-0">
                      <span className="block truncate text-sm">
                        {c.name ?? c.email}
                        {c.you && <span style={{ color: "var(--muted)" }}> (you)</span>}
                      </span>
                      {c.external && (
                        <span
                          className="text-[10px]"
                          style={{ color: "var(--muted)" }}
                          title="External collaborator (not a member of your workspace)"
                        >
                          External collaborator
                        </span>
                      )}
                    </span>
                    {manage ? (
                      <span className="flex shrink-0 items-center gap-1.5">
                        <select
                          value={c.role === "OWNER" ? "ADMIN" : c.role}
                          onChange={(e) =>
                            call(`${base}/collaborators`, "PATCH", { collaboratorId: c.id, role: e.target.value })
                          }
                          aria-label={`Role for ${c.email}`}
                          className="rounded-md border bg-transparent px-1.5 py-1 text-xs"
                        >
                          {ROLES.map((r) => (
                            <option key={r.value} value={r.value}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => call(`${base}/collaborators`, "DELETE", { collaboratorId: c.id })}
                          disabled={busy}
                          className="text-xs text-red-500 hover:underline disabled:opacity-50"
                        >
                          Remove
                        </button>
                      </span>
                    ) : (
                      <span className="text-xs" style={{ color: "var(--muted)" }}>
                        {ROLES.find((r) => r.value === c.role)?.label ?? "Admin"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <p className="mt-3 text-[11px]" style={{ color: "var(--muted)" }}>
              Sharing the project does not automatically share its connections: people outside the workspace can&apos;t
              use its connectors.
            </p>

            <fieldset className="mt-5" disabled={!manage}>
              <legend className="mb-2 text-xs font-medium">General access</legend>
              {(
                [
                  [false, "Workspace", "Everyone in the workspace can open it."],
                  [true, "Restricted", "Only people invited to the project."],
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  key={label}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-black/[.03]"
                >
                  <input
                    type="radio"
                    name="general-access"
                    checked={data.restricted === value}
                    onChange={() => call(`${base}/share`, "PATCH", { restricted: value })}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm">{label}</span>
                    <span className="block text-xs" style={{ color: "var(--muted)" }}>
                      {hint}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>

            {manage && (
              <section className="mt-4" aria-label="Invite link">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-medium">
                    <Link2 className="h-3.5 w-3.5" /> Invite link
                  </span>
                  <select
                    value={data.inviteLink?.access ?? "off"}
                    disabled={!data.allowExternal}
                    onChange={(e) => call(`${base}/share`, "PATCH", { inviteLink: e.target.value })}
                    aria-label="Invite link access"
                    className="rounded-md border bg-transparent px-1.5 py-1 text-xs disabled:opacity-50"
                  >
                    <option value="off">Off</option>
                    <option value="view">Anyone with the link can view</option>
                    <option value="edit">Anyone with the link can edit</option>
                  </select>
                </div>
                {!data.allowExternal && (
                  <p className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}>
                    Off because this workspace doesn&apos;t allow external collaborators.
                  </p>
                )}
                {data.inviteLink && (
                  <div className="mt-2 flex items-center gap-1.5">
                    <input
                      readOnly
                      value={data.inviteLink.url}
                      aria-label="Invite link URL"
                      className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-xs"
                    />
                    <CopyButton text={data.inviteLink.url} />
                    <button
                      onClick={() => call(`${base}/share`, "PATCH", { resetInviteLink: true })}
                      aria-label="Reset invite link"
                      title="Reset link (the old one stops working)"
                      className="rounded-md border p-1.5 hover:bg-black/[.04]"
                    >
                      <RotateCw className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </section>
            )}

            <div className="mt-5 flex items-center justify-between">
              {data.isCollaborator ? (
                <button onClick={leave} className="text-xs text-red-500 hover:underline">
                  Leave project
                </button>
              ) : (
                <span />
              )}
              <button onClick={onClose} className="rounded-lg border px-3 py-1.5 text-sm">
                Done
              </button>
            </div>
          </>
        )}

        {data && tab === "links" && manage && (
          <>
            <p className="mt-4 text-xs" style={{ color: "var(--muted)" }}>
              Share a preview of the current version with people who don&apos;t have an account. Links never give
              access to the editor.
            </p>
            <div className="mt-3 space-y-2 rounded-lg border p-3">
              <input
                value={linkForm.name}
                onChange={(e) => setLinkForm({ ...linkForm, name: e.target.value })}
                placeholder="Link name, e.g. Client review"
                aria-label="Link name"
                className="w-full rounded-md border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              />
              <div className="flex gap-2">
                <select
                  value={linkForm.expires}
                  onChange={(e) => setLinkForm({ ...linkForm, expires: e.target.value })}
                  aria-label="Expires after"
                  className="rounded-md border bg-transparent px-2 text-xs"
                >
                  {EXPIRIES.map((x) => (
                    <option key={x.value} value={x.value}>
                      Expires: {x.label}
                    </option>
                  ))}
                </select>
                <input
                  type="password"
                  value={linkForm.password}
                  onChange={(e) => setLinkForm({ ...linkForm, password: e.target.value })}
                  placeholder="Password (optional)"
                  aria-label="Password (optional)"
                  autoComplete="new-password"
                  className="min-w-0 flex-1 rounded-md border bg-transparent px-2.5 py-1.5 text-xs outline-none"
                />
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={linkForm.allowComments}
                  onChange={(e) => setLinkForm({ ...linkForm, allowComments: e.target.checked })}
                />
                Allow comments from guests
              </label>
              <div className="flex justify-end">
                <button
                  onClick={createLink}
                  disabled={busy || !linkForm.name.trim()}
                  className="rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                  style={{ background: "var(--accent)" }}
                >
                  Create and copy link
                </button>
              </div>
            </div>

            <ul className="mt-3 space-y-2" aria-label="Preview links">
              {data.previewLinks.length === 0 && (
                <li className="text-xs" style={{ color: "var(--muted)" }}>
                  No preview links yet.
                </li>
              )}
              {data.previewLinks.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
                  <span className="min-w-0">
                    <span className="flex items-center gap-1 truncate text-sm">
                      {l.hasPassword && <Lock className="h-3 w-3" aria-label="Password protected" />}
                      {l.name}
                    </span>
                    <span className="block text-[11px]" style={{ color: "var(--muted)" }}>
                      {l.status === "expired"
                        ? "Expired"
                        : l.expiresAt
                          ? `Expires ${new Date(l.expiresAt).toLocaleDateString()}`
                          : "Never expires"}
                      {" · "}
                      {l.views} {l.views === 1 ? "view" : "views"}
                      {l.allowComments ? " · Comments on" : ""}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-1.5">
                    {l.status === "active" && <CopyButton text={l.url} />}
                    <button
                      onClick={() => call(`${base}/preview-links?linkId=${l.id}`, "DELETE")}
                      className="rounded-md px-2 py-1 text-xs text-red-500 hover:bg-red-500/[.08]"
                    >
                      Revoke
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {onPublish && manage && (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t pt-4">
            <span className="text-xs" style={{ color: "var(--muted)" }}>
              Put it online: for everyone, or only for people you invite.
            </span>
            <span className="flex gap-1.5">
              <button onClick={() => onPublish("private")} className="rounded-lg border px-2.5 py-1 text-xs hover:bg-black/[.04] dark:hover:bg-white/[.06]">
                Publish privately
              </button>
              <button onClick={() => onPublish("public")} className="btn-primary rounded-lg px-2.5 py-1 text-xs">
                Publish
              </button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
