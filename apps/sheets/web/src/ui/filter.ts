// The filter menu a column's filter button opens (Google's): sort the filtered range, filter by
// condition, or filter by values with a searchable checklist.
import "./filter.css";
import type { EngineClient } from "../engine/client";
import { colName, type Range, rangeA1 } from "../grid/axis";
import type { Grid } from "../grid/grid";

const CONDITIONS: [string, string][] = [
  ["none", "None"],
  ["empty", "Is empty"],
  ["notEmpty", "Is not empty"],
  ["contains", "Text contains"],
  ["notContains", "Text does not contain"],
  ["starts", "Text starts with"],
  ["ends", "Text ends with"],
  ["exactly", "Text is exactly"],
  [">", "Greater than"],
  [">=", "Greater than or equal to"],
  ["<", "Less than"],
  ["<=", "Less than or equal to"],
  ["=", "Is equal to"],
  ["<>", "Is not equal to"],
];

/** The data.filterBy criterion for a condition, or null when it has none. */
export function conditionCriterion(kind: string, value: string): Record<string, unknown> | null {
  switch (kind) {
    case "none":
      return null;
    case "empty":
      return { values: [], blanks: true };
    case "notEmpty":
      return { custom: { op: "<>", value: "" } };
    case "contains":
      return { custom: { op: "=", value: `*${value}*` } };
    case "notContains":
      return { custom: { op: "<>", value: `*${value}*` } };
    case "starts":
      return { custom: { op: "=", value: `${value}*` } };
    case "ends":
      return { custom: { op: "=", value: `*${value}` } };
    case "exactly":
      return { custom: { op: "=", value } };
    default:
      return { custom: { op: kind, value } };
  }
}

export class FilterMenu {
  private el: HTMLDivElement | null = null;

  constructor(
    private grid: Grid,
    private engine: EngineClient,
  ) {
    document.addEventListener("pointerdown", (e) => {
      if (this.el && !this.el.contains(e.target as Node)) this.close();
    });
  }

  close(): void {
    this.el?.remove();
    this.el = null;
  }

  get isOpen(): boolean {
    return !!this.el;
  }

  /** Opens the menu for column `col` of the filter range, below the button at (x, y). */
  async open(at: { x: number; y: number; col: number; range: Range }): Promise<void> {
    this.close();
    const { col, range } = at;
    const letter = colName(col);
    const data = { ...range, r0: range.r0 + 1, c0: col, c1: col };
    // Distinct display values in the column, and which of them are showing (on a visible row).
    const shown = new Map<string, boolean>();
    if (data.r1 >= data.r0) {
      const vp = await this.engine.viewport(data.r0, col, Math.min(data.r1, data.r0 + 50_000), col);
      const byRow = new Map<number, string>(vp.cells.map((c) => [c[0], c[2]]));
      vp.row_heights.forEach((h, i) => {
        const v = byRow.get(data.r0 + i) ?? "";
        shown.set(v, (shown.get(v) ?? false) || h > 0);
      });
    }
    const values = [...shown.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, undefined, { numeric: true })));

    const el = document.createElement("div");
    el.className = "filter-menu";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", `Filter column ${letter}`);
    el.dataset.testid = "filter-menu";
    el.innerHTML = `
      <button class="fm-item" data-sort="asc">Sort A → Z</button>
      <button class="fm-item" data-sort="desc">Sort Z → A</button>
      <hr />
      <details class="fm-section">
        <summary>Filter by condition</summary>
        <select class="fm-cond" aria-label="Condition">${CONDITIONS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
        <input class="fm-cond-value" aria-label="Value or formula" placeholder="Value" hidden />
      </details>
      <details class="fm-section" open>
        <summary>Filter by values</summary>
        <div class="fm-links"><a href="#" data-all="1">Select all ${values.length}</a> - <a href="#" data-all="0">Clear</a></div>
        <input class="fm-search" type="search" placeholder="Search" aria-label="Search values" />
        <div class="fm-list" role="group"></div>
      </details>
      <div class="fm-actions"><button class="fm-cancel">Cancel</button><button class="fm-ok">OK</button></div>`;
    const list = el.querySelector<HTMLDivElement>(".fm-list")!;
    for (const v of values) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = shown.get(v) ?? true;
      box.value = v;
      label.append(box, document.createTextNode(v === "" ? "(Blanks)" : v));
      list.append(label);
    }
    const cond = el.querySelector<HTMLSelectElement>(".fm-cond")!;
    const condValue = el.querySelector<HTMLInputElement>(".fm-cond-value")!;
    cond.addEventListener("change", () => {
      condValue.hidden = ["none", "empty", "notEmpty"].includes(cond.value);
    });
    el.querySelector<HTMLInputElement>(".fm-search")!.addEventListener("input", (e) => {
      const q = (e.target as HTMLInputElement).value.toLowerCase();
      for (const l of list.querySelectorAll("label")) l.hidden = !l.textContent!.toLowerCase().includes(q);
    });
    el.querySelectorAll<HTMLAnchorElement>("[data-all]").forEach((a) =>
      a.addEventListener("click", (e) => {
        e.preventDefault();
        for (const b of list.querySelectorAll<HTMLInputElement>("label:not([hidden]) input")) b.checked = a.dataset.all === "1";
      }),
    );
    el.querySelectorAll<HTMLButtonElement>("[data-sort]").forEach((b) =>
      b.addEventListener("click", async () => {
        this.close();
        await this.grid.run("data.sort", {
          range: rangeA1(range),
          header: true,
          keys: [{ column: letter, order: b.dataset.sort }],
        });
        this.grid.focus();
      }),
    );
    el.querySelector(".fm-cancel")!.addEventListener("click", () => {
      this.close();
      this.grid.focus();
    });
    el.querySelector(".fm-ok")!.addEventListener("click", async () => {
      const boxes = [...list.querySelectorAll<HTMLInputElement>("input")];
      const criterion = conditionCriterion(cond.value, condValue.value);
      let params: Record<string, unknown>;
      if (criterion) params = { column: letter, ...criterion };
      else if (boxes.every((b) => b.checked)) params = { column: letter, clear: true };
      else {
        const picked = boxes.filter((b) => b.checked).map((b) => b.value);
        params = { column: letter, values: picked.filter((v) => v !== ""), blanks: picked.includes("") };
      }
      this.close();
      await this.grid.run("data.filterBy", params);
      this.grid.focus();
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.close();
        this.grid.focus();
      }
    });
    document.body.append(el);
    const w = el.offsetWidth;
    el.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - w - 8))}px`;
    el.style.top = `${Math.min(at.y + 4, window.innerHeight - el.offsetHeight - 8)}px`;
    this.el = el;
  }
}
