// Modal dialogs in the Google Sheets style (white card, title, body, buttons bottom-right).

export interface DialogButton {
  label: string;
  primary?: boolean;
  /** Return false to keep the dialog open. */
  run?: () => boolean | void | Promise<boolean | void>;
  id?: string;
}

export interface DialogOptions {
  title: string;
  body: HTMLElement | string;
  buttons?: DialogButton[];
  /** Called after the dialog closes (any way). */
  onClose?: () => void;
  testid?: string;
  /** No backdrop dimming and no modality (Find and replace stays usable next to the grid). */
  modeless?: boolean;
  width?: number;
}

export interface Dialog {
  el: HTMLDivElement;
  close(): void;
}

let layer: HTMLElement | null = null;
function host(): HTMLElement {
  layer ??= document.getElementById("dialogs") ?? document.body;
  return layer;
}

export function openDialog(o: DialogOptions): Dialog {
  const back = document.createElement("div");
  back.className = o.modeless ? "dialog-layer modeless" : "dialog-layer";
  const el = document.createElement("div");
  el.className = "dialog";
  el.setAttribute("role", "dialog");
  if (!o.modeless) el.setAttribute("aria-modal", "true");
  if (o.width) el.style.width = `${o.width}px`;
  if (o.testid) el.dataset.testid = o.testid;
  const head = document.createElement("div");
  head.className = "dialog-head";
  const h = document.createElement("h2");
  h.className = "dialog-title";
  h.id = `dlg-${Math.random().toString(36).slice(2)}`;
  h.textContent = o.title;
  el.setAttribute("aria-labelledby", h.id);
  const x = document.createElement("button");
  x.className = "dialog-x";
  x.setAttribute("aria-label", "Close");
  x.textContent = "✕";
  head.append(h, x);
  const body = document.createElement("div");
  body.className = "dialog-body";
  if (typeof o.body === "string") body.textContent = o.body;
  else body.append(o.body);
  el.append(head, body);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.remove();
    o.onClose?.();
  };
  if (o.buttons?.length) {
    const foot = document.createElement("div");
    foot.className = "dialog-foot";
    for (const b of o.buttons) {
      const btn = document.createElement("button");
      btn.className = b.primary ? "dlg-btn primary" : "dlg-btn";
      btn.textContent = b.label;
      if (b.id) btn.dataset.testid = b.id;
      btn.addEventListener("click", async () => {
        const keep = (await b.run?.()) === false;
        if (!keep) close();
      });
      foot.append(btn);
    }
    el.append(foot);
  }
  x.addEventListener("click", close);
  back.addEventListener("pointerdown", (e) => {
    if (e.target === back && !o.modeless) e.preventDefault();
  });
  el.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "checkbox") {
      const primary = el.querySelector<HTMLButtonElement>(".dlg-btn.primary");
      if (primary) {
        e.preventDefault();
        primary.click();
      }
    } else if (e.key === "Tab" && !o.modeless) {
      // Keep focus inside the modal.
      const f = [...el.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex='0']")].filter((n) => !n.hasAttribute("disabled"));
      if (!f.length) return;
      const i = f.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) {
        e.preventDefault();
        f[f.length - 1].focus();
      } else if (!e.shiftKey && i === f.length - 1) {
        e.preventDefault();
        f[0].focus();
      }
    }
  });
  back.append(el);
  host().append(back);
  const first = el.querySelector<HTMLElement>("input:not([type=radio]):not([type=checkbox]), select, textarea") ?? el.querySelector<HTMLElement>(".dlg-btn.primary") ?? x;
  first.focus();
  if (first instanceof HTMLInputElement) first.select();
  return { el, close };
}

/** `<label><input> text</label>` helpers for dialog bodies. */
export function field(label: string, input: HTMLElement): HTMLLabelElement {
  const l = document.createElement("label");
  l.className = "dlg-field";
  const s = document.createElement("span");
  s.textContent = label;
  l.append(s, input);
  return l;
}

export function check(label: string, checked = false, testid?: string): { el: HTMLLabelElement; input: HTMLInputElement } {
  const l = document.createElement("label");
  l.className = "dlg-check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  if (testid) input.dataset.testid = testid;
  l.append(input, document.createTextNode(` ${label}`));
  return { el: l, input };
}

export function textInput(value = "", testid?: string, aria?: string): HTMLInputElement {
  const i = document.createElement("input");
  i.className = "dlg-input";
  i.value = value;
  i.spellcheck = false;
  if (testid) i.dataset.testid = testid;
  if (aria) i.setAttribute("aria-label", aria);
  return i;
}

export function div(cls: string, ...children: (Node | string)[]): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  d.append(...children);
  return d;
}
