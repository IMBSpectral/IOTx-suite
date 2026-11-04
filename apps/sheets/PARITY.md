# Spectral Sheets: Google Sheets parity scorecard

Purpose: a single, repeatable number for each development cycle, "Spectral Sheets is **X%** of Google Sheets",
plus the checklist that produces it.

- Baseline date: 2026-10-25
- Reference: Google Sheets as documented at support.google.com/docs, and the function list at
  support.google.com/docs/table/25273 (fetched 2026-10-25).
- Clone under test: `apps/sheets` web UI (`web/index.html`, `web/src/`), engine `suite/gridcraft` (read-only) via
  `apps/sheets/engine-wasm`.

## Status legend

| Status | Meaning | Counts toward score |
|---|---|---|
| `done` | A user can do it in the web UI today. | yes (1 point) |
| `engine` | The engine already implements it (command id or function cited); the UI does not expose it. Cheap to ship. | no (0 points) |
| `missing` | Needs new work (engine and UI, or server/infra). Also used when engine support could not be confirmed. | no (0 points) |

Rule of thumb for `done`: it must be reachable by a normal user through the UI (click, keyboard, or typing into a cell),
without dev tools. Engine commands that the UI never calls are `engine`, not `done`.

## Scoring rule

- **Category score** = `done` items / total items in the category.
- **Overall score** = sum over categories of (category weight x category score). Weights sum to 100, so the result is a percentage.
- `engine` and `missing` both score 0. A second, informational number, **reachable %**, counts `done` + `engine` the same
  way: it shows how much of the gap is UI-only.
- Weights reflect how much typical business users depend on each area day to day (editing, formatting and formulas
  dominate; enterprise controls matter for adoption but are used rarely).

## Today's score (2026-10-25)

| # | Category | Weight | Items | done | engine | missing | Category % | Weighted points | Reachable % |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | Grid & editing | 13 | 26 | 16 | 8 | 2 | 61.5% | 8.00 | 92.3% |
| 2 | Formatting | 11 | 22 | 17 | 4 | 1 | 77.3% | 8.50 | 95.5% |
| 3 | Structure (rows/cols/sheets) | 9 | 20 | 17 | 2 | 1 | 85.0% | 7.65 | 95.0% |
| 4 | Data tools | 10 | 18 | 5 | 7 | 6 | 27.8% | 2.78 | 66.7% |
| 5 | Formulas & functions | 12 | 37 | 16 | 5 | 16 | 43.2% | 5.19 | 56.8% |
| 6 | Visualization (charts/pivots/sparklines) | 9 | 20 | 0 | 18 | 2 | 0.0% | 0.00 | 90.0% |
| 7 | Collaboration | 8 | 13 | 6 | 0 | 7 | 46.2% | 3.69 | 46.2% |
| 8 | Comments & notes | 4 | 9 | 0 | 7 | 2 | 0.0% | 0.00 | 77.8% |
| 9 | Version history | 3 | 6 | 0 | 0 | 6 | 0.0% | 0.00 | 0.0% |
| 10 | Import/export & print | 5 | 16 | 9 | 3 | 4 | 56.2% | 2.81 | 75.0% |
| 11 | Menus, shortcuts & UX | 6 | 17 | 9 | 5 | 3 | 52.9% | 3.18 | 82.4% |
| 12 | Performance & scale | 3 | 7 | 4 | 0 | 3 | 57.1% | 1.71 | 57.1% |
| 13 | Mobile & offline | 2 | 6 | 2 | 0 | 4 | 33.3% | 0.67 | 33.3% |
| 14 | Enterprise | 5 | 16 | 0 | 3 | 13 | 0.0% | 0.00 | 18.8% |
| | **Total** | **100** | **233** | **101** | **62** | **70** | | **44.2** | **71.4** |

**Overall: 44.2% of Google Sheets** (reachable with UI work alone on the existing engine: 71.4%).

Function library on its own: **465 of 515** Google Sheets functions exist in the engine (**90.3%**); 50 are missing
(see section 5b).

---

## 1. Grid & editing (weight 13)

| # | Feature | Status | Evidence / gap |
|---|---|---|---|
| 1.1 | Type values and formulas into cells | `done` | `cell.set` |
| 1.2 | In-cell editor (type to replace, F2 to edit, Esc cancels, Enter/Tab commits and moves) | `done` | `web/src/grid/grid.ts` onKey |
| 1.3 | Formula bar shows and edits the active cell | `done` | `web/src/main.ts` |
| 1.4 | Name box: shows active cell, Enter jumps to a typed reference | `done` | `web/src/main.ts` |
| 1.5 | Keyboard navigation (arrows, Tab/Enter, PageUp/PageDown, Home, Ctrl+Home) | `done` | grid.ts onKey |
| 1.6 | Range selection by mouse drag and Shift+arrows | `done` | grid.ts |
| 1.7 | Select whole row/column by header click; select all (Ctrl+A) | `done` | grid.ts |
| 1.8 | Undo / redo (Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z) | `done` | `edit.undo`, `edit.redo` |
| 1.9 | Copy / cut / paste inside the app keeping formulas (relative refs shift) and formats | `done` | `edit.copy`, `edit.cut`, `edit.paste` |
| 1.10 | Paste from other apps (plain text and HTML tables) | `done` | `edit.paste {text, html}` |
| 1.11 | Delete/Backspace clears contents | `done` | `edit.clearContents` |
| 1.12 | Ctrl+Arrow jump to data edge, Ctrl+Shift+Arrow extend | `engine` | `selection.move {jump, extend}` |
| 1.13 | Fill handle drag (copy / extend series) | `done` | `edit.autoFill` |
| 1.14 | Fill down / fill right (Ctrl+D / Ctrl+R) | `engine` | `edit.fillDown`, `edit.fillRight` |
| 1.15 | Paste special (values only, formats only, transpose, formulas only) | `done` | `edit.pasteSpecial` |
| 1.16 | Find (Ctrl+F) | `done` | `edit.find` |
| 1.17 | Find and replace (match case, whole cell, search formulas, all sheets) | `done` | `edit.replace {within: workbook}` |
| 1.18 | Go to range | `engine` | `edit.goTo` |
| 1.19 | Clear formatting (Ctrl+\\) | `done` | `edit.clearFormats` |
| 1.20 | Checkboxes in cells (Insert > Checkbox, click to toggle) | `engine` | `insert.checkbox`, `cell.toggleCheckbox` |
| 1.21 | Hyperlinks in cells (insert link, click to open) | `engine` | `insert.link`, `link.open` |
| 1.22 | Spell check | `engine` | `review.spelling` |
| 1.23 | Insert special characters | `engine` | `insert.symbol` |
| 1.24 | Smart Fill (pattern-based fill suggestions) | `engine` | `edit.flashFill` (Flash Fill equivalent) |
| 1.25 | Smart chips (people, files, dates, places, dropdown chips) | `missing` | |
| 1.26 | Autocomplete of entries from the same column while typing | `missing` | |

## 2. Formatting (weight 11)

| # | Feature | Status | Evidence / gap |
|---|---|---|---|
| 2.1 | Bold / italic / underline | `done` | toolbar + Ctrl+B/I/U, `home.bold`/`home.italic`/`home.underline` |
| 2.2 | Horizontal align left / center / right | `done` | `home.alignLeft`/`home.alignCenter`/`home.alignRight` |
| 2.3 | Strikethrough | `done` | `home.strikethrough` |
| 2.4 | Font family | `done` | `home.fontName` |
| 2.5 | Font size | `done` | `home.fontSize` |
| 2.6 | Text color | `done` | `home.fontColor` |
| 2.7 | Fill (background) color | `done` | `home.fillColor` |
| 2.8 | Borders (sides, style, color) | `done` | `home.borders` |
| 2.9 | Vertical align top / middle / bottom | `done` | `home.alignTop`/`home.alignMiddle`/`home.alignBottom` |
| 2.10 | Text wrapping (overflow / wrap / clip) | `done` | `home.wrapText` |
| 2.11 | Text rotation | `done` | `home.orientation` |
| 2.12 | Merge cells (all / horizontally) and unmerge | `done` | `home.mergeCells`, `home.mergeAcross`, `home.unmergeCells` |
| 2.13 | Number format presets (number, percent, currency, accounting, scientific, plain text) | `done` | `home.numberFormat`, `home.percent`, `home.accounting` |
| 2.14 | Date and time formats | `done` | `home.numberFormat {format: "Short Date"\|"Long Date"\|"Time"}` |
| 2.15 | Custom number format codes | `done` | `home.numberFormat {code}` |
| 2.16 | Increase / decrease decimal places | `done` | `home.increaseDecimal`, `home.decreaseDecimal` |
| 2.17 | Paint format | `done` | `edit.formatPainter` |
| 2.18 | Conditional formatting: single-color rules (cell is, text contains, custom formula, blanks, duplicates) | `engine` | `home.conditionalFormat` (cellIs, containsText, expression, duplicate...) |
| 2.19 | Conditional formatting: color scales | `engine` | `home.conditionalFormat {type: colorScale}` |
| 2.20 | Alternating colors (banded rows) | `engine` | `home.formatAsTable`, `table.bandedRows` |
| 2.21 | Spreadsheet themes | `engine` | `pageLayout.theme`, `pageLayout.themeColors`, `pageLayout.themeFonts` |
| 2.22 | Rich text inside a cell (mixed formatting within one cell) | `missing` | not confirmed in engine |

## 3. Structure: rows, columns, sheets (weight 9)

| # | Feature | Status | Evidence / gap |
|---|---|---|---|
| 3.1 | Resize columns and rows by dragging header borders | `done` | `home.columnWidth`, `home.rowHeight` |
| 3.2 | Add a sheet | `done` | `home.insertSheet` |
| 3.3 | Switch sheets via tabs | `done` | `sheet.activate` |
| 3.4 | Exact resize dialog ("Resize column / row") | `done` | `home.columnWidth`, `home.rowHeight` (UI only drags) |
| 3.5 | Fit to data (double-click border) | `done` | `home.autofitColumnWidth`, `home.autofitRowHeight` |
| 3.6 | Insert rows above / below | `done` | `home.insertRows` |
| 3.7 | Insert columns left / right | `done` | `home.insertColumns` |
| 3.8 | Delete rows / columns | `done` | `home.deleteRows`, `home.deleteColumns` |
| 3.9 | Insert / delete cells with shift | `done` | `home.insertCells`, `home.deleteCells` |
| 3.10 | Hide / unhide rows and columns | `done` | `home.hideRows`, `home.hideColumns`, `home.unhideRows`, `home.unhideColumns` |
| 3.11 | Move columns (drag) | `engine` | `sheet.moveColumns` |
| 3.12 | Freeze rows / columns | `done` | `view.freezePanes`, `view.freezeTopRow`, `view.freezeFirstColumn`, `view.unfreezePanes` |
| 3.13 | Group / ungroup rows and columns (collapsible) | `engine` | `data.group`, `data.ungroup`, `data.hideDetail`, `data.showDetail` |
| 3.14 | Rename sheet | `done` | `sheet.rename` |
| 3.15 | Delete sheet | `done` | `home.deleteSheet` |
| 3.16 | Duplicate sheet | `done` | `sheet.move {copy: true}` |
| 3.17 | Reorder sheet tabs | `done` | `sheet.move {to}` |
| 3.18 | Sheet tab color | `done` | `sheet.tabColor` |
| 3.19 | Hide / unhide sheet | `done` | `sheet.hide`, `sheet.unhide` |
| 3.20 | Copy sheet to another spreadsheet | `missing` | needs multi-document storage |

## 4. Data tools (weight 10)

| # | Feature | Status | Evidence / gap |
|---|---|---|---|
| 4.1 | Sort range A to Z / Z to A | `done` | `data.sortAscending`, `data.sortDescending` |
| 4.2 | Advanced range sort (multiple columns, header row) | `engine` | `data.sort` |
| 4.3 | Create a filter (filter buttons on header row) | `done` | `data.filter` |
| 4.4 | Filter by values and by condition | `done` | `data.filterBy {values, custom, top}` |
| 4.5 | Filter views (named, per-user filters that do not affect collaborators) | `missing` | |
| 4.6 | Slicers | `engine` | `insert.slicer`, `slicer.*` |
| 4.7 | Data validation: dropdown list (from list or range) | `engine` | `data.validation {type: list, dropdown}` |
| 4.8 | Data validation: number / date / text length / custom formula, warn or reject | `engine` | `data.validation {type, errorStyle}` |
| 4.9 | Remove duplicates | `done` | `data.removeDuplicates` |
| 4.10 | Trim whitespace (Data cleanup) | `missing` | no engine command |
| 4.11 | Cleanup suggestions and column stats | `missing` | |
| 4.12 | Split text to columns | `done` | `data.textToColumns` |
| 4.13 | Named ranges (define, manage) | `engine` | `formulas.defineName`, `formulas.nameManager` |
| 4.14 | Tables (convert range to table, column types, totals) | `engine` | `insert.table`, `table.*` |
| 4.15 | Randomize range | `missing` | |
| 4.16 | Named functions (user-defined LAMBDA functions) | `missing` | LAMBDA exists; no named-function store confirmed |
| 4.17 | Data connectors (Connected Sheets / BigQuery / Looker) | `missing` | |
| 4.18 | Refresh external data | `engine` | `data.refreshAll` (refreshes pivots/queries; no Google connectors) |

## 5. Formulas & functions (weight 12)

Note: functions count as `done` when the engine implements them, because typing a formula into a cell already
reaches the engine. Function UX (autocomplete, help) is scored separately.

### 5a. Checklist

| # | Feature | Status | Evidence / gap |
|---|---|---|---|
| 5.1 | Formula entry with automatic dependency-driven recalculation | `done` | engine calc via `cell.set` |
| 5.2 | Cross-sheet references (`Sheet2!A1`) | `done` | engine evaluator |
| 5.3 | Dynamic arrays spill into neighbouring cells (FILTER, SORT, UNIQUE, SEQUENCE results) | `done` | engine computes `sheet.spill`, but `engine-wasm` `viewport()` iterates `sheet.cells` only, so spilled cells beyond the anchor are not drawn |
| 5.4 | Function autocomplete while typing | `missing` | |
| 5.5 | Function help popup (signature, argument hints) | `engine` | `formulas.functions` returns signatures and descriptions |
| 5.6 | Insert function menu (Insert > Function) | `engine` | `formulas.insertFunction` |
| 5.7 | Range highlighting and click-to-insert references while editing a formula | `missing` | |
| 5.8 | Named ranges usable in formulas | `engine` | `formulas.defineName` (no UI to define) |
| 5.9 | Iterative calculation setting | `engine` | `formulas.calculationOptions` |
| 5.10 | Show formulas toggle (Ctrl+\`) | `done` | `formulas.showFormulas` |
| 5.11 | Error explanation on hover (#REF!, #N/A, ...) | `engine` | `formulas.errorChecking` |
| 5.12 | Gemini formula help / suggested formulas | `missing` | |
| 5.13 | Date functions (25 of 26) | `done` | missing: EPOCHTODATE (5.29) |
| 5.14 | Engineering functions (44 of 47) | `done` | missing: IMCOTH, IMLOG, IMTANH (5.29) |
| 5.15 | Financial functions (50 of 50) | `done` | |
| 5.16 | Info functions (16 of 18) | `done` | missing: ISDATE, ISEMAIL (5.29) |
| 5.17 | Logical functions incl. LAMBDA, LET (13 of 13) | `done` | |
| 5.18 | Lookup functions incl. XLOOKUP, INDIRECT, OFFSET (16 of 17) | `done` | missing: GETPIVOTDATA (5.29) |
| 5.19 | Math functions (83 of 84) | `done` | missing: COUNTUNIQUE (5.29) |
| 5.20 | Statistical functions (134 of 136) | `done` | missing: AVERAGE.WEIGHTED, MARGINOFERROR (5.29) |
| 5.21 | Text functions incl. REGEXEXTRACT, REGEXREPLACE (38 of 41) | `done` | missing: SPLIT, JOIN, REGEXMATCH (5.30) |
| 5.22 | Database functions (12 of 12) | `done` | |
| 5.23 | Filter functions FILTER, SORT, UNIQUE (3 of 4) | `done` | values compute; spill display is 5.3. missing: SORTN (5.29) |
| 5.24 | Array functions incl. MAP, REDUCE, BYROW, HSTACK, TOCOL (27 of 29) | `done` | missing: ARRAY_CONSTRAIN, FLATTEN (5.29) |
| 5.25 | Operator functions ADD, MINUS, MULTIPLY, DIVIDE, POW, EQ, NE, GT, GTE, LT, LTE, UMINUS, UPLUS, UNARY_PERCENT, ISBETWEEN | `missing` | 15 of 17 missing (CONCAT, UNIQUE present) |
| 5.26 | Parser functions TO_DATE, TO_DOLLARS, TO_PERCENT, TO_PURE_NUMBER, TO_TEXT | `missing` | CONVERT present |
| 5.27 | ARRAYFORMULA | `missing` | Google-only |
| 5.28 | QUERY (Google Visualization query language) | `missing` | Google-only |
| 5.29 | Small Google gaps: EPOCHTODATE, IMCOTH, IMLOG, IMTANH, ISDATE, ISEMAIL, GETPIVOTDATA, COUNTUNIQUE, AVERAGE.WEIGHTED, MARGINOFERROR, SORTN, ARRAY_CONSTRAIN, FLATTEN | `missing` | 13 functions |
| 5.30 | SPLIT, JOIN, REGEXMATCH | `missing` | Google-only names (engine has TEXTSPLIT, TEXTJOIN, REGEXTEST) |
| 5.31 | IMPORTRANGE (pull ranges from other spreadsheets) | `missing` | Google-only; needs multi-document server |
| 5.32 | IMPORTDATA, IMPORTHTML, IMPORTXML, IMPORTFEED, ISURL | `missing` | Google-only web import (engine has WEBSERVICE, FILTERXML, not Google-compatible) |
| 5.33 | GOOGLEFINANCE | `missing` | Google-only; needs a market-data source |
| 5.34 | GOOGLETRANSLATE, DETECTLANGUAGE | `missing` | Google-only; needs a translation service |
| 5.35 | IMAGE (image in cell) | `missing` | |
| 5.36 | SPARKLINE function (in-cell chart) | `missing` | Google-only formula form; Excel-style sparklines in 6.15 |
| 5.37 | AI function (Gemini in a cell) | `missing` | Google-only |

### 5b. Function coverage detail

Method: Google's official list (support.google.com/docs/table/25273, 515 unique names; UNIQUE is listed twice, under
Filter and Operator) compared with the engine registry (`suite/gridcraft/crates/functions/src/*.rs`, `f!("NAME", ...)`,
491 names) plus the functions the evaluator implements itself (`suite/gridcraft/crates/calc/src/eval.rs`
`SPECIAL_FUNCTIONS`: IF, IFS, IFERROR, IFNA, CHOOSE, SWITCH, ROW, COLUMN, ROWS, COLUMNS, AREAS, ISREF, ISFORMULA,
FORMULATEXT, SHEET, SHEETS, OFFSET, INDIRECT, INDEX, CELL, TRIMRANGE, SUBTOTAL, AGGREGATE, TEXT, LET, LAMBDA, ISOMITTED,
MAP, REDUCE, SCAN, BYROW, BYCOL, MAKEARRAY).

**Result: 465 / 515 present (90.3%), 50 missing.**

| Google category | Present / total | Missing |
|---|---:|---|
| Date | 25 / 26 | EPOCHTODATE |
| Engineering | 44 / 47 | IMCOTH, IMLOG, IMTANH |
| Filter | 3 / 4 | SORTN |
| Financial | 50 / 50 | |
| Google | 0 / 7 | ARRAYFORMULA, DETECTLANGUAGE, GOOGLEFINANCE, GOOGLETRANSLATE, IMAGE, QUERY, SPARKLINE |
| Info | 16 / 18 | ISDATE, ISEMAIL |
| Logical | 13 / 13 | |
| Lookup | 16 / 17 | GETPIVOTDATA |
| Math | 83 / 84 | COUNTUNIQUE |
| Operator | 2 / 17 | ADD, DIVIDE, EQ, GT, GTE, ISBETWEEN, LT, LTE, MINUS, MULTIPLY, NE, POW, UMINUS, UNARY_PERCENT, UPLUS |
| Statistical | 134 / 136 | AVERAGE.WEIGHTED, MARGINOFERROR |
| Text | 38 / 41 | JOIN, REGEXMATCH, SPLIT |
| Database | 12 / 12 | |
| Parser | 1 / 6 | TO_DATE, TO_DOLLARS, TO_PERCENT, TO_PURE_NUMBER, TO_TEXT |
| Array | 27 / 29 | ARRAY_CONSTRAIN, FLATTEN |
| Web | 2 / 8 | IMPORTDATA, IMPORTFEED, IMPORTHTML, IMPORTRANGE, IMPORTXML, ISURL |
| AI | 0 / 1 | AI |

(Per-category totals sum to 516 because UNIQUE appears under both Filter and Operator.)

Missing functions grouped by effort:

- **Google-only, need external services or new subsystems (13):** QUERY, IMPORTRANGE, IMPORTDATA, IMPORTHTML, IMPORTXML,
  IMPORTFEED, GOOGLEFINANCE, GOOGLETRANSLATE, DETECTLANGUAGE, AI, IMAGE, SPARKLINE, ARRAYFORMULA.
- **Google-only but pure computation, small (36):** operator functions (ADD, MINUS, MULTIPLY, DIVIDE, POW, EQ, NE, GT,
  GTE, LT, LTE, UMINUS, UPLUS, UNARY_PERCENT, ISBETWEEN), parser functions (TO_DATE, TO_DOLLARS, TO_PERCENT,
  TO_PURE_NUMBER, TO_TEXT), SPLIT, JOIN, REGEXMATCH, SORTN, COUNTUNIQUE, AVERAGE.WEIGHTED, MARGINOFERROR, ARRAY_CONSTRAIN,
  FLATTEN, EPOCHTODATE, ISDATE, ISEMAIL, ISURL, IMCOTH, IMTANH, IMLOG. Several are thin aliases of functions the engine
  already has (SPLIT ~ TEXTSPLIT, JOIN ~ TEXTJOIN, REGEXMATCH ~ REGEXTEST, FLATTEN ~ TOCOL).
- **Shared with Excel, still missing (1):** GETPIVOTDATA (needs pivot lookup plumbing).

Engine extras not in Google's list (do not score, informational): e.g. XMATCH, TAKE, DROP, EXPAND, TEXTSPLIT,
TEXTBEFORE, TEXTAFTER, GROUPBY, PIVOTBY, REGEXTEST, FORECAST.ETS family, CUBE* family, AGGREGATE, BAHTTEXT.

## 6. Visualization: charts, pivots, sparklines, objects (weight 9)

| # | Feature | Status | Evidence / gap |
|---|---|---|---|
| 6.1 | Insert chart: column, bar, line, area, pie, scatter | `engine` | `insert.chart {type}` |
| 6.2 | Additional chart types: histogram, waterfall, treemap, candlestick (stock), bubble, radar | `engine` | `insert.chart {type: histogram\|waterfall\|treemap\|stock\|bubble\|radar}` |
| 6.3 | Google-specific charts: geo map, gauge, scorecard, org chart, timeline, table chart | `missing` | |
| 6.4 | Chart editor: change type, data range, switch rows/columns | `engine` | `chart.changeType`, `chart.selectData`, `chart.switchRowColumn` |
| 6.5 | Chart customization: titles, legend, axes, gridlines, colors, data labels | `engine` | `chart.addElement`, `chart.axis`, `chart.changeColors`, `chart.dataLabels` |
| 6.6 | Combo charts (series as different types) | `engine` | `chart.setSeriesType` |
| 6.7 | Trendlines and error bars | `engine` | `chart.addElement {element: trendline\|errorBars}`, `chart.errorBars` |
| 6.8 | Move, resize, delete chart | `engine` | `chart.move`, `object.move`, `chart.delete` |
| 6.9 | Download chart as image | `engine` | `object.saveAsPicture` |
| 6.10 | Create pivot table | `engine` | `insert.pivotTable` |
| 6.11 | Pivot editor: rows, columns, values, filters | `engine` | `pivot.addField`, `pivot.moveField`, `pivot.removeField`, `pivot.filter` |
| 6.12 | Pivot summarize by (SUM, COUNT, AVERAGE, ...) and show as % of total | `engine` | `pivot.valueSettings` |
| 6.13 | Pivot grouping (date and number buckets) and calculated fields | `engine` | `pivot.group`, `pivot.calculatedField` |
| 6.14 | Suggested pivots / charts (Explore) | `engine` | `insert.recommendedPivotTables`, `insert.recommendedCharts` |
| 6.15 | Sparklines rendered in cells | `engine` | `insert.sparkline` (Excel-style groups; Google's formula form is 5.36) |
| 6.16 | Images placed over cells | `engine` | `insert.picture` |
| 6.17 | Drawings (shapes, text boxes) | `engine` | `insert.shape`, `insert.textBox` |
| 6.18 | Pivot auto-refresh when source data changes | `engine` | `pivot.refresh` (manual refresh; auto behaviour not confirmed) |
| 6.19 | Slicer and pivot filter controls on canvas | `engine` | `slicer.toggle`, `pivot.insertSlicer` |
| 6.20 | Timeline view (Gantt-like view of date rows) | `missing` | |

## 7. Collaboration (weight 8)

| # | Feature | Status | Evidence / gap |
|---|---|---|---|
| 7.1 | Real-time co-editing (live edits from others) | `done` | `web/src/collab/session.ts`, `engine-wasm` collab Replica/Authority |
| 7.2 | Share by link (anyone with the link can edit) | `done` | |
| 7.3 | Presence avatars | `done` | |
| 7.4 | Collaborators' colored cursors and selections | `done` | |
| 7.5 | Reconnect with offline edit queue | `done` | |
| 7.6 | Server-ordered conflict resolution (no lost edits) | `done` | `Authority::apply`, `Replica::resync` |
| 7.7 | Per-user undo (undo only my own edits) | `missing` | undo is global today |
| 7.8 | Named collaborator identity (signed-in name / photo) | `missing` | no accounts |
| 7.9 | Link modes: view-only and comment-only links | `missing` | |
| 7.10 | Share with specific people by email | `missing` | |
| 7.11 | @mentions and email notifications | `missing` | |
| 7.12 | Notification rules (email me when changes are made) | `missing` | |
| 7.13 | Click an avatar to jump to that collaborator's cursor | `missing` | not confirmed in UI |

## 8. Comments & notes (weight 4)

| # | Feature | Status | Evidence / gap |
|---|---|---|---|
| 8.1 | Add a note to a cell | `engine` | `review.newNote` |
| 8.2 | Note indicator and hover display | `engine` | `review.showNote`, `review.showAllNotes` |
| 8.3 | Threaded comments on cells | `engine` | `review.newComment` |
| 8.4 | Reply to a comment | `engine` | `review.replyComment` |
| 8.5 | Resolve a thread | `engine` | `review.resolveComment` |
| 8.6 | Edit / delete comments and replies | `engine` | `review.editComment`, `review.deleteComment`, `review.deleteReply` |
| 8.7 | Comment list / navigation (all comments panel) | `engine` | `review.showComments`, `review.nextComment`, `review.previousComment` |
| 8.8 | Assign a comment to someone (action item) | `missing` | needs identities |
| 8.9 | Comment notifications (email, unread badge) | `missing` | |

## 9. Version history (weight 3)

| # | Feature | Status | Evidence / gap |
|---|---|---|---|
| 9.1 | Automatic timestamped versions list | `missing` | server keeps ops; no version UI |
| 9.2 | Restore a previous version | `missing` | |
| 9.3 | Name a version | `missing` | |
| 9.4 | Highlight changes by editor in a version | `missing` | |
| 9.5 | Cell edit history (right-click > Show edit history) | `missing` | |
| 9.6 | Make a copy from a past version | `missing` | |

## 10. Import / export & print (weight 5)

| # | Feature | Status | Evidence / gap |
|---|---|---|---|
| 10.1 | Open / import .xlsx | `done` | `file.open` |
| 10.2 | Open / import .ods | `done` | |
| 10.3 | Open / import .csv | `done` | |
| 10.4 | Download .xlsx | `done` | `save_xlsx` |
| 10.5 | Download .ods | `done` | |
| 10.6 | Download .csv (current sheet) | `done` | `file.exportCsv` |
| 10.7 | Import .tsv / .txt | `engine` | `file.open` (csv, tsv, txt, json) |
| 10.8 | Import options (new spreadsheet / insert sheet / replace sheet / append; separator) | `missing` | |
| 10.9 | Download .tsv | `done` | `file.save` (.tsv) |
| 10.10 | Download .pdf | `done` | `file.exportPdf` |
| 10.11 | Download web page (.html) | `done` | `file.exportHtml` |
| 10.12 | Print with settings (orientation, paper size, scale, margins, gridlines) | `engine` | `file.print`, `pageLayout.orientation`/`size`/`margins`/`scaleToFit`/`printGridlines` |
| 10.13 | Print selection / range, repeat frozen rows, headers and footers | `engine` | `pageLayout.printArea`, `pageLayout.printTitles`, `pageLayout.headerFooter` |
| 10.14 | Make a copy of the spreadsheet | `missing` | |
| 10.15 | Publish to the web | `missing` | |
| 10.16 | Email as attachment | `missing` | `file.sendAsAttachment` exists but needs a mail backend; unconfirmed |

## 11. Menus, shortcuts & UX (weight 6)

| # | Feature | Status | Evidence / gap |
|---|---|---|---|
| 11.1 | Core keyboard shortcuts (Ctrl+Z/Y/B/I/U/A, F2, arrows, Tab/Enter, Delete) | `done` | grid.ts onKey |
| 11.2 | Basic toolbar (undo/redo, B/I/U, align) | `done` | `web/index.html` |
| 11.3 | Full toolbar (font, size, colors, borders, merge, wrap, number formats, zoom) | `done` | engine commands exist; toolbar UI does not |
| 11.4 | Menu bar (File, Edit, View, Insert, Format, Data, Tools, Help) | `done` | |
| 11.5 | Right-click context menu on cells, headers, tabs | `done` | |
| 11.6 | Search the menus / command palette (Alt+/) | `done` | `app.commands` |
| 11.7 | Keyboard shortcuts help (Ctrl+/) | `done` | |
| 11.8 | Zoom | `engine` | `view.zoom` |
| 11.9 | Show / hide gridlines | `done` | `view.gridlines` |
| 11.10 | Show / hide formula bar | `engine` | `view.formulaBar` |
| 11.11 | Status bar with SUM / AVERAGE / COUNT of selection | `engine` | `selection.stats` |
| 11.12 | Template gallery | `engine` | `file.new {sample: budget\|sales\|grades}` (3 samples) |
| 11.13 | Spreadsheet title (rename document) | `done` | |
| 11.14 | Spreadsheet settings: locale, time zone, calculation | `missing` | `formulas.calculationOptions` covers calculation only |
| 11.15 | Accessibility: screen reader support for the canvas grid | `missing` | (`review.checkAccessibility` only audits content) |
| 11.16 | Macros (record and run) | `engine` | `automate.recordActions`, `automate.runScript` |
| 11.17 | Gemini side panel (help me organize, analyze) | `missing` | |

## 12. Performance & scale (weight 3)

| # | Feature | Status | Evidence / gap |
|---|---|---|---|
| 12.1 | Virtualized canvas rendering (only visible cells drawn) | `done` | `web/src/grid/grid.ts` |
| 12.2 | Viewport-only data fetch from the engine | `done` | `engine-wasm` `viewport()` |
| 12.3 | Calculation off the UI thread (Web Worker) | `done` | `web/src/engine/worker.ts` |
| 12.4 | Incremental recalculation (only dependents recompute) | `done` | engine dependency graph |
| 12.5 | 10 million cells per spreadsheet with smooth scroll and edit | `missing` | grid addresses 1,048,576 x 16,384 but no benchmark at 10M populated cells |
| 12.6 | Fast open of large files (50 MB+ xlsx) | `missing` | unbenchmarked |
| 12.7 | 100 simultaneous editors per document | `missing` | unbenchmarked |

## 13. Mobile & offline (weight 2)

| # | Feature | Status | Evidence / gap |
|---|---|---|---|
| 13.1 | Local autosave (survives tab close) | `done` | `web/src/store/autosave.ts` (IndexedDB) |
| 13.2 | Keep editing while offline; sync on reconnect | `done` | collab offline queue |
| 13.3 | Responsive phone/tablet layout | `missing` | |
| 13.4 | Touch gestures (tap-select handles, pinch zoom, long-press menu) | `missing` | |
| 13.5 | Installable app / offline launch (PWA) | `missing` | |
| 13.6 | Native iOS / Android apps | `missing` | |

## 14. Enterprise (weight 5)

| # | Feature | Status | Evidence / gap |
|---|---|---|---|
| 14.1 | User accounts / sign-in | `missing` | anyone with link edits |
| 14.2 | Permission roles: viewer, commenter, editor, owner | `missing` | |
| 14.3 | Link restriction: restricted / organization only / anyone | `missing` | |
| 14.4 | Share with groups and domains | `missing` | |
| 14.5 | SSO (SAML / OIDC) | `missing` | |
| 14.6 | Admin console (user management, sharing policies) | `missing` | |
| 14.7 | Audit log (who viewed / edited / shared) | `missing` | |
| 14.8 | Protected sheets | `engine` | `review.protectSheet` (password-based, not per-user permissions) |
| 14.9 | Protected ranges | `engine` | `review.allowEditRanges` (password-based) |
| 14.10 | Viewers/commenters cannot download, print or copy | `missing` | |
| 14.11 | Data loss prevention / classification labels | `missing` | |
| 14.12 | REST API (read/write values, batch update) | `missing` | |
| 14.13 | Script platform (Apps Script equivalent: custom functions, triggers) | `engine` | `automate.newScript`, `automate.runScript` (engine scripts; not Apps Script compatible, no triggers) |
| 14.14 | Add-ons / extensions marketplace | `missing` | |
| 14.15 | Ownership transfer and shared drives | `missing` | |
| 14.16 | Encryption at rest and client-side encryption | `missing` | |

---

## How to update (every cycle)

1. For each feature shipped in the UI this cycle, change its status to `done` (keep the evidence column pointing at the
   command id or file that implements it). Move items from `missing` to `engine` when the engine gains support.
2. Do not add or delete checklist rows casually; the denominator must stay stable for numbers to be comparable across
   cycles. If Google ships something material, add a row and record it in the changelog below.
3. Run `python scripts/parity.py --done <ids> --write <date>`: it flips those rows, recounts each category's
   `done` / `engine` / `missing` and recomputes:
   category % = done / items; weighted points = weight x category %; overall = sum of weighted points.
   Reachable % uses (done + engine) / items.
4. For functions, re-run the comparison (engine `f!("NAME"` names + `SPECIAL_FUNCTIONS` in `calc/src/eval.rs` vs. the
   Google list) and update section 5b; flip rows 5.25 to 5.37 to `done` only when every function in that row exists.
5. Update the "Today's score" table and the date, and add a changelog line.

## Changelog

| Date | Overall | Reachable | Functions | Notes |
|---|---:|---:|---:|---|
| 2026-10-25 | 21.0% | 69.7% | 465 / 515 | Baseline. |
| 2026-10-25 | 44.2% | 71.4% | 465 / 515 | Cycle 1: full toolbar, menu bar, context and tab menus, find & replace, filters, freeze, borders/merges/wrap/CF rendering, fill handle, spill display. Recompute with `python scripts/parity.py`. |
