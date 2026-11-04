"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Trash2 } from "lucide-react";

type Member = { userId: string; name: string | null; email: string; role: string };
type Group = { id: string; name: string; members: string[] };
type Link = { token: string; role: string; expiresAt: string | null; maxUses: number | null; uses: number };
type Profile = {
  email: string;
  name: string | null;
  role: string;
  joinedAt: string;
  lastActive: string | null;
  projectsCreated: { id: string; name: string }[];
  collaborations: { id: string; name: string; role: string }[];
  groups: string[];
};

/** Members page extras: seat cap, invite links by role, groups, member profiles, role requests. */
export default function TeamExtras() {
  const [members, setMembers] = useState<Member[]>([]);
  const [data, setData] = useState<{
    role: string;
    seatCap?: number | null;
    seats?: number;
    groups: Group[];
    links?: Link[];
    linkBase?: string;
    myRequest?: { to: string } | null;
  } | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [linkForm, setLinkForm] = useState({ role: "MEMBER", expiresInDays: "7", maxUses: "" });
  const [newLink, setNewLink] = useState("");
  const [group, setGroup] = useState<{ id?: string; name: string; members: string[] } | null>(null);
  const [share, setShare] = useState({ groupId: "", projectId: "", access: "view" });
  const [ask, setAsk] = useState({ to: "MEMBER", reason: "" });
  const [cap, setCap] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const muted = { color: "var(--muted)" };
  const input = "rounded-lg border bg-transparent px-2 py-1.5 text-xs";

  const load = useCallback(() => {
    fetch("/api/workspace/members-extra")
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setCap(d.seatCap ? String(d.seatCap) : "");
      })
      .catch(() => undefined);
    fetch("/api/workspace/members")
      .then((r) => r.json())
      .then((d) => setMembers(d.members ?? []))
      .catch(() => undefined);
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setProjects((Array.isArray(d) ? d : (d.projects ?? [])).map((p: { id: string; name: string }) => ({ id: p.id, name: p.name }))))
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  async function post(body: Record<string, unknown>, msg = "") {
    setError("");
    setNote("");
    const r = await fetch("/api/workspace/members-extra", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setError(d.error ?? "That didn't work");
      return null;
    }
    if (msg) setNote(msg);
    load();
    return d;
  }
  const openProfile = (userId: string) =>
    fetch(`/api/workspace/members-extra?profile=${userId}`)
      .then((r) => r.json())
      .then(setProfile)
      .catch(() => undefined);

  if (!data) return null;
  const admin = data.role === "OWNER" || data.role === "ADMIN";
  const nameOf = (id: string) => members.find((m) => m.userId === id)?.name ?? members.find((m) => m.userId === id)?.email ?? "Former member";

  return (
    <div className="mt-8 space-y-6 text-sm">
      {(note || error) && (
        <p className={`text-xs ${error ? "text-red-500" : "text-emerald-600"}`} role={error ? "alert" : "status"}>
          {error || note}
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Member profiles</h2>
        <div className="flex flex-wrap gap-1.5">
          {members.map((m) => (
            <button key={m.userId} onClick={() => void openProfile(m.userId)} className="rounded-full border px-2.5 py-1 text-xs">
              {m.name ?? m.email}
            </button>
          ))}
        </div>
        {profile && (
          <div className="rounded-xl border p-3 text-xs">
            <div className="flex items-center justify-between">
              <p className="font-medium">
                {profile.name ?? profile.email} <span style={muted}>· {profile.role.toLowerCase()}</span>
              </p>
              <button onClick={() => setProfile(null)} className="underline" style={muted}>
                Close
              </button>
            </div>
            <p style={muted}>
              {profile.email} · joined {new Date(profile.joinedAt).toLocaleDateString()}
              {profile.lastActive ? ` · last active ${new Date(profile.lastActive).toLocaleDateString()}` : ""}
              {profile.groups.length ? ` · groups: ${profile.groups.join(", ")}` : ""}
            </p>
            <p className="mt-2 font-medium">Projects created ({profile.projectsCreated.length})</p>
            <p style={muted}>{profile.projectsCreated.map((p) => p.name).join(", ") || "None"}</p>
            <p className="mt-2 font-medium">Collaborations ({profile.collaborations.length})</p>
            <p style={muted}>{profile.collaborations.map((c) => `${c.name} (${c.role.toLowerCase()})`).join(", ") || "None"}</p>
          </div>
        )}
      </section>

      {!admin && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">Your role</h2>
          {data.myRequest ? (
            <p className="text-xs" style={muted}>
              You asked to be {data.myRequest.to.toLowerCase()}. An admin will decide.
            </p>
          ) : (
            <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void post({ action: "requestRole", ...ask }, "Request sent to the workspace admins."); }}>
              <select value={ask.to} onChange={(e) => setAsk({ ...ask, to: e.target.value })} aria-label="Role to ask for" className={input}>
                <option value="MEMBER">Member (can build)</option>
                <option value="ADMIN">Admin</option>
              </select>
              <input value={ask.reason} onChange={(e) => setAsk({ ...ask, reason: e.target.value })} placeholder="Why (optional)" aria-label="Reason" className={`${input} min-w-0 flex-1`} />
              <button className="rounded-lg border px-3 py-1.5 text-xs">Ask for this role</button>
            </form>
          )}
        </section>
      )}

      {admin && (
        <>
          <section className="space-y-2">
            <h2 className="text-sm font-medium">Seats</h2>
            <form className="flex items-center gap-2 text-xs" onSubmit={(e) => { e.preventDefault(); void post({ action: "seatCap", cap: cap ? Number(cap) : null }, cap ? `Seat cap set to ${cap}.` : "No seat cap."); }}>
              <span>
                {data.seats} {data.seats === 1 ? "person" : "people"}
                {data.seatCap ? ` of ${data.seatCap}` : ""}. Cap:
              </span>
              <input value={cap} onChange={(e) => setCap(e.target.value.replace(/\D/g, ""))} placeholder="No cap" aria-label="Seat cap" className={`${input} w-20`} />
              <button className="rounded-lg border px-2 py-1">Save</button>
            </form>
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">Invite links</h2>
            <form
              className="flex flex-wrap items-center gap-2 text-xs"
              onSubmit={async (e) => {
                e.preventDefault();
                const d = await post({ action: "createLink", role: linkForm.role, expiresInDays: Number(linkForm.expiresInDays) || null, maxUses: Number(linkForm.maxUses) || null }, "Link created.");
                if (d?.url) setNewLink(d.url);
              }}
            >
              <select value={linkForm.role} onChange={(e) => setLinkForm({ ...linkForm, role: e.target.value })} aria-label="Role for people who join" className={input}>
                <option value="VIEWER">Joins as viewer</option>
                <option value="MEMBER">Joins as member</option>
                <option value="ADMIN">Joins as admin</option>
              </select>
              <select value={linkForm.expiresInDays} onChange={(e) => setLinkForm({ ...linkForm, expiresInDays: e.target.value })} aria-label="Expires" className={input}>
                <option value="1">Expires in 1 day</option>
                <option value="7">Expires in 7 days</option>
                <option value="30">Expires in 30 days</option>
                <option value="">Never expires</option>
              </select>
              <input value={linkForm.maxUses} onChange={(e) => setLinkForm({ ...linkForm, maxUses: e.target.value.replace(/\D/g, "") })} placeholder="Any number of uses" aria-label="Maximum uses" className={`${input} w-36`} />
              <button className="rounded-lg border px-3 py-1.5">Create link</button>
            </form>
            {newLink && (
              <p className="flex items-center gap-2 text-xs">
                <code className="truncate">{newLink}</code>
                <button onClick={() => void navigator.clipboard?.writeText(newLink)} aria-label="Copy link">
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </p>
            )}
            <ul className="divide-y rounded-xl border text-xs">
              {data.links?.length === 0 && (
                <li className="px-3 py-2" style={muted}>
                  No active links.
                </li>
              )}
              {data.links?.map((l) => (
                <li key={l.token} className="flex items-center gap-2 px-3 py-2">
                  <span className="flex-1">
                    {l.role.toLowerCase()} · used {l.uses}
                    {l.maxUses ? ` of ${l.maxUses}` : ""} · {l.expiresAt ? `until ${new Date(l.expiresAt).toLocaleDateString()}` : "no expiry"}
                  </span>
                  <button onClick={() => void navigator.clipboard?.writeText(`${data.linkBase}${l.token}`)} aria-label="Copy link">
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => void post({ action: "revokeLink", token: l.token }, "Link turned off.")} className="text-red-500">
                    Turn off
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Groups</h2>
              <button onClick={() => setGroup({ name: "", members: [] })} className="rounded-lg border px-2.5 py-1 text-xs">
                New group
              </button>
            </div>
            {group && (
              <form className="space-y-2 rounded-xl border p-3 text-xs" onSubmit={(e) => { e.preventDefault(); void post({ action: "saveGroup", ...group }, "Group saved.").then((d) => d && setGroup(null)); }}>
                <input value={group.name} onChange={(e) => setGroup({ ...group, name: e.target.value })} placeholder="Group name, e.g. Design" aria-label="Group name" className={`${input} w-full`} />
                <div className="grid gap-1 sm:grid-cols-2">
                  {members.map((m) => (
                    <label key={m.userId} className="flex items-center gap-2">
                      <input type="checkbox" checked={group.members.includes(m.userId)} onChange={(e) => setGroup({ ...group, members: e.target.checked ? [...group.members, m.userId] : group.members.filter((x) => x !== m.userId) })} />
                      {m.name ?? m.email}
                    </label>
                  ))}
                </div>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setGroup(null)} className="rounded-lg border px-2.5 py-1">
                    Cancel
                  </button>
                  <button className="rounded-lg px-2.5 py-1 font-medium text-white" style={{ background: "var(--accent)" }}>
                    Save group
                  </button>
                </div>
              </form>
            )}
            <ul className="divide-y rounded-xl border text-xs">
              {data.groups.length === 0 && (
                <li className="px-3 py-2" style={muted}>
                  No groups yet.
                </li>
              )}
              {data.groups.map((g) => (
                <li key={g.id} className="flex items-center gap-2 px-3 py-2">
                  <span className="flex-1">
                    <span className="font-medium">{g.name}</span> <span style={muted}>· {g.members.map(nameOf).join(", ") || "no one yet"}</span>
                  </span>
                  <button onClick={() => setGroup({ id: g.id, name: g.name, members: g.members })} className="underline">
                    Edit
                  </button>
                  <button onClick={() => void post({ action: "deleteGroup", id: g.id }, "Group deleted.")} aria-label={`Delete ${g.name}`} className="text-red-500">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
            {data.groups.length > 0 && (
              <form className="flex flex-wrap items-center gap-2 text-xs" onSubmit={(e) => { e.preventDefault(); void post({ action: "shareGroup", ...share }, "Shared with the group."); }}>
                <span>Share</span>
                <select value={share.projectId} onChange={(e) => setShare({ ...share, projectId: e.target.value })} aria-label="Project" className={input}>
                  <option value="">a project…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <span>with</span>
                <select value={share.groupId} onChange={(e) => setShare({ ...share, groupId: e.target.value })} aria-label="Group" className={input}>
                  <option value="">a group…</option>
                  {data.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
                <select value={share.access} onChange={(e) => setShare({ ...share, access: e.target.value })} aria-label="Access" className={input}>
                  <option value="view">can view</option>
                  <option value="edit">can edit</option>
                </select>
                <button disabled={!share.projectId || !share.groupId} className="rounded-lg border px-3 py-1.5 disabled:opacity-50">
                  Share
                </button>
              </form>
            )}
          </section>
        </>
      )}
    </div>
  );
}
