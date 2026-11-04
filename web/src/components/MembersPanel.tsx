"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Member = {
  id: string;
  role: string;
  userId: string;
  name: string | null;
  email: string;
};

export default function MembersPanel({
  initialMembers,
  canManage,
  currentUserId,
}: {
  initialMembers: Member[];
  canManage: boolean;
  currentUserId: string;
}) {
  const [members, setMembers] = useState(initialMembers);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("MEMBER");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function refresh() {
    const res = await fetch("/api/workspace/members");
    if (res.ok) setMembers((await res.json()).members ?? []);
  }

  async function invite() {
    const address = email.trim();
    if (!address || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/workspace/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: address, role }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Could not invite");
      }
      setEmail("");
      await refresh();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not invite");
    } finally {
      setBusy(false);
    }
  }

  async function remove(membershipId: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/workspace/members", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ membershipId }),
      });
      if (res.ok) {
        await refresh();
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      {canManage && (
        <section>
          <h2 className="mb-3 text-sm font-medium">Invite someone</h2>
          <div className="flex flex-wrap gap-2">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void invite();
              }}
              type="email"
              placeholder="name@company.com"
              aria-label="Email to invite"
              className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
              style={{ background: "var(--panel)" }}
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              aria-label="Role"
              className="rounded-lg border px-3 py-2 text-sm outline-none"
              style={{ background: "var(--panel)" }}
            >
              <option value="MEMBER">Member</option>
              <option value="ADMIN">Admin</option>
              <option value="VIEWER">Viewer</option>
            </select>
            <button
              onClick={invite}
              disabled={busy || !email.trim()}
              className="rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-40"
              style={{ background: "var(--accent)" }}
            >
              Invite
            </button>
          </div>
          {error && (
            <p className="mt-2 text-xs text-red-500" role="alert">
              {error}
            </p>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-medium">
          Members <span style={{ color: "var(--muted)" }}>({members.length})</span>
        </h2>
        <ul className="divide-y rounded-xl border" style={{ background: "var(--panel)" }}>
          {members.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {m.name ?? m.email.split("@")[0]}
                  {m.userId === currentUserId && (
                    <span className="ml-1.5 text-xs" style={{ color: "var(--muted)" }}>
                      you
                    </span>
                  )}
                </p>
                <p className="truncate text-xs" style={{ color: "var(--muted)" }}>
                  {m.email}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  {m.role.charAt(0) + m.role.slice(1).toLowerCase()}
                </span>
                {canManage && m.role !== "OWNER" && m.userId !== currentUserId && (
                  <button
                    onClick={() => remove(m.id)}
                    disabled={busy}
                    className="text-xs text-red-500 hover:underline disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
