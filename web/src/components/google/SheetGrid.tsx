"use client";

import { useEffect, useState } from "react";

type Data = { tabs: string[]; range: string; values: string[][] };

const colIndex = (letters: string) => letters.split("").reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

/** Where a returned range starts: its tab and the 0-based row/column of its first cell. */
function origin(range: string) {
  const bang = range.lastIndexOf("!");
  const tab = (bang >= 0 ? range.slice(0, bang) : range).replace(/^'|'$/g, "").replace(/''/g, "'");
  const m = range.slice(bang + 1).match(/^([A-Z]+)(\d+)/);
  return { tab, col: m ? colIndex(m[1]) : 0, row: m ? Number(m[2]) - 1 : 0 };
}

/**
 * A Google Sheet's values, editable in place: click a cell to change it
 * (Enter or leaving the cell saves, Esc cancels), add a row at the end,
 * delete a row, or add a tab. Every change goes straight to Google.
 */
export default function SheetGrid({
  fileId,
  data,
  editable,
  onReload,
  onError,
}: {
  fileId: string;
  data: Data;
  editable: boolean;
  onReload: (range?: string) => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const [values, setValues] = useState<string[][]>(data.values);
  const [edit, setEdit] = useState<{ r: number; c: number; v: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [newRow, setNewRow] = useState<string[] | null>(null);
  const [confirmRow, setConfirmRow] = useState<number | null>(null);
  const [newTab, setNewTab] = useState<string | null>(null);
  useEffect(() => setValues(data.values), [data.values]);

  const o = origin(data.range);
  const width = Math.max(1, ...values.map((r) => r.length));

  async function post(body: Record<string, unknown>) {
    const r = await fetch("/api/google", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: fileId, tab: o.tab, ...body }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error ?? "Google didn't accept that change.");
  }

  async function saveCell() {
    if (!edit) return;
    const { r, c, v } = edit;
    setEdit(null);
    if ((values[r]?.[c] ?? "") === v) return;
    const before = values;
    setValues((cur) => cur.map((row, i) => (i === r ? Array.from({ length: Math.max(row.length, c + 1) }, (_, j) => (j === c ? v : row[j] ?? "")) : row)));
    setSaving(`${r}:${c}`);
    try {
      await post({ action: "setCell", row: o.row + r, col: o.col + c, value: v });
    } catch (e) {
      setValues(before);
      onError((e as Error).message);
    }
    setSaving(null);
  }

  async function run(key: string, body: Record<string, unknown>, after?: () => void) {
    setSaving(key);
    try {
      await post(body);
      after?.();
      await onReload(data.range.includes("!") ? data.range.split("!")[0] : undefined);
    } catch (e) {
      onError((e as Error).message);
    }
    setSaving(null);
  }

  const cell = "border px-2 py-1 align-top";
  const line = { borderColor: "var(--ix-line)" };
  const btn = "rounded-lg border px-2.5 py-1 text-xs font-medium disabled:opacity-50";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-collapse text-sm">
          <tbody>
            {values.slice(0, 1000).map((row, r) => (
              <tr key={r} className={r === 0 ? "font-semibold" : ""} style={r === 0 ? { background: "var(--ix-hover)" } : undefined}>
                {Array.from({ length: width }, (_, c) => {
                  const editing = edit && edit.r === r && edit.c === c;
                  return (
                    <td
                      key={c}
                      className={`${cell} whitespace-nowrap ${editable ? "cursor-text" : ""}`}
                      style={{ ...line, outline: saving === `${r}:${c}` ? "2px solid var(--accent)" : undefined, padding: editing ? 0 : undefined }}
                      onClick={() => editable && !editing && setEdit({ r, c, v: row[c] ?? "" })}
                    >
                      {editing ? (
                        <input
                          autoFocus
                          aria-label={`Cell ${r + 1}, ${c + 1}`}
                          className="w-full min-w-[120px] bg-transparent px-2 py-1 outline-none"
                          style={{ boxShadow: "inset 0 0 0 2px var(--accent)" }}
                          value={edit.v}
                          onChange={(e) => setEdit({ ...edit, v: e.target.value })}
                          onBlur={saveCell}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            if (e.key === "Escape") setEdit(null);
                          }}
                        />
                      ) : (
                        row[c] ?? ""
                      )}
                    </td>
                  );
                })}
                {editable && (
                  <td className={`${cell} w-10 text-center`} style={line}>
                    {r > 0 && (
                      <button
                        type="button"
                        title="Delete this row"
                        aria-label={`Delete row ${r + 1}`}
                        disabled={!!saving}
                        className={`rounded px-1.5 text-xs ${confirmRow === r ? "bg-red-600 text-white" : "text-red-500"}`}
                        onClick={() => {
                          if (confirmRow !== r) return setConfirmRow(r);
                          setConfirmRow(null);
                          void run(`row${r}`, { action: "deleteRow", row: o.row + r });
                        }}
                      >
                        {confirmRow === r ? "Delete?" : "×"}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {newRow && (
              <tr>
                {newRow.map((v, c) => (
                  <td key={c} className={cell} style={{ ...line, padding: 0 }}>
                    <input
                      aria-label={`New row, ${values[0]?.[c] || `column ${c + 1}`}`}
                      placeholder={values[0]?.[c] ?? ""}
                      className="w-full min-w-[120px] bg-transparent px-2 py-1 outline-none"
                      style={{ boxShadow: "inset 0 0 0 1px var(--accent)" }}
                      value={v}
                      autoFocus={c === 0}
                      onChange={(e) => setNewRow(newRow.map((x, i) => (i === c ? e.target.value : x)))}
                    />
                  </td>
                ))}
                <td className={cell} style={line} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {editable && (
        <div className="flex flex-wrap items-center gap-2 border-t p-2.5 text-sm" style={line}>
          {newRow ? (
            <>
              <button type="button" className={btn} style={{ background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }} disabled={!!saving} onClick={() => run("append", { action: "appendRow", values: newRow }, () => setNewRow(null))}>
                {saving === "append" ? "Saving…" : "Save row"}
              </button>
              <button type="button" className={btn} onClick={() => setNewRow(null)}>Cancel</button>
            </>
          ) : (
            <button type="button" className={btn} disabled={!!saving} onClick={() => setNewRow(Array.from({ length: width }, () => ""))}>
              + Add row
            </button>
          )}
          {newTab === null ? (
            <button type="button" className={btn} disabled={!!saving} onClick={() => setNewTab("")}>+ New tab</button>
          ) : (
            <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); void run("tab", { action: "addTab", name: newTab }, () => setNewTab(null)); }}>
              <input autoFocus aria-label="New tab name" className="rounded-lg border bg-transparent px-2 py-1 text-xs" placeholder="Tab name" value={newTab} onChange={(e) => setNewTab(e.target.value)} />
              <button className={btn} disabled={!!saving}>{saving === "tab" ? "Adding…" : "Add"}</button>
              <button type="button" className={btn} onClick={() => setNewTab(null)}>Cancel</button>
            </form>
          )}
          <span className="ml-auto text-xs" style={{ color: "var(--ix-muted)" }}>
            {saving ? "Saving to Google…" : "Click a cell to edit · Enter saves · Esc cancels"}
          </span>
        </div>
      )}
    </div>
  );
}
