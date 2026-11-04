"use client";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, BookA, LayoutTemplate, Pencil, Plus, Trash2 } from "lucide-react";
import { meetApi } from "./api";
import "./report.css";

/** Meet settings for reports: custom templates (name, instructions, sections) and custom vocabulary. */

type Section = { title: string; prompt: string };
type Template = { id: string; name: string; instructions: string; sections: Section[]; builtin: boolean; mine: boolean };
type Term = { id: string; term: string; note: string };

/** "Title: what to write" per line <-> sections. */
const toLines = (s: Section[]) => s.map((x) => (x.prompt ? `${x.title}: ${x.prompt}` : x.title)).join("\n");
const fromLines = (t: string) =>
  t.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(":");
    return i > 0 ? { title: l.slice(0, i).trim(), prompt: l.slice(i + 1).trim() } : { title: l, prompt: "" };
  });

export default function ReportSettings({ canEdit }: { canEdit: boolean }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [terms, setTerms] = useState<Term[]>([]);
  const [form, setForm] = useState<{ id?: string; name: string; instructions: string; sections: string } | null>(null);
  const [term, setTerm] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const [t, v] = await Promise.all([meetApi<{ templates: Template[] }>("/templates"), meetApi<{ terms: Term[] }>("/vocab")]).catch((e) => {
      setErr((e as Error).message);
      return [{ templates: [] as Template[] }, { terms: [] as Term[] }];
    });
    setTemplates(t.templates ?? []);
    setTerms(v.terms ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setErr("");
    try {
      const body = { id: form.id, name: form.name, instructions: form.instructions, sections: fromLines(form.sections) };
      await meetApi("/templates", { method: form.id ? "PATCH" : "POST", body });
      setForm(null);
      load();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  };
  const remove = async (id: string) => {
    await meetApi(`/templates?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch((e) => setErr((e as Error).message));
    load();
  };
  const addTerm = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    const many = term.includes(",") ? term.split(",").map((x) => x.trim()).filter(Boolean) : null;
    try {
      const d = await meetApi<{ terms: Term[] }>("/vocab", { body: many ? { terms: many } : { term, note } });
      setTerms(d.terms);
      setTerm("");
      setNote("");
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  };
  const dropTerm = async (id: string) => {
    await meetApi(`/vocab?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch((e) => setErr((e as Error).message));
    load();
  };

  return (
    <div style={{ height: "100%", overflow: "auto" }}>
      <div className="mt-notes">
        <a className="mt-btn sm" href="/workspace/meet" style={{ width: "fit-content" }}><ArrowLeft size={13} /> Meet</a>
        <h1 style={{ font: "400 30px var(--font-serif), Georgia, serif", margin: 0 }}>Report settings</h1>
        {err && <p className="mt-error">{err}</p>}

        <section className="mt-card">
          <div className="mt-actions" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}><LayoutTemplate size={15} style={{ verticalAlign: -2 }} /> Templates</h2>
            {canEdit && !form && <button className="mt-btn sm primary" onClick={() => setForm({ name: "", instructions: "", sections: "" })}><Plus size={13} /> New template</button>}
          </div>
          <p className="mt-note">Each report is written with a template: what kind of meeting it is and which sections to add. Pick one per meeting on its report (or before recording).</p>
          {form && (
            <form onSubmit={save} className="mt-card" style={{ display: "grid", gap: 8, margin: "8px 0" }}>
              <input className="mt-input" placeholder="Name, e.g. Customer onboarding" value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Template name" />
              <textarea className="mt-input" rows={2} placeholder="What kind of meeting this is, and what matters (optional)" value={form.instructions} maxLength={2000} onChange={(e) => setForm({ ...form, instructions: e.target.value })} aria-label="Instructions" />
              <textarea className="mt-input" rows={5} placeholder={"One section per line, \"Title: what to write\"\nGoals: what the customer wants to achieve\nRisks\nNext steps: with owners and dates"} value={form.sections} onChange={(e) => setForm({ ...form, sections: e.target.value })} aria-label="Sections" />
              <div className="mt-actions">
                <button className="mt-btn primary" disabled={!form.name.trim() || !form.sections.trim()}>{form.id ? "Save template" : "Add template"}</button>
                <button type="button" className="mt-btn" onClick={() => setForm(null)}>Cancel</button>
              </div>
            </form>
          )}
          <div className="mt-list">
            {templates.map((t) => (
              <div key={t.id} className="mt-row" style={{ alignItems: "flex-start" }}>
                <span className="t" style={{ flex: 1, minWidth: 0 }}>
                  <b>{t.name}</b> <span className="mt-note">{t.builtin ? "built in" : "custom"}</span>
                  <span className="mt-note" style={{ display: "block" }}>{t.sections.map((s) => s.title).join(" · ")}</span>
                </span>
                {t.mine && canEdit && (
                  <>
                    <button className="mt-iconbtn" aria-label={`Edit ${t.name}`} title="Edit" onClick={() => setForm({ id: t.id, name: t.name, instructions: t.instructions, sections: toLines(t.sections) })}><Pencil size={14} /></button>
                    <button className="mt-iconbtn" aria-label={`Delete ${t.name}`} title="Delete" onClick={() => remove(t.id)}><Trash2 size={14} /></button>
                  </>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="mt-card">
          <h2><BookA size={15} style={{ verticalAlign: -2 }} /> Custom vocabulary</h2>
          <p className="mt-note" style={{ marginTop: 0 }}>Names, products and jargon that transcripts and reports should spell right. Glossary articles in the company knowledge base are used too.</p>
          {canEdit && (
            <form className="mt-actions" onSubmit={addTerm} style={{ marginBottom: 10 }}>
              <input className="mt-input" style={{ flex: "1 1 180px" }} placeholder="Term (or several, separated by commas)" value={term} maxLength={2000} onChange={(e) => setTerm(e.target.value)} aria-label="Term" />
              <input className="mt-input" style={{ flex: "1 1 180px" }} placeholder="What it is (optional)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} aria-label="Note" disabled={term.includes(",")} />
              <button className="mt-btn primary" disabled={!term.trim()}><Plus size={14} /> Add</button>
            </form>
          )}
          {terms.length === 0 ? (
            <p className="mt-note">No terms yet.</p>
          ) : (
            <div className="mt-chips">
              {terms.map((t) => (
                <span key={t.id} className="mt-pill" title={t.note || undefined} style={{ color: "var(--ix-ink)" }}>
                  {t.term}
                  {canEdit && <button className="mt-iconbtn" style={{ width: 18, height: 18 }} aria-label={`Remove ${t.term}`} onClick={() => dropTerm(t.id)}><Trash2 size={11} /></button>}
                </span>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
