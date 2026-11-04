"use client";

import { useId, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { checkRecipient, formatRecipient, parseRecipients, type Recipient } from "@/lib/mail/compose";

export type Contact = { name: string | null; address: string; member?: boolean };

/**
 * To, Cc or Bcc as Gmail does it: what's typed becomes a chip on space
 * (once it looks like an address), comma, semicolon, Enter, Tab or leaving
 * the field; pasted lists become several chips; bad addresses turn red with
 * a "did you mean" tooltip; and people from the mailbox's mail and the
 * workspace are suggested as you type.
 */
export default function RecipientField({
  label,
  value,
  onChange,
  contacts,
  domains,
  autoFocus,
  trailing,
}: {
  label: string;
  value: Recipient[];
  onChange: (v: Recipient[]) => void;
  contacts: Contact[];
  domains: string[];
  autoFocus?: boolean;
  trailing?: React.ReactNode;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const chosen = useMemo(() => new Set(value.map((r) => r.address.toLowerCase())), [value]);
  const byAddress = useMemo(() => new Map(contacts.map((c) => [c.address.toLowerCase(), c])), [contacts]);
  const q = text.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return [];
    const words = q.split(/\s+/);
    return contacts
      .filter((c) => !chosen.has(c.address))
      .filter((c) => {
        const hay = `${c.name ?? ""} ${c.address}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => Number(b.address.startsWith(q) || !!b.name?.toLowerCase().startsWith(q)) - Number(a.address.startsWith(q) || !!a.name?.toLowerCase().startsWith(q)))
      .slice(0, 8);
  }, [q, contacts, chosen]);
  // A finished address only picks a suggestion that is exactly it.
  const typedFull = q.includes("@") && q.split("@")[1]?.includes(".");
  const pick = open && matches.length ? (typedFull ? matches.findIndex((m) => m.address === q) : Math.min(hi, matches.length - 1)) : -1;

  const add = (rs: Recipient[]) => {
    const seen = new Set(chosen);
    const next = [...value];
    for (const r of rs) {
      const key = r.address.toLowerCase();
      if (!r.address || seen.has(key)) continue;
      seen.add(key);
      next.push({ name: r.name ?? byAddress.get(key)?.name ?? null, address: r.address });
    }
    onChange(next);
  };

  const commit = (raw = text) => {
    if (raw.trim()) add(parseRecipients(raw));
    setText("");
    setOpen(false);
    setHi(0);
  };

  const choose = (c: Contact) => {
    add([{ name: c.name, address: c.address }]);
    setText("");
    setOpen(false);
    setHi(0);
    input.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && matches.length) {
      e.preventDefault();
      setOpen(true);
      setHi((pick + 1) % matches.length);
    } else if (e.key === "ArrowUp" && matches.length) {
      e.preventDefault();
      setOpen(true);
      setHi((pick - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (!text.trim()) return;
      if (e.key === "Enter") e.preventDefault();
      if (pick >= 0) {
        if (e.key === "Tab") e.preventDefault();
        choose(matches[pick]);
      } else commit();
    } else if (e.key === "," || e.key === ";") {
      e.preventDefault();
      commit();
    } else if (e.key === " ") {
      // A space ends an address, but not a name being searched or a quoted name.
      const quotes = (text.match(/"/g) ?? []).length % 2 === 1;
      const angle = text.lastIndexOf("<") > text.lastIndexOf(">");
      if (text.includes("@") && !quotes && !angle) {
        e.preventDefault();
        commit();
      }
    } else if (e.key === "Backspace" && !text && value.length) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text/plain");
    if (/[,;\n]/.test(pasted) || (pasted.match(/@/g) ?? []).length > 1 || /<[^>]+@[^>]+>/.test(pasted)) {
      e.preventDefault();
      commit(text + pasted);
    }
  };

  const edit = (i: number) => {
    const r = value[i];
    const rest = value.filter((_, j) => j !== i);
    if (text.trim()) {
      const extra = parseRecipients(text).filter((x) => !rest.some((y) => y.address === x.address));
      onChange([...rest, ...extra]);
    } else onChange(rest);
    setText(r.name ? formatRecipient(r).replace(/^"([^"]*)"/, "$1") : r.address);
    setOpen(false);
    requestAnimationFrame(() => input.current?.focus());
  };

  return (
    <div className="relative flex items-start gap-2 border-b py-1.5 text-sm" style={{ borderColor: "var(--ix-line)" }}>
      <span className="w-14 flex-none pt-0.5" style={{ color: "var(--ix-muted)" }} id={`${listId}-l`}>{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" onClick={(e) => e.target === e.currentTarget && input.current?.focus()}>
        {value.map((r, i) => {
          const c = checkRecipient(r, domains);
          const name = r.name ?? byAddress.get(r.address.toLowerCase())?.name ?? null;
          const tip = c.ok ? (name ? `${name} <${r.address}>` : r.address) : `This address isn't valid${c.suggestion ? `; did you mean ${c.suggestion}?` : `: it ${c.reason}.`}`;
          return (
            <span
              key={`${r.address}-${i}`}
              className={`mail-chip ${c.ok ? "" : "mail-chip-bad"}`}
              title={tip}
              data-valid={c.ok ? "true" : "false"}
              role="button"
              tabIndex={-1}
              aria-label={`${c.ok ? "" : "Invalid address: "}${name ? `${name}, ` : ""}${r.address}. Click to edit.`}
              onClick={() => edit(i)}
            >
              <span className="min-w-0 truncate">
                {name ? (
                  <>
                    {name} <span style={{ color: c.ok ? "var(--ix-muted)" : undefined }}>&lt;{r.address}&gt;</span>
                  </>
                ) : (
                  r.address
                )}
              </span>
              <button
                type="button"
                className="mail-chip-x"
                aria-label={`Remove ${r.address}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(value.filter((_, j) => j !== i));
                }}
              >
                <X size={12} />
              </button>
            </span>
          );
        })}
        <input
          ref={input}
          aria-labelledby={`${listId}-l`}
          role="combobox"
          aria-expanded={open && matches.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={pick >= 0 ? `${listId}-${pick}` : undefined}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          className="min-w-[8rem] flex-1 bg-transparent py-0.5 outline-none"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setHi(0);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => commit()}
        />
      </div>
      {trailing}
      {open && matches.length > 0 && (
        <ul id={listId} role="listbox" className="mail-menu left-16 top-full mt-1 max-h-72 w-[min(420px,calc(100%-4rem))] overflow-y-auto">
          {matches.map((m, i) => (
            <li
              key={m.address}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === pick}
              className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5"
              style={i === pick ? { background: "var(--ix-hover)" } : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHi(i)}
              onClick={() => choose(m)}
            >
              <span className="grid h-7 w-7 flex-none place-items-center rounded-full text-xs font-semibold text-white" style={{ background: "var(--accent)" }}>
                {(m.name ?? m.address).trim()[0]?.toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm">{m.name ?? m.address}</span>
                {m.name && <span className="block truncate text-xs" style={{ color: "var(--ix-muted)" }}>{m.address}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
