"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import { Download, Play, RotateCcw, Trash2 } from "lucide-react";

/**
 * The Cloud manager's sections beside Overview: Database (browse and edit
 * rows), Users, SQL editor, Logs and Backups. Everything goes through
 * /api/projects/<id>/cloud/admin, which needs edit access.
 */

type Table = {
  name: string;
  rows: number;
  columns: { name: string; type: string }[];
};
const muted = { color: "var(--muted)" };
const input = "rounded-md border bg-transparent px-2 py-1 text-xs outline-none";

/** Which environment the Cloud tab is showing: "test" (default) or "live". */
export const CloudEnvContext = createContext<"test" | "live">("test");

function useAdmin(projectId: string) {
  const env = useContext(CloudEnvContext);
  const base = `/api/projects/${projectId}/cloud/admin`;
  const get = useCallback(
    async (qs: string) => {
      const r = await fetch(`${base}?${qs}${env === "live" ? "&env=live" : ""}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Couldn't load");
      return d;
    },
    [base, env],
  );
  const post = useCallback(
    async (body: Record<string, unknown>) => {
      const r = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(env === "live" ? { ...body, env } : body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "That didn't work");
      return d;
    },
    [base, env],
  );
  return { base, get, post };
}

const show = (v: unknown) =>
  v === null || v === undefined
    ? "∅"
    : typeof v === "object"
      ? JSON.stringify(v)
      : String(v);

function ResultTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows.length)
    return (
      <p className="text-xs" style={muted}>
        No rows.
      </p>
    );
  const cols = Object.keys(rows[0]);
  return (
    <div className="max-h-[50vh] overflow-auto rounded-lg border">
      <table className="w-full text-left font-mono text-[11px]">
        <thead className="sticky top-0" style={{ background: "var(--panel)" }}>
          <tr>
            {cols.map((c) => (
              <th key={c} className="border-b px-2 py-1 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b last:border-0">
              {cols.map((c) => (
                <td
                  key={c}
                  className="max-w-[240px] truncate px-2 py-1"
                  title={show(r[c])}
                >
                  {show(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DatabaseSection({
  projectId,
  tables,
  onChanged,
}: {
  projectId: string;
  tables: Table[];
  onChanged: () => void;
}) {
  const { get, post } = useAdmin(projectId);
  const [table, setTable] = useState(tables[0]?.name ?? "");
  const [data, setData] = useState<{
    rows: Record<string, unknown>[];
    total: number;
  } | null>(null);
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<{
    rowid: number | null;
    values: Record<string, string>;
  } | null>(null);
  const [error, setError] = useState("");
  const cols = tables.find((t) => t.name === table)?.columns ?? [];

  const load = useCallback(() => {
    if (!table) return;
    get(`view=rows&table=${encodeURIComponent(table)}&offset=${offset}`).then(
      setData,
      (e) => setError(e.message),
    );
  }, [get, table, offset]);
  useEffect(load, [load]);

  async function save() {
    if (!editing) return;
    setError("");
    // Empty fields stay unset on a new row; "null" clears a value.
    const values = Object.fromEntries(
      Object.entries(editing.values)
        .filter(([, v]) => v !== "")
        .map(([k, v]) => [k, v === "null" ? null : v]),
    );
    try {
      if (editing.rowid == null)
        await post({ action: "insertRow", table, row: values });
      else
        await post({
          action: "updateRow",
          table,
          rowid: editing.rowid,
          patch: values,
        });
      setEditing(null);
      load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!tables.length)
    return (
      <p className="text-xs" style={muted}>
        No tables yet. Ask the agent to add the data your app needs.
      </p>
    );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Table"
          value={table}
          onChange={(e) => {
            setTable(e.target.value);
            setOffset(0);
            setEditing(null);
          }}
          className={input}
        >
          {tables.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name} ({t.rows})
            </option>
          ))}
        </select>
        <button
          onClick={() => setEditing({ rowid: null, values: {} })}
          className="rounded-md border px-2 py-1 text-xs"
        >
          Insert row
        </button>
        <span className="ml-auto text-xs" style={muted}>
          {data ? `${data.total} row${data.total === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
      {editing && (
        <div
          className="space-y-1.5 rounded-lg border p-3"
          role="group"
          aria-label={editing.rowid == null ? "New row" : "Edit row"}
        >
          {cols.map((c) => (
            <label key={c.name} className="flex items-center gap-2 text-xs">
              <span className="w-32 shrink-0 font-mono" style={muted}>
                {c.name}
              </span>
              <input
                value={editing.values[c.name] ?? ""}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    values: { ...editing.values, [c.name]: e.target.value },
                  })
                }
                placeholder={c.type || "value"}
                className={`${input} min-w-0 flex-1 font-mono`}
              />
            </label>
          ))}
          <div className="flex justify-end gap-2 pt-1 text-xs">
            <button onClick={() => setEditing(null)} style={muted}>
              Cancel
            </button>
            <button
              onClick={() => void save()}
              className="rounded-md px-2.5 py-1 font-medium text-white"
              style={{ background: "var(--accent)" }}
            >
              Save
            </button>
          </div>
        </div>
      )}
      {data && (
        <div className="max-h-[50vh] overflow-auto rounded-lg border">
          <table className="w-full text-left font-mono text-[11px]">
            <thead
              className="sticky top-0"
              style={{ background: "var(--panel)" }}
            >
              <tr>
                {cols.map((c) => (
                  <th key={c.name} className="border-b px-2 py-1 font-medium">
                    {c.name}
                  </th>
                ))}
                <th className="border-b px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const rowid = Number(r._rowid);
                return (
                  <tr key={rowid} className="border-b last:border-0">
                    {cols.map((c) => (
                      <td
                        key={c.name}
                        className="max-w-[220px] truncate px-2 py-1"
                        title={show(r[c.name])}
                      >
                        {show(r[c.name])}
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-2 py-1 text-right">
                      <button
                        onClick={() =>
                          setEditing({
                            rowid,
                            values: Object.fromEntries(
                              cols.map((c) => [
                                c.name,
                                r[c.name] == null ? "" : String(r[c.name]),
                              ]),
                            ),
                          })
                        }
                        className="underline"
                      >
                        Edit
                      </button>{" "}
                      <button
                        onClick={async () => {
                          if (!confirm("Delete this row?")) return;
                          await post({
                            action: "deleteRow",
                            table,
                            rowid,
                          }).then(
                            () => {
                              load();
                              onChanged();
                            },
                            (e) => setError(e.message),
                          );
                        }}
                        aria-label="Delete row"
                        className="text-red-600"
                      >
                        <Trash2 className="inline h-3 w-3" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > 50 && (
        <div className="flex justify-end gap-2 text-xs">
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 50))}
            className="rounded-md border px-2 py-1 disabled:opacity-40"
          >
            Newer
          </button>
          <button
            disabled={offset + 50 >= data.total}
            onClick={() => setOffset(offset + 50)}
            className="rounded-md border px-2 py-1 disabled:opacity-40"
          >
            Older
          </button>
        </div>
      )}
    </div>
  );
}

export function UsersSection({ projectId }: { projectId: string }) {
  const { get, post } = useAdmin(projectId);
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<
    { id: string; email: string; created_at: string }[]
  >([]);
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => {
    get(`view=users&q=${encodeURIComponent(q)}`).then(
      (d) => setUsers(d.users),
      (e) => setError(e.message),
    );
  }, [get, q]);
  useEffect(load, [load]);

  async function run(
    body: Record<string, unknown>,
    done?: (d: { generatedPassword?: string | null; email?: string }) => void,
  ) {
    setError("");
    setNote("");
    try {
      const d = await post(body);
      done?.(d);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by email"
          aria-label="Search users"
          className={`${input} min-w-0 flex-1`}
        />
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="new@user.com"
          aria-label="New user email"
          className={input}
        />
        <button
          onClick={() =>
            void run({ action: "createUser", email }, (d) => {
              setEmail("");
              setNote(
                `Created ${d.email}. Temporary password: ${d.generatedPassword} (shown once).`,
              );
            })
          }
          disabled={!email.trim()}
          className="rounded-md border px-2 py-1 text-xs disabled:opacity-40"
        >
          Add user
        </button>
      </div>
      {note && (
        <p
          className="rounded-md bg-emerald-500/10 px-2 py-1.5 font-mono text-xs"
          role="status"
        >
          {note}
        </p>
      )}
      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
      {users.length === 0 ? (
        <p className="text-xs" style={muted}>
          No users{q ? " match" : " yet"}.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border text-xs">
          {users.map((u) => (
            <li
              key={u.id}
              className="flex items-center justify-between gap-2 px-3 py-2"
            >
              <span className="min-w-0">
                <span className="block truncate">{u.email}</span>
                <span style={muted}>
                  Joined {new Date(u.created_at).toLocaleDateString()}
                </span>
              </span>
              <span className="flex shrink-0 gap-2">
                <button
                  onClick={() =>
                    void run({ action: "setPassword", userId: u.id }, (d) =>
                      setNote(
                        `New password for ${u.email}: ${d.generatedPassword} (shown once).`,
                      ),
                    )
                  }
                  className="underline"
                >
                  Reset password
                </button>
                <button
                  onClick={() =>
                    confirm(`Delete ${u.email}? Their rows stay.`) &&
                    void run({ action: "deleteUser", userId: u.id })
                  }
                  className="text-red-600 underline"
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SqlSection({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const { post } = useAdmin(projectId);
  const [sql, setSql] = useState(
    "SELECT name FROM sqlite_master WHERE type = 'table';",
  );
  const [result, setResult] = useState<
    | { kind: "rows"; rows: Record<string, unknown>[]; ms: number }
    | { kind: "done"; changes: number; ms: number }
    | null
  >(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function run() {
    setError("");
    setResult(null);
    if (
      !/^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql) &&
      !confirm(
        "This changes data or structure and can't be undone (take a backup first if unsure). Run it?",
      )
    )
      return;
    setBusy(true);
    try {
      const d = await post({ action: "sql", sql });
      setResult(d);
      if (d.kind === "done") onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <textarea
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={(e) =>
          e.key === "Enter" && (e.metaKey || e.ctrlKey) && void run()
        }
        rows={6}
        spellCheck={false}
        aria-label="SQL"
        className="w-full resize-y rounded-lg border bg-transparent p-2 font-mono text-xs outline-none"
      />
      <div className="flex items-center justify-between text-xs">
        <span style={muted}>
          SQLite. Ctrl+Enter runs it. Changes run in a transaction.
        </span>
        <button
          onClick={() => void run()}
          disabled={busy}
          className="flex items-center gap-1 rounded-md px-2.5 py-1 font-medium text-white disabled:opacity-50"
          style={{ background: "var(--accent)" }}
        >
          <Play className="h-3 w-3" /> {busy ? "Running…" : "Run"}
        </button>
      </div>
      {error && (
        <p
          className="rounded-md bg-red-500/10 px-2 py-1.5 font-mono text-xs text-red-600"
          role="alert"
        >
          {error}
        </p>
      )}
      {result?.kind === "rows" && (
        <>
          <p className="text-xs" style={muted}>
            {result.rows.length} row{result.rows.length === 1 ? "" : "s"} ·{" "}
            {result.ms} ms
          </p>
          <ResultTable rows={result.rows} />
        </>
      )}
      {result?.kind === "done" && (
        <p className="text-xs" role="status">
          Done: {result.changes} row{result.changes === 1 ? "" : "s"} changed ·{" "}
          {result.ms} ms
        </p>
      )}
    </div>
  );
}

export function LogsSection({ projectId }: { projectId: string }) {
  const { get } = useAdmin(projectId);
  const [q, setQ] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [logs, setLogs] = useState<
    | {
        at: string;
        method: string;
        path: string;
        status: number;
        ms: number;
        user_id: string | null;
      }[]
    | null
  >(null);
  const load = useCallback(() => {
    get(
      `view=logs&q=${encodeURIComponent(q)}${errorsOnly ? "&errors=1" : ""}`,
    ).then(
      (d) => setLogs(d.logs),
      () => setLogs([]),
    );
  }, [get, q, errorsOnly]);
  useEffect(load, [load]);

  function download() {
    const blob = new Blob([JSON.stringify(logs ?? [], null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cloud-logs.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search path or method"
          aria-label="Search logs"
          className={`${input} min-w-0 flex-1`}
        />
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => setErrorsOnly(e.target.checked)}
          />{" "}
          Errors only
        </label>
        <button onClick={load} className="rounded-md border px-2 py-1">
          Refresh
        </button>
        <button
          onClick={download}
          aria-label="Download logs as JSON"
          className="rounded-md border px-2 py-1"
        >
          <Download className="inline h-3 w-3" /> JSON
        </button>
      </div>
      {!logs ? (
        <p className="text-xs" style={muted}>
          Loading…
        </p>
      ) : logs.length === 0 ? (
        <p className="text-xs" style={muted}>
          No requests{errorsOnly ? " failed" : " yet"}. Requests from your app
          to its backend show up here.
        </p>
      ) : (
        <ul className="max-h-[55vh] divide-y overflow-auto rounded-lg border font-mono text-[11px]">
          {logs.map((l, i) => (
            <li key={i} className="flex items-center gap-2 px-2 py-1">
              <span className="w-16 shrink-0" style={muted}>
                {new Date(l.at).toLocaleTimeString()}
              </span>
              <span
                className={`w-9 shrink-0 font-medium ${l.status >= 500 ? "text-red-600" : l.status >= 400 ? "text-amber-600" : "text-emerald-600"}`}
              >
                {l.status}
              </span>
              <span className="w-14 shrink-0">{l.method}</span>
              <span className="min-w-0 flex-1 truncate" title={l.path}>
                {l.path}
              </span>
              <span className="shrink-0" style={muted}>
                {l.ms} ms
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BackupsSection({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const { base, get, post } = useAdmin(projectId);
  const [backups, setBackups] = useState<
    { id: string; size: number; at: string }[] | null
  >(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const load = useCallback(() => {
    get("view=backups").then(
      (d) => setBackups(d.backups),
      (e) => setError(e.message),
    );
  }, [get]);
  useEffect(load, [load]);
  const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

  async function run(body: Record<string, unknown>, msg: string) {
    setError("");
    setNote("");
    try {
      await post(body);
      setNote(msg);
      load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          onClick={() => void run({ action: "backup" }, "Backup saved.")}
          className="rounded-md px-2.5 py-1 font-medium text-white"
          style={{ background: "var(--accent)" }}
        >
          Back up now
        </button>
        <a
          href={`${base}?view=export`}
          className="rounded-md border px-2.5 py-1"
        >
          <Download className="inline h-3 w-3" /> Export database
        </a>
        <button
          onClick={() => void run({ action: "emailExport" }, "Download link sent to your email. It works for 24 hours.")}
          className="rounded-md border px-2.5 py-1"
        >
          Email me a link
        </button>
        <span style={muted}>
          A backup is a full copy of the database. Restoring keeps a copy of the
          current data first.
        </span>
      </div>
      {note && (
        <p className="text-xs text-emerald-600" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
      {!backups ? null : backups.length === 0 ? (
        <p className="text-xs" style={muted}>
          No backups yet.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border text-xs">
          {backups.map((b) => (
            <li
              key={b.id}
              className="flex items-center justify-between gap-2 px-3 py-2"
            >
              <span>
                {new Date(b.at).toLocaleString()}{" "}
                <span style={muted}>
                  · {kb(b.size)}
                  {b.id.endsWith("before-restore") ? " · before a restore" : ""}
                </span>
              </span>
              <span className="flex gap-2">
                <button
                  onClick={() =>
                    confirm(
                      "Replace the database with this backup? The current data is backed up first.",
                    ) &&
                    void run(
                      { action: "restore", backupId: b.id },
                      "Restored. The previous data was backed up.",
                    )
                  }
                  className="underline"
                >
                  <RotateCcw className="inline h-3 w-3" /> Restore
                </button>
                <button
                  onClick={() =>
                    confirm("Delete this backup?") &&
                    void run(
                      { action: "deleteBackup", backupId: b.id },
                      "Backup deleted.",
                    )
                  }
                  className="text-red-600 underline"
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type BucketRow = { name: string; access: string; files: number; bytes: number };
type FileRow = {
  path: string;
  size: number;
  content_type: string;
  owner_id: string | null;
  updated_at: string;
  url: string | null;
};
const ACCESS_LABEL: Record<string, string> = {
  public: "Public",
  authenticated: "Signed-in users",
  owner: "Uploader only",
};
const size = (n: number) =>
  n < 1024 * 1024
    ? `${Math.max(1, Math.round(n / 1024))} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Storage: buckets and their files (upload, download, share a link, delete). */
export function StorageSection({ projectId }: { projectId: string }) {
  const { base, get, post } = useAdmin(projectId);
  const [info, setInfo] = useState<{
    buckets: BucketRow[];
    used: { bytes: number; files: number };
    maxFileBytes: number;
  } | null>(null);
  const [bucket, setBucket] = useState("public");
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const [prefix, setPrefix] = useState("");
  const [newName, setNewName] = useState("");
  const [newAccess, setNewAccess] = useState("owner");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const loadInfo = useCallback(() => {
    get("view=storage").then(setInfo, (e) => setError(e.message));
  }, [get]);
  const loadFiles = useCallback(() => {
    get(
      `view=files&bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(prefix)}`,
    ).then(
      (d) => setFiles(d.files),
      (e) => setError(e.message),
    );
  }, [get, bucket, prefix]);
  useEffect(loadInfo, [loadInfo]);
  useEffect(loadFiles, [loadFiles]);

  async function run(body: Record<string, unknown>, msg = "") {
    setError("");
    setNote("");
    try {
      const d = await post(body);
      if (msg) setNote(msg);
      loadInfo();
      loadFiles();
      return d;
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function upload(list: FileList | null) {
    if (!list?.length || !info) return;
    setBusy(true);
    for (const f of Array.from(list)) {
      if (f.size > info.maxFileBytes) {
        setError(`${f.name} is larger than ${size(info.maxFileBytes)}.`);
        continue;
      }
      const base64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
        r.onerror = () => reject(r.error);
        r.readAsDataURL(f);
      });
      const folder = prefix ? prefix.replace(/\/?$/, "/") : "";
      const path = folder + f.name.replace(/[^\w.\- ()@+]/g, "_");
      await run(
        { action: "uploadFile", bucket, path, contentType: f.type, base64 },
        `Uploaded ${f.name}.`,
      );
    }
    setBusy(false);
  }

  async function copyLink(f: FileRow) {
    const url =
      f.url ??
      (await run({ action: "signUrl", bucket, path: f.path, expiresIn: 86400 }))
        ?.url;
    if (!url) return;
    await navigator.clipboard?.writeText(url).catch(() => undefined);
    setNote(f.url ? "Link copied." : "Link copied. It works for 24 hours.");
  }

  const current = info?.buckets.find((b) => b.name === bucket);

  return (
    <div className="grid gap-3 md:grid-cols-[200px_1fr]">
      <div className="space-y-2">
        <ul className="divide-y rounded-lg border text-xs" aria-label="Buckets">
          {info?.buckets.map((b) => (
            <li key={b.name}>
              <button
                onClick={() => {
                  setBucket(b.name);
                  setPrefix("");
                }}
                aria-current={b.name === bucket}
                className="w-full px-3 py-2 text-left"
                style={
                  b.name === bucket
                    ? { background: "rgba(127,127,127,.12)" }
                    : undefined
                }
              >
                <span className="font-medium">{b.name}</span>
                <span className="block" style={muted}>
                  {ACCESS_LABEL[b.access]} · {b.files} file
                  {b.files === 1 ? "" : "s"}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <form
          className="space-y-1 rounded-lg border p-2 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newName.trim().toLowerCase();
            if (!name) return;
            void run(
              { action: "createBucket", name, access: newAccess },
              `Bucket ${name} created.`,
            ).then((d) => {
              if (d) {
                setBucket(name);
                setNewName("");
              }
            });
          }}
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New bucket name"
            aria-label="New bucket name"
            className={`${input} w-full`}
          />
          <select
            value={newAccess}
            onChange={(e) => setNewAccess(e.target.value)}
            aria-label="Who can view files"
            className={`${input} w-full`}
          >
            {Object.entries(ACCESS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <button type="submit" className="w-full rounded-md border px-2 py-1">
            Create bucket
          </button>
        </form>
        {info && (
          <p className="text-xs" style={muted}>
            {size(info.used.bytes)} used · {info.used.files} file
            {info.used.files === 1 ? "" : "s"}
          </p>
        )}
      </div>

      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label
            className="cursor-pointer rounded-md px-2.5 py-1 font-medium text-white"
            style={{ background: "var(--accent)", opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Uploading…" : "Upload files"}
            <input
              type="file"
              multiple
              className="sr-only"
              disabled={busy}
              onChange={(e) => {
                void upload(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="Folder (e.g. avatars/)"
            aria-label="Folder"
            className={input}
          />
          {current && (
            <select
              value={current.access}
              onChange={(e) =>
                void run(
                  {
                    action: "createBucket",
                    name: bucket,
                    access: e.target.value,
                  },
                  `${bucket}: ${ACCESS_LABEL[e.target.value].toLowerCase()} can view files.`,
                )
              }
              aria-label="Bucket access"
              className={input}
            >
              {Object.entries(ACCESS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => {
              if (
                confirm(
                  `Delete the bucket ${bucket} and all ${current?.files ?? 0} files in it?`,
                )
              )
                void run(
                  { action: "deleteBucket", name: bucket },
                  `Bucket ${bucket} deleted.`,
                ).then(() => setBucket("public"));
            }}
            className="ml-auto rounded-md border px-2 py-1 text-red-500"
          >
            Delete bucket
          </button>
        </div>
        {note && (
          <p className="text-xs text-emerald-600" role="status">
            {note}
          </p>
        )}
        {error && (
          <p className="text-xs text-red-500" role="alert">
            {error}
          </p>
        )}
        {!files ? null : files.length === 0 ? (
          <p
            className="rounded-lg border border-dashed p-6 text-center text-xs"
            style={muted}
          >
            No files{prefix ? ` in ${prefix}` : ""} yet. Files your app uploads
            show up here.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border text-xs">
            {files.map((f) => (
              <li key={f.path} className="flex items-center gap-2 px-3 py-2">
                {f.url && f.content_type.startsWith("image/") ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={f.url}
                    alt=""
                    className="h-8 w-8 shrink-0 rounded object-cover"
                  />
                ) : (
                  <span
                    className="grid h-8 w-8 shrink-0 place-items-center rounded border text-[9px]"
                    style={muted}
                  >
                    {f.content_type.split("/")[1]?.slice(0, 4) ?? "file"}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{f.path}</span>
                  <span style={muted}>
                    {size(f.size)} · {new Date(f.updated_at).toLocaleString()}
                    {f.owner_id ? ` · uploaded by ${f.owner_id.slice(0, 8)}` : ""}
                  </span>
                </span>
                <button
                  onClick={() => void copyLink(f)}
                  className="rounded-md border px-2 py-0.5"
                >
                  Copy link
                </button>
                <a
                  href={`${base}?view=file&bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(f.path)}`}
                  aria-label={`Download ${f.path}`}
                  className="rounded-md border px-2 py-0.5"
                >
                  <Download className="h-3 w-3" />
                </a>
                <button
                  onClick={() => {
                    if (confirm(`Delete ${f.path}?`))
                      void run(
                        { action: "deleteFile", bucket, path: f.path },
                        `Deleted ${f.path}.`,
                      );
                  }}
                  aria-label={`Delete ${f.path}`}
                  className="rounded-md border px-2 py-0.5 text-red-500"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

type FnRow = {
  name: string;
  calls: number;
  errors: number;
  avgMs: number;
  perDay: { day: string; calls: number }[];
};
type Invocation = {
  at: string;
  name: string;
  trigger: string;
  status: number;
  ms: number;
  error: string | null;
  logs: string;
};

function Bars({ perDay }: { perDay: { day: string; calls: number }[] }) {
  const max = Math.max(1, ...perDay.map((d) => d.calls));
  return (
    <span
      className="flex h-6 items-end gap-px"
      role="img"
      aria-label={`Calls in the last 7 days: ${perDay.map((d) => d.calls).join(", ")}`}
    >
      {perDay.map((d) => (
        <span
          key={d.day}
          title={`${d.day}: ${d.calls}`}
          className="w-1.5 rounded-sm"
          style={{
            height: `${Math.max(8, (d.calls / max) * 100)}%`,
            background: d.calls ? "var(--accent)" : "rgba(127,127,127,.25)",
          }}
        />
      ))}
    </span>
  );
}

/** Functions: what's deployed, calls over 7 days, logs, code, a test run. */
export function FunctionsSection({ projectId }: { projectId: string }) {
  const { get, post } = useAdmin(projectId);
  const [info, setInfo] = useState<{
    deployedAt: string | null;
    deploys: { deployId: string; deployedAt: string; names: string[] }[];
    baseUrl: string;
    functions: FnRow[];
  } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState<"logs" | "code" | "test">("logs");
  const [logs, setLogs] = useState<Invocation[] | null>(null);
  const [source, setSource] = useState("");
  const [testBody, setTestBody] = useState("{}");
  const [testOut, setTestOut] = useState<{ status: number; body: string } | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    get("view=functions").then(setInfo, (e) => setError(e.message));
  }, [get]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!open) return;
    setLogs(null);
    setSource("");
    setTestOut(null);
    if (tab === "logs")
      get(`view=fnLogs&name=${encodeURIComponent(open)}`).then(
        (d) => setLogs(d.logs),
        (e) => setError(e.message),
      );
    if (tab === "code")
      get(`view=fnSource&name=${encodeURIComponent(open)}`).then(
        (d) => setSource(d.source),
        (e) => setError(e.message),
      );
  }, [get, open, tab]);

  async function deploy() {
    setError("");
    setNote("");
    setBusy(true);
    try {
      const d = await post({ action: "deployFunctions" });
      setNote(
        d.names.length
          ? `Deployed ${d.names.join(", ")}.`
          : "Deployed. The app has no functions/ folder yet.",
      );
      load();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  async function test() {
    if (!open) return;
    setError("");
    setBusy(true);
    try {
      setTestOut(await post({ action: "invokeFunction", name: open, body: testBody }));
      load();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          onClick={() => void deploy()}
          disabled={busy}
          className="rounded-md px-2.5 py-1 font-medium text-white disabled:opacity-60"
          style={{ background: "var(--accent)" }}
        >
          Deploy now
        </button>
        <span style={muted}>
          Server code lives in functions/&lt;name&gt;.ts and deploys when a
          change is built.
          {info?.deployedAt
            ? ` Last deploy ${new Date(info.deployedAt).toLocaleString()}.`
            : " Nothing deployed yet."}
        </span>
      </div>
      {note && (
        <p className="text-xs text-emerald-600" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
      {!!info?.deploys.length && (
        <details className="text-xs">
          <summary className="cursor-pointer" style={muted}>
            Builds ({info.deploys.length})
          </summary>
          <ul className="mt-1 divide-y rounded-lg border">
            {info.deploys.map((d, i) => (
              <li key={d.deployId} className="flex gap-3 px-3 py-1.5">
                <span className={i === 0 ? "text-emerald-600" : ""}>{i === 0 ? "Live" : "Previous"}</span>
                <span>{new Date(d.deployedAt).toLocaleString()}</span>
                <span className="truncate" style={muted}>
                  {d.names.join(", ") || "no functions"}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {info && info.functions.length === 0 ? (
        <p
          className="rounded-lg border border-dashed p-6 text-center text-xs"
          style={muted}
        >
          No functions yet. Ask the agent for something that needs a secret
          key or runs on a schedule, such as “charge with Stripe” or “email a
          daily summary”.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border text-xs">
          {info?.functions.map((f) => (
            <li key={f.name}>
              <div className="flex items-center gap-3 px-3 py-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" title="Deployed" />
                <button
                  onClick={() => {
                    setOpen(open === f.name ? null : f.name);
                    setTab("logs");
                  }}
                  aria-expanded={open === f.name}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="font-medium">{f.name}</span>
                  <span className="block" style={muted}>
                    {f.calls} call{f.calls === 1 ? "" : "s"} in 7 days
                    {f.errors ? ` · ${f.errors} failed` : ""}
                    {f.calls ? ` · ${f.avgMs} ms average` : ""}
                  </span>
                </button>
                <Bars perDay={f.perDay} />
                <button
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(`${info.baseUrl}/${f.name}`)
                      .catch(() => undefined);
                    setNote("URL copied. Calls need the app's anon key in an apikey header.");
                  }}
                  className="rounded-md border px-2 py-0.5"
                >
                  Copy URL
                </button>
              </div>
              {open === f.name && (
                <div className="space-y-2 border-t px-3 py-2">
                  <div className="flex gap-1" role="tablist">
                    {(["logs", "code", "test"] as const).map((t) => (
                      <button
                        key={t}
                        role="tab"
                        aria-selected={tab === t}
                        onClick={() => setTab(t)}
                        className="rounded-md px-2 py-0.5"
                        style={tab === t ? { background: "rgba(127,127,127,.15)" } : muted}
                      >
                        {t === "logs" ? "Logs" : t === "code" ? "View code" : "Test"}
                      </button>
                    ))}
                  </div>
                  {tab === "logs" &&
                    (!logs ? null : logs.length === 0 ? (
                      <p style={muted}>No calls yet.</p>
                    ) : (
                      <ul className="max-h-72 space-y-1 overflow-auto">
                        {logs.map((l, i) => (
                          <li key={i} className="rounded border px-2 py-1">
                            <span className={l.status >= 400 ? "text-red-500" : "text-emerald-600"}>
                              {l.status}
                            </span>{" "}
                            <span style={muted}>
                              {new Date(l.at).toLocaleString()} · {l.ms} ms · {l.trigger}
                            </span>
                            {l.error && (
                              <pre className="mt-1 whitespace-pre-wrap text-red-500">{l.error}</pre>
                            )}
                            {l.logs && (
                              <pre className="mt-1 whitespace-pre-wrap" style={muted}>
                                {l.logs}
                              </pre>
                            )}
                          </li>
                        ))}
                      </ul>
                    ))}
                  {tab === "code" && (
                    <pre className="max-h-80 overflow-auto rounded border p-2 font-mono text-[11px]">
                      {source}
                    </pre>
                  )}
                  {tab === "test" && (
                    <div className="space-y-2">
                      <textarea
                        value={testBody}
                        onChange={(e) => setTestBody(e.target.value)}
                        aria-label="Request body (JSON)"
                        rows={3}
                        className={`${input} w-full font-mono`}
                      />
                      <button
                        onClick={() => void test()}
                        disabled={busy}
                        className="rounded-md border px-2.5 py-1 disabled:opacity-60"
                      >
                        <Play className="inline h-3 w-3" /> {busy ? "Running…" : "Run"}
                      </button>
                      {testOut && (
                        <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded border p-2 font-mono text-[11px]">
                          <span className={testOut.status >= 400 ? "text-red-500" : "text-emerald-600"}>
                            {testOut.status}
                          </span>
                          {"\n"}
                          {testOut.body}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type JobRow = {
  id: string;
  name: string;
  fn: string;
  schedule: string;
  timezone: string;
  enabled: boolean;
  description: string;
  nextRunAt: string | null;
  lastRunAt?: string | null;
  lastStatus?: number | null;
  runs30d: number;
  failed30d: number;
  seconds30d: number;
};

/** Jobs: functions on a schedule, with run history and on/off. */
export function JobsSection({ projectId }: { projectId: string }) {
  const { get, post } = useAdmin(projectId);
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [fns, setFns] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [runs, setRuns] = useState<
    { at: string; status: number; ms: number; error: string | null }[] | null
  >(null);
  const [form, setForm] = useState({ name: "", fn: "", schedule: "0 9 * * *", timezone: "UTC" });
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    get("view=jobs").then(
      (d) => setJobs(d.jobs),
      (e) => setError(e.message),
    );
    get("view=functions").then(
      (d) => setFns(d.functions.map((f: { name: string }) => f.name)),
      () => undefined,
    );
  }, [get]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!open) return;
    setRuns(null);
    get(`view=jobRuns&job=${open}`).then(
      (d) => setRuns(d.runs),
      (e) => setError(e.message),
    );
  }, [get, open]);
  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) setForm((f) => ({ ...f, timezone: tz }));
    } catch {}
  }, []);

  async function run(body: Record<string, unknown>, msg = "") {
    setError("");
    setNote("");
    try {
      const d = await post(body);
      if (msg) setNote(msg);
      load();
      if (open) {
        get(`view=jobRuns&job=${open}`).then((x) => setRuns(x.runs), () => undefined);
      }
      return d;
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-3 text-xs">
      {note && (
        <p className="text-emerald-600" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="text-red-500" role="alert">
          {error}
        </p>
      )}
      {!jobs ? null : jobs.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center" style={muted}>
          No jobs yet. A job runs one of the app&apos;s server functions on a
          schedule.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {jobs.map((j) => (
            <li key={j.id}>
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                <button
                  onClick={() => setOpen(open === j.id ? null : j.id)}
                  aria-expanded={open === j.id}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="font-medium">{j.name}</span>{" "}
                  <span style={muted}>→ {j.fn}</span>
                  <span className="block" style={muted}>
                    {j.description} ({j.timezone})
                    {j.enabled && j.nextRunAt
                      ? ` · next ${new Date(j.nextRunAt).toLocaleString()}`
                      : ""}
                    {j.lastRunAt
                      ? ` · last ${new Date(j.lastRunAt).toLocaleString()} (${j.lastStatus})`
                      : ""}
                  </span>
                  <span className="block" style={muted}>
                    30 days: {j.runs30d} run{j.runs30d === 1 ? "" : "s"}
                    {j.failed30d ? `, ${j.failed30d} failed` : ""}, {j.seconds30d} s of
                    run time
                  </span>
                </button>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={j.enabled}
                    onChange={(e) =>
                      void run(
                        { action: "updateJob", jobId: j.id, enabled: e.target.checked },
                        e.target.checked ? `${j.name} is on.` : `${j.name} is paused.`,
                      )
                    }
                  />
                  On
                </label>
                <button
                  onClick={() => void run({ action: "runJob", jobId: j.id }, `Ran ${j.name}.`)}
                  className="rounded-md border px-2 py-0.5"
                >
                  <Play className="inline h-3 w-3" /> Run now
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete the job ${j.name}?`))
                      void run({ action: "deleteJob", jobId: j.id }, `Deleted ${j.name}.`);
                  }}
                  aria-label={`Delete ${j.name}`}
                  className="rounded-md border px-2 py-0.5 text-red-500"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
              {open === j.id && (
                <div className="border-t px-3 py-2">
                  {!runs ? null : runs.length === 0 ? (
                    <p style={muted}>No runs yet.</p>
                  ) : (
                    <ul className="max-h-60 space-y-1 overflow-auto">
                      {runs.map((r, i) => (
                        <li key={i}>
                          <span className={r.status >= 400 ? "text-red-500" : "text-emerald-600"}>
                            {r.status}
                          </span>{" "}
                          <span style={muted}>
                            {new Date(r.at).toLocaleString()} · {r.ms} ms
                          </span>
                          {r.error && <span className="text-red-500"> · {r.error.slice(0, 200)}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          void run({ action: "createJob", ...form }, `Job ${form.name} scheduled.`).then((d) => {
            if (d) setForm((f) => ({ ...f, name: "" }));
          });
        }}
      >
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Job name"
          aria-label="Job name"
          className={input}
          required
        />
        <select
          value={form.fn}
          onChange={(e) => setForm({ ...form, fn: e.target.value })}
          aria-label="Function"
          className={input}
          required
        >
          <option value="">Function…</option>
          {fns.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <input
          value={form.schedule}
          onChange={(e) => setForm({ ...form, schedule: e.target.value })}
          placeholder="Cron, e.g. 0 9 * * 1-5"
          aria-label="Schedule (cron)"
          className={`${input} font-mono`}
          required
        />
        <input
          value={form.timezone}
          onChange={(e) => setForm({ ...form, timezone: e.target.value })}
          aria-label="Time zone"
          className={input}
        />
        <button type="submit" className="rounded-md border px-2.5 py-1">
          Add job
        </button>
      </form>
    </div>
  );
}

type PolicyTable = {
  name: string;
  columns: { name: string }[];
  policy: { read: string; write: string };
};
type PolicyRow = { name: string; cmd: string; role: string; using: string | null; tone: "ok" | "warn" | "danger" };

const WHO: Record<string, string> = {
  public: "Everyone",
  authenticated: "Signed-in users",
  owner: "Signed-in users",
};

function policyRows(kind: "read" | "write", access: string, noun: string): PolicyRow {
  const cmd = kind === "read" ? "SELECT" : "INSERT, UPDATE, DELETE";
  const verb = kind === "read" ? "read" : "add, change and delete";
  if (access === "owner")
    return { name: `Owners ${verb} their own ${noun}`, cmd, role: WHO.owner, using: "user_id = the signed-in user", tone: "ok" };
  if (access === "authenticated")
    return { name: `Signed-in users ${verb} all ${noun}`, cmd, role: WHO.authenticated, using: null, tone: kind === "write" ? "warn" : "ok" };
  return {
    name: `Anyone can ${verb} ${noun}`,
    cmd,
    role: WHO.public,
    using: null,
    tone: kind === "write" ? "danger" : "warn",
  };
}

function PolicyGroup({ title, rows, note }: { title: string; rows: PolicyRow[]; note?: { tone: "warn" | "danger"; text: string } | null }) {
  return (
    <div className="rounded-lg border">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="flex items-center gap-2 font-medium">
          {title}
          <span
            className="rounded-full px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-400"
            style={{ background: "rgba(16,185,129,.12)" }}
            title="Access rules are always enforced: only what a rule allows gets through."
          >
            Rules enforced
          </span>
        </span>
        <span style={muted}>
          {rows.length} {rows.length === 1 ? "Policy" : "Policies"}
        </span>
      </div>
      {note && (
        <p className={`px-3 pt-2 ${note.tone === "danger" ? "text-red-500" : "text-amber-600"}`}>{note.text}</p>
      )}
      <table className="w-full text-left">
        <thead style={muted}>
          <tr>
            <th className="px-3 py-1.5 font-normal">Policy</th>
            <th className="px-3 py-1.5 font-normal">Command</th>
            <th className="px-3 py-1.5 font-normal">Applies to</th>
            <th className="px-3 py-1.5 font-normal">Rule expression</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-t">
              <td className={`px-3 py-1.5 ${r.tone === "danger" ? "text-red-500" : r.tone === "warn" ? "text-amber-600" : ""}`}>{r.name}</td>
              <td className="px-3 py-1.5 font-mono text-[11px]">{r.cmd}</td>
              <td className="px-3 py-1.5">{r.role}</td>
              <td className="px-3 py-1.5">
                {r.using ? (
                  <span title="USING filters which rows are visible or editable.">
                    <span className="mr-1 rounded border px-1 text-[10px]">Using</span>
                    <span className="font-mono text-[11px]">{r.using}</span>
                  </span>
                ) : (
                  <span style={muted}>No expression (every row)</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Policies: every table's and bucket's access rules, in plain language. */
export function PoliciesSection({ projectId, tables }: { projectId: string; tables: PolicyTable[] }) {
  const { get } = useAdmin(projectId);
  const [buckets, setBuckets] = useState<{ name: string; access: string }[]>([]);
  useEffect(() => {
    get("view=storage").then(
      (d) => setBuckets(d.buckets),
      () => undefined,
    );
  }, [get]);
  const open = tables.filter((t) => t.policy.write === "public").length;

  return (
    <div className="space-y-4 text-xs">
      <p style={muted}>
        Who can read and change data through the app. Change a table&apos;s rules on the Overview, or ask the agent
        (&ldquo;only let people see their own tasks&rdquo;).
        {open > 0 && (
          <span className="text-red-500">
            {" "}
            {open} table{open === 1 ? "" : "s"} can be changed by anyone, without signing in.
          </span>
        )}
      </p>
      <h3 className="text-sm font-semibold">Tables</h3>
      {tables.length === 0 ? (
        <p style={muted}>No tables yet.</p>
      ) : (
        tables.map((t) => {
          const owned = t.columns.some((c) => c.name === "user_id");
          const note =
            t.policy.write === "public"
              ? { tone: "danger" as const, text: "All rows exposed: anyone with the app's address can add, change and delete rows." }
              : owned && t.policy.read === "public"
                ? { tone: "warn" as const, text: "Rows belong to users, but everyone can read all of them." }
                : null;
          return (
            <PolicyGroup
              key={t.name}
              title={t.name}
              note={note}
              rows={[policyRows("read", t.policy.read, "rows"), policyRows("write", t.policy.write, "rows")]}
            />
          );
        })
      )}
      <h3 className="text-sm font-semibold">Storage</h3>
      {buckets.map((b) => (
        <PolicyGroup
          key={b.name}
          title={b.name}
          rows={[
            b.access === "owner"
              ? { name: "Uploaders read their own files", cmd: "SELECT", role: "Signed-in users", using: "owner = the signed-in user", tone: "ok" }
              : policyRows("read", b.access, "files"),
            { name: "Signed-in users upload; uploaders change and delete their own files", cmd: "INSERT, UPDATE, DELETE", role: "Signed-in users", using: "owner = the signed-in user", tone: "ok" },
          ]}
        />
      ))}
    </div>
  );
}

type AiRunRow = {
  at: string;
  model: string;
  status: number;
  ms: number;
  input_tokens: number;
  output_tokens: number;
  credits: number;
  error: string | null;
  request: string | null;
  response: string | null;
};

/** AI: the app's AI calls, credits this month, body logging and a monthly limit. */
export function AiSection({ projectId }: { projectId: string }) {
  const { get, post } = useAdmin(projectId);
  const [runs, setRuns] = useState<AiRunRow[] | null>(null);
  const [settings, setSettings] = useState<{
    ai: { enabled: boolean; logBodies: boolean; creditLimit: number | null };
    aiUsage: { credits: number; calls: number };
  } | null>(null);
  const [limit, setLimit] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    get(`view=aiRuns${errorsOnly ? "&errors=1" : ""}`).then(
      (d) => setRuns(d.runs),
      (e) => setError(e.message),
    );
    get("view=settings").then((d) => {
      setSettings(d);
      setLimit(d.ai.creditLimit ? String(d.ai.creditLimit) : "");
    }, (e) => setError(e.message));
  }, [get, errorsOnly]);
  useEffect(load, [load]);

  async function save(body: Record<string, unknown>, msg: string) {
    setError("");
    setNote("");
    try {
      await post({ action: "setAi", ...body });
      setNote(msg);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-3 text-xs">
      {settings && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-3 py-2">
          <span>
            <span className="font-medium">{settings.aiUsage.credits}</span> credits ·{" "}
            <span className="font-medium">{settings.aiUsage.calls}</span> calls this month
            {settings.ai.creditLimit ? ` (limit ${settings.ai.creditLimit})` : ""}
          </span>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={settings.ai.logBodies}
              onChange={(e) =>
                void save(
                  { logBodies: e.target.checked },
                  e.target.checked ? "Prompts and answers will be kept with each call." : "Prompts and answers are no longer kept.",
                )
              }
            />
            Log request and response bodies
          </label>
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              void save({ creditLimit: limit ? Number(limit) : null }, limit ? `Monthly AI limit set to ${limit} credits.` : "Monthly AI limit removed.");
            }}
          >
            <input
              value={limit}
              onChange={(e) => setLimit(e.target.value.replace(/\D/g, ""))}
              placeholder="No limit"
              aria-label="Monthly AI credit limit"
              className={`${input} w-20`}
            />
            <button type="submit" className="rounded-md border px-2 py-0.5">
              Set monthly limit
            </button>
          </form>
        </div>
      )}
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
        Errors only
      </label>
      {note && (
        <p className="text-emerald-600" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="text-red-500" role="alert">
          {error}
        </p>
      )}
      {!runs ? null : runs.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center" style={muted}>
          No AI calls yet. Calls the app makes with cloud.ai show up here.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {runs.map((r, i) => (
            <li key={i}>
              <button
                onClick={() => setOpen(open === i ? null : i)}
                aria-expanded={open === i}
                className="flex w-full flex-wrap items-center gap-x-3 px-3 py-1.5 text-left"
              >
                <span className={r.status >= 400 ? "text-red-500" : "text-emerald-600"}>{r.status}</span>
                <span>{new Date(r.at).toLocaleString()}</span>
                <span style={muted}>
                  {r.model} · {r.input_tokens} in / {r.output_tokens} out · {r.credits} credit{r.credits === 1 ? "" : "s"} · {r.ms} ms
                </span>
                {r.error && <span className="text-red-500">{r.error.slice(0, 120)}</span>}
              </button>
              {open === i && (
                <div className="space-y-1 border-t px-3 py-2">
                  {r.request === null ? (
                    <p style={muted}>Bodies weren&apos;t logged for this call. Turn on &ldquo;Log request and response bodies&rdquo; to keep them.</p>
                  ) : (
                    <>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border p-2 font-mono text-[11px]">{r.request}</pre>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border p-2 font-mono text-[11px]">{r.response}</pre>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Settings: how the app's users sign in, and turning Cloud off. */
export function CloudSettingsSection({ projectId, onDisabled }: { projectId: string; onDisabled: () => void }) {
  const { get, post } = useAdmin(projectId);
  const brand = useBrand();
  const [auth, setAuth] = useState<{ password: boolean; emailCode: boolean; forge: boolean; google: boolean; signups: boolean; allowedDomains: string[] } | null>(null);
  const [domains, setDomains] = useState("");
  const [projectName, setProjectName] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    get("view=settings").then((d) => {
      setAuth(d.auth);
      setDomains(d.auth.allowedDomains.join(", "));
      setProjectName(d.projectName);
    }, (e) => setError(e.message));
  }, [get]);
  useEffect(load, [load]);

  async function saveAuth(patch: Record<string, unknown>, msg: string) {
    setError("");
    setNote("");
    try {
      const d = await post({ action: "setAuth", auth: patch });
      setAuth(d.auth);
      setDomains(d.auth.allowedDomains.join(", "));
      setNote(msg);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-5 text-xs">
      {note && (
        <p className="text-emerald-600" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="text-red-500" role="alert">
          {error}
        </p>
      )}
      {auth && (
        <section className="space-y-2 rounded-lg border p-3" aria-label="Sign-in">
          <h3 className="text-sm font-semibold">Sign-in for your app&apos;s users</h3>
          {(
            [
              ["password", "Email and password"],
              ["emailCode", "Email code (a six-digit code sent by email)"],
              ["forge", `Continue with ${brand.name} (people sign in with their ${brand.name} account)`],
              ["google", "Continue with Google (any Google or Google Workspace account)"],
              ["signups", "Anyone can create an account"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={auth[k]}
                onChange={(e) => void saveAuth({ [k]: e.target.checked }, `${label}: ${e.target.checked ? "on" : "off"}.`)}
              />
              {label}
            </label>
          ))}
          <form
            className="flex flex-wrap items-center gap-2 pt-1"
            onSubmit={(e) => {
              e.preventDefault();
              const list = domains.split(/[\s,]+/).filter(Boolean);
              void saveAuth(
                { allowedDomains: list },
                list.length ? `Only ${list.map((d) => "@" + d.replace(/^@/, "")).join(", ")} addresses can sign in now.` : "Any email address can sign in.",
              );
            }}
          >
            <span>Limit sign-in to these email domains:</span>
            <input
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              placeholder="Any domain (e.g. yourcompany.com)"
              aria-label="Allowed email domains"
              className={`${input} min-w-[220px] flex-1`}
            />
            <button type="submit" className="rounded-md border px-2 py-0.5">
              Save
            </button>
          </form>
          <p style={muted}>
            Email codes go out through the app&apos;s email (a RESEND_API_KEY secret), or wait in the Cloud outbox until
            one is added. The app calls cloud.auth.sendCode(email) and cloud.auth.verifyCode(email, code).
          </p>
        </section>
      )}
      <DatabaseEngineCard projectId={projectId} />
      <section className="space-y-2 rounded-lg border border-red-500/40 p-3" aria-label="Disable Cloud">
        <h3 className="text-sm font-semibold text-red-500">Disable Cloud</h3>
        <p style={muted}>
          Deletes this app&apos;s database, its users, stored files, server functions and jobs. Backups kept in the
          Cloud folder go too, so export the database first if you need it. This can&apos;t be undone.
        </p>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            try {
              await post({ action: "disableCloud", confirm: confirmText });
              onDisabled();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={projectName ? `Type ${projectName} to confirm` : "Type the project name"}
            aria-label="Type the project name to confirm"
            className={`${input} min-w-[220px] flex-1`}
          />
          <button
            type="submit"
            disabled={!projectName || confirmText.trim() !== projectName.trim()}
            className="rounded-md bg-red-600 px-2.5 py-1 font-medium text-white disabled:opacity-40"
          >
            Disable and delete
          </button>
        </form>
      </section>
    </div>
  );
}

type UsageDay = { day: string; requests: number; errors: number; aiCalls: number; aiCredits: number; functionCalls: number; functionSeconds: number; emails: number };

/** Usage: the app's backend activity per day over 30 days, and current sizes. */
export function UsageSection({ projectId }: { projectId: string }) {
  const { get } = useAdmin(projectId);
  const [u, setU] = useState<{ days: UsageDay[]; databaseBytes: number; liveDatabaseBytes: number | null; storage: { bytes: number; files: number } } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    get("view=usage").then(setU, (e) => setError(e.message));
  }, [get]);
  if (error)
    return (
      <p className="text-xs text-red-500" role="alert">
        {error}
      </p>
    );
  if (!u) return null;
  const sum = (k: keyof UsageDay) => u.days.reduce((n, d) => n + Number(d[k]), 0);
  const max = Math.max(1, ...u.days.map((d) => d.requests));
  const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  const tiles: [string, string][] = [
    ["Requests", `${sum("requests")}${sum("errors") ? ` (${sum("errors")} errors)` : ""}`],
    ["AI calls", `${sum("aiCalls")} · ${sum("aiCredits")} credits`],
    ["Function calls", `${sum("functionCalls")} · ${sum("functionSeconds")} s`],
    ["Emails", String(sum("emails"))],
    ["Database", u.liveDatabaseBytes !== null ? `Test ${kb(u.databaseBytes)} · Live ${kb(u.liveDatabaseBytes)}` : kb(u.databaseBytes)],
    ["Storage", `${kb(u.storage.bytes)} · ${u.storage.files} files`],
  ];
  return (
    <div className="space-y-3 text-xs">
      <p style={muted}>Last 30 days.</p>
      <div className="grid gap-2 sm:grid-cols-3">
        {tiles.map(([k, v]) => (
          <div key={k} className="rounded-lg border px-3 py-2">
            <p style={muted}>{k}</p>
            <p className="text-sm font-medium tabular-nums">{v}</p>
          </div>
        ))}
      </div>
      <div className="rounded-lg border p-3">
        <p className="mb-2" style={muted}>
          Requests per day
        </p>
        <div className="flex h-24 items-end gap-0.5" role="img" aria-label={`Requests per day: ${u.days.map((d) => d.requests).join(", ")}`}>
          {u.days.map((d) => (
            <span
              key={d.day}
              title={`${d.day}: ${d.requests} requests${d.errors ? `, ${d.errors} errors` : ""}`}
              className="flex-1 rounded-sm"
              style={{ height: `${Math.max(3, (d.requests / max) * 100)}%`, background: d.errors ? "rgb(239 68 68 / .7)" : d.requests ? "var(--accent)" : "rgba(127,127,127,.2)" }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

type WfRun = { id: string; workflow: string; status: string; waiting: { type: string; event?: string; until?: string; message?: string } | null; error: string | null; created_at: string; updated_at: string };
type WfDetail = WfRun & { input: unknown; steps: { id: string; status: string; output: unknown; error: string | null; startedAt: string; finishedAt: string | null }[] };

/** Workflows: definitions in workflows/, runs step by step, approvals, events, retry, cancel. */
export function WorkflowsSection({ projectId }: { projectId: string }) {
  const { get, post } = useAdmin(projectId);
  const [data, setData] = useState<{ workflows: { name: string; steps: { id: string; type: string }[] }[]; runs: WfRun[] } | null>(null);
  const [open, setOpen] = useState<WfDetail | null>(null);
  const [startName, setStartName] = useState("");
  const [startInput, setStartInput] = useState("{}");
  const [eventData, setEventData] = useState("{}");
  const [error, setError] = useState("");
  const load = useCallback(() => {
    get("view=workflows").then(setData, (e) => setError(e.message));
  }, [get]);
  useEffect(load, [load]);
  const openRun = useCallback((id: string) => get(`view=run&run=${id}`).then(setOpen, (e) => setError(e.message)), [get]);

  async function act(body: Record<string, unknown>) {
    setError("");
    try {
      const d = await post(body);
      load();
      if (open) setTimeout(() => void openRun(open.id), 400);
      return d;
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const color = (s: string) =>
    s === "completed" || s === "approved" ? "text-emerald-600" : s === "failed" || s === "rejected" ? "text-red-500" : s === "waiting" ? "text-amber-600" : "";

  return (
    <div className="space-y-3 text-xs">
      {error && (
        <p className="text-red-500" role="alert">
          {error}
        </p>
      )}
      {data && data.workflows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center" style={muted}>
          No workflows yet. Ask the agent for a process that waits on people or events, like “refunds over $100 need a
          manager to approve them”.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {data?.workflows.map((w) => (
            <li key={w.name} className="flex items-center gap-2 px-3 py-2">
              <span className="font-medium">{w.name}</span>
              <span className="flex-1 truncate" style={muted}>
                {w.steps.map((s) => `${s.id} (${s.type})`).join(" → ")}
              </span>
              <button onClick={() => setStartName(w.name)} className="rounded-md border px-2 py-0.5">
                Start a run
              </button>
            </li>
          ))}
        </ul>
      )}
      {startName && (
        <form
          className="flex flex-wrap items-center gap-2 rounded-lg border p-2"
          onSubmit={async (e) => {
            e.preventDefault();
            let value: unknown;
            try {
              value = JSON.parse(startInput || "{}");
            } catch {
              return setError("The input must be JSON.");
            }
            const d = await act({ action: "startRun", workflow: startName, input: value });
            if (d?.id) {
              setStartName("");
              void openRun(d.id);
            }
          }}
        >
          <span>Input for {startName}</span>
          <input value={startInput} onChange={(e) => setStartInput(e.target.value)} aria-label="Run input (JSON)" className={`${input} min-w-[200px] flex-1 font-mono`} />
          <button className="rounded-md border px-2 py-0.5">Start</button>
        </form>
      )}
      <ul className="divide-y rounded-lg border">
        {data?.runs.length === 0 && (
          <li className="px-3 py-2" style={muted}>
            No runs yet.
          </li>
        )}
        {data?.runs.map((r) => (
          <li key={r.id}>
            <button onClick={() => void openRun(r.id)} className="flex w-full flex-wrap gap-x-3 px-3 py-1.5 text-left">
              <span className={color(r.status)}>{r.status}</span>
              <span className="font-medium">{r.workflow}</span>
              <span style={muted}>
                {r.waiting ? `waiting for ${r.waiting.type === "event" ? `“${r.waiting.event}”` : r.waiting.type}` : (r.error ?? "")} ·{" "}
                {new Date(r.created_at).toLocaleString()}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <div className="space-y-2 rounded-lg border p-3">
          <p>
            <span className="font-medium">{open.workflow}</span> <span className={color(open.status)}>{open.status}</span>{" "}
            <span style={muted}>run {open.id.slice(0, 8)}</span>
          </p>
          <ol className="space-y-1">
            {open.steps.map((s) => (
              <li key={s.id}>
                <span className={color(s.status)}>{s.status}</span> <span className="font-medium">{s.id}</span>
                {s.error && <span className="text-red-500"> · {s.error}</span>}
                {s.output !== null && (
                  <code className="ml-1 break-all" style={muted}>
                    {JSON.stringify(s.output).slice(0, 200)}
                  </code>
                )}
              </li>
            ))}
          </ol>
          {open.waiting?.type === "approval" && (
            <div className="flex items-center gap-2">
              <span>{open.waiting.message ?? "Waiting for approval."}</span>
              <button onClick={() => void act({ action: "rejectRun", runId: open.id })} className="rounded-md border px-2 py-0.5">
                Reject
              </button>
              <button
                onClick={() => void act({ action: "approveRun", runId: open.id })}
                className="rounded-md px-2 py-0.5 font-medium text-white"
                style={{ background: "var(--accent)" }}
              >
                Approve
              </button>
            </div>
          )}
          {open.waiting?.type === "event" && (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                let d: unknown;
                try {
                  d = JSON.parse(eventData || "null");
                } catch {
                  return setError("Event data must be JSON.");
                }
                void act({ action: "sendEvent", runId: open.id, event: open.waiting!.event, data: d });
              }}
            >
              <span>Waiting for “{open.waiting.event}”</span>
              <input value={eventData} onChange={(e) => setEventData(e.target.value)} aria-label="Event data (JSON)" className={`${input} font-mono`} />
              <button className="rounded-md border px-2 py-0.5">Send event</button>
            </form>
          )}
          <div className="flex gap-2">
            {open.status === "failed" && (
              <button onClick={() => void act({ action: "retryRun", runId: open.id })} className="rounded-md border px-2 py-0.5">
                Retry
              </button>
            )}
            {(open.status === "running" || open.status === "waiting") && (
              <button onClick={() => void act({ action: "cancelRun", runId: open.id })} className="rounded-md border px-2 py-0.5 text-red-500">
                Cancel run
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Which database engine the app uses, and (SQLite apps, workspace admins) moving it to PostgreSQL. */
function DatabaseEngineCard({ projectId }: { projectId: string }) {
  const { get, post } = useAdmin(projectId);
  const [engine, setEngine] = useState<"sqlite" | "postgres" | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    get("view=settings").then((d) => setEngine(d.engine ?? "sqlite"), () => undefined);
  }, [get]);
  if (!engine) return null;
  return (
    <section className="space-y-2 rounded-lg border p-3" aria-label="Database engine">
      <h3 className="text-sm font-semibold">Database engine: {engine === "postgres" ? "PostgreSQL" : "SQLite"}</h3>
      {engine === "sqlite" ? (
        <>
          <p style={muted}>
            Move this app&apos;s data (Test and Live) to its own PostgreSQL database. Every table is copied and its rows
            counted; the SQLite files are kept as backups. The app pauses for a few seconds while it runs.
          </p>
          <button
            type="button"
            disabled={busy}
            className="rounded-md border px-2.5 py-1 font-medium disabled:opacity-40"
            onClick={async () => {
              if (!confirm("Move this app's database to PostgreSQL? This can't be switched back from here.")) return;
              setBusy(true);
              setError("");
              try {
                const r = await post({ action: "moveToPostgres" });
                const tables = (r.environments as { env: string; tables: { table: string; sqlite: number; postgres: number }[] }[])
                  .map((e) => `${e.env}: ${e.tables.length} tables, ${e.tables.reduce((n, t) => n + t.postgres, 0)} rows`)
                  .join("; ");
                setResult(`Moved and checked (${tables}).${r.warnings.length ? ` Notes: ${r.warnings.join(" ")}` : ""}`);
                setEngine("postgres");
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Moving…" : "Move to PostgreSQL"}
          </button>
        </>
      ) : (
        <p style={muted}>This app has its own PostgreSQL database and database login. Migrations are written in PostgreSQL.</p>
      )}
      {result && <p className="text-emerald-600" role="status">{result}</p>}
      {error && <p className="text-red-500" role="alert">{error}</p>}
    </section>
  );
}
