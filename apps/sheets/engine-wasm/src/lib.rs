//! Spectral Sheets engine: the IMB Gridly `Session` behind a small, JSON-in/JSON-out surface that a
//! browser Web Worker calls through wasm-bindgen.
//!
//! The page never holds the workbook. It asks for a viewport (only the cells it is about to paint)
//! and sends commands; recalculation runs here, off the main thread.

pub mod collab;

use std::collections::BTreeMap;

use imbgridly_engine::core::{CellRef, RangeRef, Value};
use imbgridly_engine::cf::CfCache;
use imbgridly_engine::model::{BorderLine, BorderStyle, Color, HAlign, Style, Underline, VAlign, VertAlign, Workbook};
use imbgridly_engine::{DocState, Session, display, io};
use serde::Serialize;
use serde_json::{Value as Json, json};

/// Largest viewport one call returns, so a hostile or buggy request can't allocate the whole sheet.
pub const MAX_VIEWPORT_CELLS: u64 = 200_000;

/// Spectral's own command for paint format: `{source, target, sourceSheet?}`.
pub const PASTE_FORMATS: &str = "sheets.pasteFormats";

#[derive(Debug, PartialEq)]
pub struct EngineError(pub String);

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<imbgridly_engine::EngineError> for EngineError {
    fn from(e: imbgridly_engine::EngineError) -> Self {
        EngineError(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, EngineError>;

/// A painted cell: `[row, col, text, kind, style]`. `kind` is `n` number, `s` text, `b` boolean,
/// `e` error; `style` indexes `Viewport::styles` (0 = default, omitted from the table).
#[derive(Serialize, Debug, PartialEq)]
pub struct ViewCell(pub u32, pub u32, pub String, pub char, pub u32);

/// One border edge: width in pixels (1–3), dash kind and colour.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ViewBorder {
    pub w: u8,
    /// `s` solid, `d` dashed, `o` dotted, `=` double.
    pub k: char,
    pub color: String,
}

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
pub struct ViewStyle {
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub b: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub i: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub u: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub s: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    /// `l`, `c` or `r` when the cell states an alignment; absent means "general".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub h: Option<char>,
    /// `t` top or `m` middle; absent means bottom.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v: Option<char>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub wrap: bool,
    #[serde(skip_serializing_if = "is_zero")]
    pub indent: u8,
    /// Text rotation in degrees (-90..=90); absent when horizontal.
    #[serde(skip_serializing_if = "is_zero_i16")]
    pub rot: i16,
    /// `p` superscript, `b` subscript.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub va: Option<char>,
    /// Font family, when not the workbook default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    pub size: f32,
    /// Number format code, when not General (the text is already formatted; this is for the toolbar).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fmt: Option<String>,
    /// Borders: top, right, bottom, left.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bt: Option<ViewBorder>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub br: Option<ViewBorder>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bb: Option<ViewBorder>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bl: Option<ViewBorder>,
    /// Conditional-format data bar: fraction of the width (0–1) and colour.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bar: Option<(f32, String)>,
    /// Conditional-format icon: set name and index (0 = lowest).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<(String, usize)>,
    /// A conditional format hides the value (data bar or icon only).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub hide: bool,
}

fn is_zero(n: &u8) -> bool {
    *n == 0
}

fn is_zero_i16(n: &i16) -> bool {
    *n == 0
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Viewport {
    pub revision: u64,
    pub sheet: usize,
    pub cells: Vec<ViewCell>,
    pub styles: BTreeMap<u32, ViewStyle>,
    /// Column widths in pixels for `c0..=c1`, row heights in pixels for `r0..=r1`.
    pub col_widths: Vec<f32>,
    pub row_heights: Vec<f32>,
    /// Merged areas touching the window: `[r0, c0, r1, c1]`.
    pub merges: Vec<[u32; 4]>,
    /// The AutoFilter range `[r0, c0, r1, c1]` and the columns (offsets) that have criteria.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<ViewFilter>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ViewFilter {
    pub range: [u32; 4],
    pub active: Vec<u32>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct SheetInfo {
    pub name: String,
    pub hidden: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Info {
    pub title: String,
    pub revision: u64,
    pub active: usize,
    pub sheets: Vec<SheetInfo>,
    pub default_col_width: f32,
    pub default_row_height: f32,
    /// Last used cell `[row, col]` of the active sheet, if any.
    pub used_end: Option<(u32, u32)>,
    pub can_undo: bool,
    pub can_redo: bool,
    /// Frozen `[rows, cols]` of the active sheet (`[0, 0]` when nothing is frozen).
    pub freeze: (u32, u32),
    pub gridlines: bool,
}

pub struct Engine {
    session: Session,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

fn hex(c: &Color, wb: &Workbook) -> Option<String> {
    if matches!(c, Color::Auto) {
        return None;
    }
    c.resolve(&wb.theme).map(|[r, g, b]| format!("#{r:02x}{g:02x}{b:02x}"))
}

impl Engine {
    pub fn new() -> Engine {
        let mut session = Session::new();
        session.new_workbook();
        Engine { session }
    }

    fn doc(&self) -> Result<&DocState> {
        Ok(self.session.doc()?)
    }

    /// Replaces the open workbook with `bytes` (XLSX, XLSB, ODS, CSV…, sniffed by content).
    /// Returns the import warnings.
    pub fn open(&mut self, name: &str, bytes: &[u8]) -> Result<Vec<String>> {
        let (wb, warnings) = io::open_bytes(name, bytes)?;
        let title = name.rsplit_once('.').map_or(name, |(stem, _)| stem).to_string();
        let old = self.session.active_index();
        let had_doc = self.session.active().is_some();
        self.session.add_document(DocState::new(wb, None, title));
        if had_doc {
            self.session.close_document(old);
        }
        Ok(warnings)
    }

    /// The workbook as XLSX bytes.
    pub fn save_xlsx(&self) -> Result<Vec<u8>> {
        Ok(io::save_bytes(&self.doc()?.wb, "book.xlsx")?)
    }

    /// Runs any engine command (`cell.set`, `home.bold`, `edit.undo`…) with JSON params.
    pub fn execute(&mut self, id: &str, params: Json) -> Result<Json> {
        if id == PASTE_FORMATS {
            return self.paste_formats(&params);
        }
        let result = self.session.execute_headless(id, params)?;
        let revision = self.doc()?.revision;
        Ok(json!({ "result": result, "revision": revision }))
    }

    /// Paint format: copies `source`'s formats (on sheet `sourceSheet`, default the active one)
    /// onto `target`, as one undo step. Both ranges are explicit, so the result doesn't depend on
    /// the engine's selection or clipboard (neither is shared between collaborators).
    fn paste_formats(&mut self, p: &Json) -> Result<Json> {
        let source = p["source"].as_str().ok_or_else(|| EngineError("paste formats: missing `source`".into()))?;
        let target = p["target"].as_str().ok_or_else(|| EngineError("paste formats: missing `target`".into()))?;
        let active = self.session.active().map_or(0, |d| d.wb.active_sheet);
        let sheet = p["sourceSheet"].as_u64().unwrap_or(active as u64);
        let saved = self.session.clipboard.take();
        let out = (|| -> Result<Json> {
            self.session.execute_headless("edit.copy", json!({ "range": source, "sheet": sheet }))?;
            self.session.execute_headless("sheet.activate", json!({ "sheet": active }))?;
            self.session.execute_headless("selection.set", json!({ "range": target }))?;
            Ok(self.session.execute_headless("edit.pasteSpecial", json!({ "what": "formats" }))?)
        })();
        self.session.clipboard = saved;
        let result = out?;
        let revision = self.doc()?.revision;
        Ok(json!({ "result": result, "revision": revision }))
    }

    pub fn info(&self) -> Result<Info> {
        let d = self.doc()?;
        let wb = &d.wb;
        let sheet = wb.active();
        Ok(Info {
            title: d.title.clone(),
            revision: d.revision,
            active: wb.active_sheet,
            sheets: wb
                .sheets
                .iter()
                .map(|s| SheetInfo {
                    name: s.name.clone(),
                    hidden: s.visibility != Default::default(),
                    color: s.tab_color.as_ref().and_then(|c| hex(c, wb)),
                })
                .collect(),
            default_col_width: sheet.map_or(64.0, |s| s.default_col_width),
            default_row_height: sheet.map_or(20.0, |s| s.default_row_height),
            used_end: sheet.and_then(|s| s.used_range()).map(|r| (r.end.row, r.end.col)),
            can_undo: !d.undo.is_empty(),
            can_redo: !d.redo.is_empty(),
            freeze: sheet.and_then(|s| s.freeze).unwrap_or((0, 0)),
            gridlines: sheet.is_none_or(|s| s.show_gridlines),
        })
    }

    /// What the formula bar shows for a cell: the formula, or the value as typed.
    pub fn edit_text(&self, row: u32, col: u32) -> Result<String> {
        let d = self.doc()?;
        let sheet = d.wb.active().ok_or_else(|| EngineError("no sheet".into()))?;
        Ok(display::edit_text(&d.wb, sheet, CellRef::new(row, col)))
    }

    /// Display text, kind and style for every non-empty cell in `r0..=r1 × c0..=c1` of the active
    /// sheet, plus the line sizes the grid needs to lay that window out.
    pub fn viewport(&self, r0: u32, c0: u32, r1: u32, c1: u32) -> Result<Viewport> {
        let d = self.doc()?;
        let wb = &d.wb;
        let sheet = wb.active().ok_or_else(|| EngineError("no sheet".into()))?;
        let a = CellRef::new(r0, c0);
        let b = CellRef::new(r1, c1);
        if !a.is_valid() || !b.is_valid() {
            return Err(EngineError("viewport outside the sheet".into()));
        }
        let range = RangeRef::new(a, b);
        let rows = u64::from(range.end.row - range.start.row) + 1;
        let cols = u64::from(range.end.col - range.start.col) + 1;
        if rows.saturating_mul(cols) > MAX_VIEWPORT_CELLS {
            return Err(EngineError(format!("viewport larger than {MAX_VIEWPORT_CELLS} cells")));
        }
        let mut cells = Vec::new();
        // Style ids are local to this viewport: each distinct look (cell style plus any
        // conditional format) gets one id, so conditional colours travel like ordinary styles.
        let mut styles: BTreeMap<u32, ViewStyle> = BTreeMap::new();
        let mut ids: BTreeMap<String, u32> = BTreeMap::new();
        let mut cf = CfCache::new();
        let has_cf = !sheet.cond_formats.is_empty();
        // Stored cells, plus the cells a dynamic-array formula spills into (they hold no cell of
        // their own: the anchor's result fills them).
        let mut at: Vec<(CellRef, imbgridly_engine::model::StyleId)> = sheet.cells.iter_range(range).map(|(c, cell)| (c, cell.style)).collect();
        for sr in sheet.spill_ranges.values() {
            if sr.start.row > range.end.row || sr.end.row < range.start.row || sr.start.col > range.end.col || sr.end.col < range.start.col {
                continue;
            }
            for r in sr.start.row.max(range.start.row)..=sr.end.row.min(range.end.row) {
                for col in sr.start.col.max(range.start.col)..=sr.end.col.min(range.end.col) {
                    let c = CellRef::new(r, col);
                    if sheet.cells.get(c).is_none() {
                        at.push((c, sheet.style_id(c)));
                    }
                }
            }
        }
        for (c, style_id) in at {
            let kind = match sheet.value(c) {
                Value::Empty => {
                    if style_id.0 == 0 {
                        continue;
                    }
                    's'
                }
                Value::Number(_) => 'n',
                Value::Text(_) => 's',
                Value::Bool(_) => 'b',
                Value::Error(_) => 'e',
                Value::Array(_) => 's',
            };
            let look = if has_cf { cf.look(wb, wb.active_sheet, c) } else { None };
            let mut vs = view_style(wb.styles.get(style_id), wb);
            if let Some(look) = &look {
                apply_look(&mut vs, look, wb);
            }
            let style = if vs == ViewStyle::default_for(wb) {
                0
            } else {
                let key = serde_json::to_string(&vs).unwrap_or_default();
                let next = ids.len() as u32 + 1;
                let id = *ids.entry(key).or_insert(next);
                styles.entry(id).or_insert(vs);
                id
            };
            cells.push(ViewCell(c.row, c.col, display::cell_text(wb, sheet, c), kind, style));
        }
        let merges = sheet
            .merges
            .iter()
            .filter(|m| m.start.row <= range.end.row && m.end.row >= range.start.row && m.start.col <= range.end.col && m.end.col >= range.start.col)
            .map(|m| [m.start.row, m.start.col, m.end.row, m.end.col])
            .collect();
        let filter = sheet.autofilter.as_ref().map(|af| ViewFilter {
            range: [af.range.start.row, af.range.start.col, af.range.end.row, af.range.end.col],
            active: af.criteria.iter().map(|(col, _)| *col).collect(),
        });
        Ok(Viewport {
            revision: d.revision,
            sheet: wb.active_sheet,
            cells,
            styles,
            col_widths: (range.start.col..=range.end.col).map(|c| sheet.col_width(c)).collect(),
            row_heights: (range.start.row..=range.end.row).map(|r| sheet.row_height(r)).collect(),
            merges,
            filter,
        })
    }
}

impl ViewStyle {
    /// What a cell with the default style looks like (painted without a style entry).
    fn default_for(wb: &Workbook) -> ViewStyle {
        view_style(&Style::default(), wb)
    }
}

fn border(line: &BorderLine, wb: &Workbook) -> Option<ViewBorder> {
    if line.is_none() {
        return None;
    }
    let k = match line.style {
        BorderStyle::Dashed | BorderStyle::MediumDashed | BorderStyle::DashDot | BorderStyle::MediumDashDot | BorderStyle::DashDotDot => 'd',
        BorderStyle::MediumDashDotDot | BorderStyle::SlantDashDot => 'd',
        BorderStyle::Dotted | BorderStyle::Hair => 'o',
        BorderStyle::Double => '=',
        _ => 's',
    };
    Some(ViewBorder { w: line.style.width() as u8, k, color: hex(&line.color, wb).unwrap_or_else(|| "#000000".into()) })
}

fn view_style(st: &Style, wb: &Workbook) -> ViewStyle {
    let fill = if st.fill.fg != Color::Auto && st.fill.pattern != Default::default() { hex(&st.fill.fg, wb) } else { None };
    let fmt = st.num_fmt.0.as_ref();
    ViewStyle {
        b: st.font.bold,
        i: st.font.italic,
        u: st.font.underline != Underline::None,
        s: st.font.strike,
        color: hex(&st.font.color, wb),
        fill,
        h: match st.align.h {
            HAlign::Left => Some('l'),
            HAlign::Center | HAlign::CenterAcross => Some('c'),
            HAlign::Right => Some('r'),
            _ => None,
        },
        v: match st.align.v {
            VAlign::Top => Some('t'),
            VAlign::Center | VAlign::Justify | VAlign::Distributed => Some('m'),
            VAlign::Bottom => None,
        },
        wrap: st.align.wrap,
        indent: st.align.indent,
        rot: if (-90..=90).contains(&st.align.rotation) { st.align.rotation } else { 0 },
        va: match st.font.vert {
            VertAlign::Superscript => Some('p'),
            VertAlign::Subscript => Some('b'),
            VertAlign::Baseline => None,
        },
        font: (st.font.name != imbgridly_engine::model::DEFAULT_FONT && !st.font.name.is_empty()).then(|| st.font.name.clone()),
        size: st.font.size,
        fmt: (!fmt.is_empty() && !fmt.eq_ignore_ascii_case("General")).then(|| fmt.to_string()),
        bt: border(&st.borders.top, wb),
        br: border(&st.borders.right, wb),
        bb: border(&st.borders.bottom, wb),
        bl: border(&st.borders.left, wb),
        bar: None,
        icon: None,
        hide: false,
    }
}

/// Layers a conditional format's look over the cell's own style.
fn apply_look(vs: &mut ViewStyle, look: &imbgridly_engine::cf::CfLook, wb: &Workbook) {
    let rgb = |[r, g, b]: [u8; 3]| format!("#{r:02x}{g:02x}{b:02x}");
    if let Some(st) = &look.style {
        let base = Style::default();
        if st.font.bold != base.font.bold {
            vs.b = st.font.bold;
        }
        if st.font.italic != base.font.italic {
            vs.i = st.font.italic;
        }
        if st.font.underline != base.font.underline {
            vs.u = true;
        }
        if st.font.strike != base.font.strike {
            vs.s = st.font.strike;
        }
        if let Some(c) = hex(&st.font.color, wb) {
            vs.color = Some(c);
        }
        if st.fill.fg != Color::Auto {
            vs.fill = hex(&st.fill.fg, wb);
        } else if st.fill.bg != Color::Auto {
            vs.fill = hex(&st.fill.bg, wb);
        }
        for (dst, src) in [(&mut vs.bt, &st.borders.top), (&mut vs.br, &st.borders.right), (&mut vs.bb, &st.borders.bottom), (&mut vs.bl, &st.borders.left)] {
            if let Some(b) = border(src, wb) {
                *dst = Some(b);
            }
        }
    }
    if let Some(f) = look.scale_fill {
        vs.fill = Some(rgb(f));
    }
    if let Some((frac, color, _)) = look.bar {
        vs.bar = Some((frac.clamp(0.0, 1.0), rgb(color)));
    }
    vs.icon.clone_from(&look.icon);
    vs.hide = look.hide_value;
}

fn to_json<T: Serialize>(v: &T) -> Result<String> {
    serde_json::to_string(v).map_err(|e| EngineError(e.to_string()))
}

/// String-typed wrappers: what the wasm boundary exposes (and what native tests exercise).
impl Engine {
    pub fn execute_json(&mut self, id: &str, params: &str) -> Result<String> {
        let params: Json = if params.trim().is_empty() { json!({}) } else { serde_json::from_str(params).map_err(|e| EngineError(format!("bad params: {e}")))? };
        to_json(&self.execute(id, params)?)
    }
    pub fn info_json(&self) -> Result<String> {
        to_json(&self.info()?)
    }
    pub fn viewport_json(&self, r0: u32, c0: u32, r1: u32, c1: u32) -> Result<String> {
        to_json(&self.viewport(r0, c0, r1, c1)?)
    }
    pub fn open_json(&mut self, name: &str, bytes: &[u8]) -> Result<String> {
        to_json(&self.open(name, bytes)?)
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::Engine;
    use wasm_bindgen::prelude::*;

    fn err(e: super::EngineError) -> JsError {
        JsError::new(&e.0)
    }

    #[wasm_bindgen(js_name = SheetsEngine)]
    pub struct WasmEngine(Engine);

    #[wasm_bindgen(js_class = SheetsEngine)]
    impl WasmEngine {
        #[wasm_bindgen(constructor)]
        pub fn new() -> WasmEngine {
            WasmEngine(Engine::new())
        }
        pub fn execute(&mut self, id: &str, params: &str) -> Result<String, JsError> {
            self.0.execute_json(id, params).map_err(err)
        }
        pub fn info(&self) -> Result<String, JsError> {
            self.0.info_json().map_err(err)
        }
        pub fn viewport(&self, r0: u32, c0: u32, r1: u32, c1: u32) -> Result<String, JsError> {
            self.0.viewport_json(r0, c0, r1, c1).map_err(err)
        }
        #[wasm_bindgen(js_name = editText)]
        pub fn edit_text(&self, row: u32, col: u32) -> Result<String, JsError> {
            self.0.edit_text(row, col).map_err(err)
        }
        pub fn open(&mut self, name: &str, bytes: &[u8]) -> Result<String, JsError> {
            self.0.open_json(name, bytes).map_err(err)
        }
        #[wasm_bindgen(js_name = saveXlsx)]
        pub fn save_xlsx(&self) -> Result<Vec<u8>, JsError> {
            self.0.save_xlsx().map_err(err)
        }
    }

    impl Default for WasmEngine {
        fn default() -> Self {
            Self::new()
        }
    }

    #[wasm_bindgen(js_class = SheetsEngine)]
    impl WasmEngine {
        /// Replaces the workbook with a blank one.
        pub fn reset(&mut self) {
            self.0 = Engine::new();
        }
    }

    fn json<T: serde::Serialize>(v: &T) -> Result<String, JsError> {
        serde_json::to_string(v).map_err(|e| JsError::new(&e.to_string()))
    }

    fn parse<T: serde::de::DeserializeOwned>(s: &str) -> Result<T, JsError> {
        serde_json::from_str(s).map_err(|e| JsError::new(&format!("bad message: {e}")))
    }

    /// A shared workbook's replica (see `collab`): local edits are applied at once and returned for
    /// sending; the server's ops are rebased under them.
    #[wasm_bindgen(js_name = SheetsReplica)]
    pub struct WasmReplica(super::collab::Replica);

    #[wasm_bindgen(js_class = SheetsReplica)]
    impl WasmReplica {
        #[wasm_bindgen(constructor)]
        pub fn new(sid: &str, snapshot: &[u8], seq: u64) -> Result<WasmReplica, JsError> {
            super::collab::Replica::from_snapshot(sid, snapshot, seq).map(WasmReplica).map_err(err)
        }
        /// The user ran a command: returns an Outcome (`send` = the op to transmit).
        pub fn local(&mut self, id: &str, params: &str) -> Result<String, JsError> {
            let params = if params.trim().is_empty() { serde_json::json!({}) } else { parse(params)? };
            json(&self.0.local(id, params).map_err(err)?)
        }
        /// An op from the server.
        pub fn remote(&mut self, op: &str) -> Result<String, JsError> {
            json(&self.0.remote(&parse(op)?).map_err(err)?)
        }
        pub fn rejected(&mut self, cid: u64) -> Result<String, JsError> {
            json(&self.0.rejected(cid).map_err(err)?)
        }
        /// Reloads the server's state; returns the ops to resend.
        pub fn resync(&mut self, snapshot: &[u8], seq: u64, acked: u64) -> Result<String, JsError> {
            json(&self.0.resync(snapshot, seq, acked).map_err(err)?)
        }
        pub fn seq(&self) -> u64 {
            self.0.seq
        }
        pub fn info(&self) -> Result<String, JsError> {
            self.0.engine.info_json().map_err(err)
        }
        pub fn viewport(&self, r0: u32, c0: u32, r1: u32, c1: u32) -> Result<String, JsError> {
            self.0.engine.viewport_json(r0, c0, r1, c1).map_err(err)
        }
        #[wasm_bindgen(js_name = editText)]
        pub fn edit_text(&self, row: u32, col: u32) -> Result<String, JsError> {
            self.0.engine.edit_text(row, col).map_err(err)
        }
        #[wasm_bindgen(js_name = saveXlsx)]
        pub fn save_xlsx(&self) -> Result<Vec<u8>, JsError> {
            self.0.engine.save_xlsx().map_err(err)
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn set(e: &mut Engine, cell: &str, input: &str) {
        e.execute("cell.set", json!({"cell": cell, "input": input})).unwrap();
    }

    #[test]
    fn formulas_recalculate_through_dependents() {
        let mut e = Engine::new();
        set(&mut e, "A1", "2");
        set(&mut e, "A2", "3");
        set(&mut e, "A3", "=SUM(A1:A2)*10");
        set(&mut e, "B1", "=A3+1");
        let v = e.viewport(0, 0, 2, 1).unwrap();
        let text = |r, c| v.cells.iter().find(|x| x.0 == r && x.1 == c).map(|x| x.2.clone());
        assert_eq!(text(2, 0).as_deref(), Some("50"));
        assert_eq!(text(0, 1).as_deref(), Some("51"));
        set(&mut e, "A1", "7");
        let v = e.viewport(0, 0, 2, 1).unwrap();
        assert!(v.cells.contains(&ViewCell(0, 1, "101".into(), 'n', 0)));
        assert_eq!(e.edit_text(2, 0).unwrap(), "=SUM(A1:A2)*10");
    }

    #[test]
    fn viewport_reports_only_painted_cells_and_line_sizes() {
        let mut e = Engine::new();
        set(&mut e, "C5", "hello");
        let v = e.viewport(0, 0, 9, 4).unwrap();
        assert_eq!(v.cells, vec![ViewCell(4, 2, "hello".into(), 's', 0)]);
        assert_eq!(v.col_widths.len(), 5);
        assert_eq!(v.row_heights.len(), 10);
    }

    #[test]
    fn styles_travel_with_cells() {
        let mut e = Engine::new();
        set(&mut e, "A1", "Total");
        e.execute("home.bold", json!({"range": "A1"})).unwrap();
        let v = e.viewport(0, 0, 0, 0).unwrap();
        let style = v.cells.first().unwrap().4;
        assert_ne!(style, 0);
        assert!(v.styles.get(&style).unwrap().b);
    }

    #[test]
    fn undo_and_redo_restore_values() {
        let mut e = Engine::new();
        set(&mut e, "A1", "1");
        set(&mut e, "A1", "2");
        e.execute("edit.undo", json!({})).unwrap();
        assert_eq!(e.edit_text(0, 0).unwrap(), "1");
        e.execute("edit.redo", json!({})).unwrap();
        assert_eq!(e.edit_text(0, 0).unwrap(), "2");
        assert!(e.info().unwrap().can_undo);
    }

    #[test]
    fn xlsx_round_trip_keeps_formulas() {
        let mut e = Engine::new();
        set(&mut e, "A1", "4");
        set(&mut e, "A2", "=A1^2");
        let bytes = e.save_xlsx().unwrap();
        let mut f = Engine::new();
        f.open("round.xlsx", &bytes).unwrap();
        assert_eq!(f.edit_text(1, 0).unwrap(), "=A1^2");
        assert!(f.viewport(1, 0, 1, 0).unwrap().cells.contains(&ViewCell(1, 0, "16".into(), 'n', 0)));
        assert_eq!(f.info().unwrap().title, "round");
    }

    #[test]
    fn hostile_input_is_an_error_not_a_crash() {
        let mut e = Engine::new();
        assert!(e.viewport(0, 0, 1_048_575, 16_383).is_err());
        assert!(e.viewport(0, 0, 5_000_000, 0).is_err());
        assert!(e.execute_json("no.such.command", "{}").is_err());
        assert!(e.execute_json("cell.set", "{not json").is_err());
        // Unrecognised bytes are opened leniently (as text) or rejected; either way, no crash.
        let _ = e.open("x.xlsx", b"garbage");
        let _ = e.open("x.xlsx", b"PK\x03\x04truncated");
        // The session still works afterwards.
        set(&mut e, "A1", "ok");
        assert_eq!(e.edit_text(0, 0).unwrap(), "ok");
    }

    #[test]
    fn json_surface_round_trips() {
        let mut e = Engine::new();
        let r: Json = serde_json::from_str(&e.execute_json("cell.set", r#"{"cell":"B2","input":"=1+1"}"#).unwrap()).unwrap();
        assert!(r["revision"].as_u64().unwrap() > 1);
        let info: Json = serde_json::from_str(&e.info_json().unwrap()).unwrap();
        assert_eq!(info["used_end"], json!([1, 1]));
        let vp: Json = serde_json::from_str(&e.viewport_json(1, 1, 1, 1).unwrap()).unwrap();
        assert_eq!(vp["cells"], json!([[1, 1, "2", "n", 0]]));
    }

    #[test]
    fn viewport_carries_borders_merges_formats_freeze_and_conditional_colours() {
        let mut e = Engine::new();
        set(&mut e, "A1", "1234.5");
        set(&mut e, "B1", "5");
        set(&mut e, "B2", "50");
        e.execute("home.borders", json!({"range": "A1", "preset": "all"})).unwrap();
        e.execute("home.numberFormat", json!({"range": "A1", "format": "Currency"})).unwrap();
        e.execute("home.fillColor", json!({"range": "A1", "color": "#FFFF00"})).unwrap();
        e.execute("home.wrapText", json!({"range": "A1"})).unwrap();
        e.execute("home.alignMiddle", json!({"range": "A1"})).unwrap();
        e.execute("home.fontName", json!({"range": "A1", "name": "Georgia"})).unwrap();
        e.execute("home.mergeCells", json!({"range": "C1:D2"})).unwrap();
        e.execute("view.freezePanes", json!({"cell": "B2"})).unwrap();
        e.execute("data.filter", json!({"range": "A1:B2"})).unwrap();
        e.execute(
            "home.conditionalFormat",
            json!({"range": "B1:B2", "rule": {"type": "cellIs", "operator": "greater", "value": "10", "fill": "#FF0000"}}),
        )
        .unwrap();
        let v = e.viewport(0, 0, 5, 5).unwrap();
        let st = |cell: (u32, u32)| {
            let c = v.cells.iter().find(|c| (c.0, c.1) == cell).unwrap();
            v.styles.get(&c.4)
        };
        let a1 = st((0, 0)).unwrap();
        assert_eq!(a1.bt.as_ref().map(|b| b.w), Some(1));
        assert!(a1.bl.is_some() && a1.bb.is_some() && a1.br.is_some());
        assert!(a1.fmt.is_some(), "{a1:?}");
        assert_eq!(a1.fill.as_deref(), Some("#ffff00"));
        assert!(a1.wrap);
        assert_eq!(a1.v, Some('m'));
        assert_eq!(a1.font.as_deref(), Some("Georgia"));
        assert!(v.cells.iter().any(|c| (c.0, c.1) == (0, 0) && c.2.contains('$')));
        assert_eq!(v.merges, vec![[0, 2, 1, 3]]);
        assert_eq!(v.filter.as_ref().map(|f| f.range), Some([0, 0, 1, 1]));
        // B2 = 50 matches the rule; B1 = 5 doesn't.
        assert!(st((1, 1)).and_then(|s| s.fill.clone()).is_some(), "{:?}", st((1, 1)));
        assert!(st((0, 1)).and_then(|s| s.fill.clone()).is_none());
        assert_eq!(e.info().unwrap().freeze, (1, 1));
    }

    #[test]
    fn spilled_results_are_painted() {
        let mut e = Engine::new();
        set(&mut e, "A1", "3");
        set(&mut e, "A2", "1");
        set(&mut e, "A3", "2");
        set(&mut e, "B1", "=SORT(A1:A3)");
        let v = e.viewport(0, 0, 5, 5).unwrap();
        let text = |r, c| v.cells.iter().find(|x| (x.0, x.1) == (r, c)).map(|x| x.2.clone());
        assert_eq!(text(0, 1).as_deref(), Some("1"));
        assert_eq!(text(1, 1).as_deref(), Some("2"));
        assert_eq!(text(2, 1).as_deref(), Some("3"));
    }

    #[test]
    fn filter_conditions_the_menu_sends() {
        let shown = |crit: Json| {
            let mut e = Engine::new();
            e.execute("range.setValues", json!({"range": "A1", "values": [["k"], ["apple"], ["pear"], ["pineapple"], [7], [12]]})).unwrap();
            e.execute("data.filter", json!({"range": "A1:A6"})).unwrap();
            let mut p = json!({"column": "A"});
            p.as_object_mut().unwrap().extend(crit.as_object().unwrap().clone());
            e.execute("data.filterBy", p).unwrap();
            let v = e.viewport(1, 0, 5, 0).unwrap();
            v.row_heights.iter().map(|h| *h > 0.0).collect::<Vec<_>>()
        };
        assert_eq!(shown(json!({"custom": {"op": "=", "value": "*apple*"}})), [true, false, true, false, false]);
        assert_eq!(shown(json!({"custom": {"op": "<>", "value": "*apple*"}})), [false, true, false, true, true]);
        assert_eq!(shown(json!({"custom": {"op": "=", "value": "p*"}})), [false, true, true, false, false]);
        assert_eq!(shown(json!({"custom": {"op": ">", "value": "10"}})), [false, false, false, false, true]);
        assert_eq!(shown(json!({"custom": {"op": "<>", "value": ""}})), [true, true, true, true, true]);
        assert_eq!(shown(json!({"values": [], "blanks": true})), [false, false, false, false, false]);
    }

    #[test]
    fn paste_formats_copies_formats_between_explicit_ranges() {
        let mut e = Engine::new();
        set(&mut e, "A1", "1");
        set(&mut e, "C3", "2");
        e.execute("home.bold", json!({"range": "A1", "on": true})).unwrap();
        e.execute("home.fillColor", json!({"range": "A1", "color": "#FFFF00"})).unwrap();
        let before = e.info().unwrap().revision;
        e.execute(PASTE_FORMATS, json!({"source": "A1", "target": "C3:D4"})).unwrap();
        assert_eq!(e.info().unwrap().revision, before + 1, "one undo step");
        let v = e.viewport(2, 2, 3, 3).unwrap();
        let st = v.styles.get(&v.cells.iter().find(|c| (c.0, c.1) == (2, 2)).unwrap().4).unwrap();
        assert!(st.b && st.fill.as_deref() == Some("#ffff00"));
        assert_eq!(v.cells.iter().find(|c| (c.0, c.1) == (2, 2)).unwrap().2, "2", "values stay");
        assert!(v.cells.iter().any(|c| (c.0, c.1) == (3, 3)));
        e.execute("edit.undo", json!({})).unwrap();
        let v = e.viewport(2, 2, 2, 2).unwrap();
        assert_eq!(v.cells[0].4, 0);
    }
}
