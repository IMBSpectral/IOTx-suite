"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Step } from "./types";
import { useBrand } from "@/components/BrandProvider";

type Billing = {
  isAdmin: boolean;
  balance: number;
  topups: number[];
  limits: { scope: string; targetId: string; monthly: number; spent: number }[];
};

/**
 * The agent asked for credits or a higher project limit (request_credits).
 * Admins can approve right here; anyone else is told who can.
 */
export function CreditRequestCard({ projectId, steps, onContinue }: { projectId: string; steps: Step[]; onContinue: (text: string) => void }) {
  const ask = [...steps].reverse().find((s): s is Extract<Step, { kind: "credits" }> => s.kind === "credits");
  const [billing, setBilling] = useState<Billing | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [limit, setLimit] = useState("");
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  const muted = { color: "var(--muted)" };

  useEffect(() => {
    if (!ask) return;
    fetch("/api/workspace/billing")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Billing | null) => {
        if (!d) return;
        setBilling(d);
        setAmount(d.topups.find((t) => t >= (ask.amount ?? 0)) ?? d.topups[d.topups.length - 1]);
        const current = d.limits.find((l) => l.scope === "project" && l.targetId === projectId);
        setLimit(String(ask.amount ?? (current ? current.monthly * 2 : 100)));
      })
      .catch(() => undefined);
  }, [ask, projectId]);

  if (!ask) return null;
  const current = billing?.limits.find((l) => l.scope === "project" && l.targetId === projectId);

  async function approve(body: Record<string, unknown>, msg: string) {
    setError("");
    const r = await fetch("/api/workspace/billing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) setError(d.error ?? "That didn't work");
    else setDone(msg);
  }

  return (
    <div className="mt-3 rounded-xl border p-3 text-sm" style={{ background: "var(--panel)" }} role="group" aria-label="Credit request">
      <p className="font-medium">{ask.ask === "limit" ? "Update credit limit" : "Buy credits"}</p>
      <p className="mt-0.5 text-xs" style={muted}>
        {ask.reason}
        {billing && (
          <>
            {" "}
            Balance: {billing.balance} credits.
            {ask.ask === "limit" && (current ? ` This project's limit: ${current.monthly} a month (${current.spent} used).` : " This project has no limit of its own.")}
          </>
        )}
      </p>
      {done ? (
        <div className="mt-2 flex items-center justify-between gap-2 text-xs">
          <span className="text-emerald-600" role="status">
            {done}
          </span>
          <button onClick={() => onContinue("Done. Continue where you left off.")} className="rounded-lg px-3 py-1.5 font-medium text-white" style={{ background: "var(--accent)" }}>
            Continue
          </button>
        </div>
      ) : billing && !billing.isAdmin ? (
        <p className="mt-2 text-xs" style={muted}>
          Only workspace owners and admins can {ask.ask === "limit" ? "change limits" : "buy credits"}. Ask one of them, then tell the agent to continue.
        </p>
      ) : billing ? (
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2 text-xs">
          {ask.ask === "buy" ? (
            <>
              <select value={amount ?? ""} onChange={(e) => setAmount(Number(e.target.value))} aria-label="Credits to buy" className="rounded-lg border bg-transparent px-2 py-1.5">
                {billing.topups.map((t) => (
                  <option key={t} value={t}>
                    {t} credits
                  </option>
                ))}
              </select>
              <Link href="/settings/billing" className="rounded-lg border px-3 py-1.5">
                Billing
              </Link>
              <button
                onClick={() => void approve({ action: "topup", amount }, `Added ${amount} credits.`)}
                className="rounded-lg px-3 py-1.5 font-medium text-white"
                style={{ background: "var(--accent)" }}
              >
                Buy credits
              </button>
            </>
          ) : (
            <>
              <label className="flex items-center gap-1">
                New monthly limit
                <input value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ""))} aria-label="New monthly limit" className="w-20 rounded-lg border bg-transparent px-2 py-1.5" />
              </label>
              <button
                onClick={() => void approve({ action: "setLimit", scope: "project", targetId: projectId, monthly: Number(limit) }, `This project's limit is now ${limit} credits a month.`)}
                disabled={!Number(limit)}
                className="rounded-lg px-3 py-1.5 font-medium text-white disabled:opacity-50"
                style={{ background: "var(--accent)" }}
              >
                Update credit limit
              </button>
            </>
          )}
        </div>
      ) : null}
      {error && (
        <p className="mt-1 text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** A reusable skill the agent proposed (propose_skill): view it, then save it for the workspace or yourself. */
export function SkillProposalCard({ steps }: { steps: Step[] }) {
  const p = steps.find((s): s is Extract<Step, { kind: "skill" }> => s.kind === "skill");
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const muted = { color: "var(--muted)" };
  if (!p) return null;

  async function save(scope: "workspace" | "personal") {
    setError("");
    const r = await fetch("/api/workspace/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save", scope, name: p!.name, title: p!.title, description: p!.description, instructions: p!.instructions }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) setError(d.error ?? "Couldn't save the skill");
    else setSaved(scope === "personal" ? `Saved for you. Run it with /${p!.name} in any project.` : `Saved to the workspace. Anyone can run it with /${p!.name}.`);
  }

  return (
    <div className="mt-3 rounded-xl border p-3 text-sm" style={{ background: "var(--panel)" }} role="group" aria-label="Skill proposal">
      <p className="font-medium">
        New skill: <code>/{p.name}</code> {p.title && p.title !== p.name ? <span className="font-normal">{p.title}</span> : null}
      </p>
      {p.description && (
        <p className="mt-0.5 text-xs" style={muted}>
          {p.description}
        </p>
      )}
      {open && <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border p-2 font-mono text-[11px]">{p.instructions}</pre>}
      {saved ? (
        <p className="mt-2 text-xs text-emerald-600" role="status">
          {saved}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap justify-end gap-2 text-xs">
          <button onClick={() => setOpen(!open)} className="rounded-lg border px-3 py-1.5" aria-expanded={open}>
            {open ? "Hide proposal" : "View proposal"}
          </button>
          <button onClick={() => void save("personal")} className="rounded-lg border px-3 py-1.5">
            Save for me
          </button>
          <button onClick={() => void save("workspace")} className="rounded-lg px-3 py-1.5 font-medium text-white" style={{ background: "var(--accent)" }}>
            Save to workspace
          </button>
        </div>
      )}
      {error && (
        <p className="mt-1 text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** A connector or MCP call waiting for approval: allow once, for an hour, always, or deny. */
export function PermissionCard({ steps, onContinue }: { steps: Step[]; onContinue: (text: string) => void }) {
  const ask = [...steps].reverse().find((s): s is Extract<Step, { kind: "permission" }> => s.kind === "permission");
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  if (!ask) return null;

  async function answer(how: "once" | "hour" | "always" | "deny") {
    setError("");
    const r = await fetch("/api/workspace/tool-permissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve", key: ask!.key, how }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setError(d.error ?? "That didn't work");
    if (how === "deny") {
      setDone("Denied.");
      onContinue(`Don't use ${ask!.connection} (${ask!.tool}). Carry on without it.`);
      return;
    }
    setDone(how === "always" ? "Always allowed." : how === "hour" ? "Allowed for an hour." : "Allowed once.");
    onContinue(`Approved: you can use ${ask!.connection} (${ask!.tool}). Continue.`);
  }

  return (
    <div className="mt-3 rounded-xl border p-3 text-sm" style={{ background: "var(--panel)" }} role="group" aria-label="Tool approval">
      <p className="font-medium">
        Allow {ask.source === "mcp" ? "this tool" : "this request"} on {ask.connection}?
      </p>
      <p className="mt-0.5 font-mono text-xs" style={{ color: "var(--muted)" }}>
        {ask.tool}
      </p>
      {done ? (
        <p className="mt-2 text-xs text-emerald-600" role="status">
          {done}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap justify-end gap-2 text-xs">
          <button onClick={() => void answer("deny")} className="rounded-lg border px-3 py-1.5">
            Deny
          </button>
          <button onClick={() => void answer("always")} className="rounded-lg border px-3 py-1.5">
            Always allow
          </button>
          <button onClick={() => void answer("hour")} className="rounded-lg border px-3 py-1.5">
            Allow for 1 hour
          </button>
          <button onClick={() => void answer("once")} className="rounded-lg px-3 py-1.5 font-medium text-white" style={{ background: "var(--accent)" }}>
            Allow once
          </button>
        </div>
      )}
      {error && (
        <p className="mt-1 text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The agent needs a saved login: add it on Forge's own page (the AI never sees it). */
export function VaultCard({ steps }: { steps: Step[] }) {
  const brand = useBrand();
  const ask = [...steps].reverse().find((s): s is Extract<Step, { kind: "vault" }> => s.kind === "vault");
  if (!ask) return null;
  return (
    <div className="mt-3 rounded-xl border p-3 text-sm" style={{ background: "var(--panel)" }} role="group" aria-label="Saved login needed">
      <p className="font-medium">Save a login for {ask.site}</p>
      <p className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}>
        Enter it once on {brand.name}&apos;s login page. {brand.shortName} types it into the site for the agent; the AI never sees your password.
      </p>
      <div className="mt-2 flex justify-end text-xs">
        <a href={`/vault?site=${encodeURIComponent(ask.site)}`} target="_blank" rel="noreferrer" className="rounded-lg px-3 py-1.5 font-medium text-white" style={{ background: "var(--accent)" }}>
          Add login
        </a>
      </div>
    </div>
  );
}
