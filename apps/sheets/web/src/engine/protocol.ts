// Shapes that cross the worker boundary. They mirror engine-wasm's serde output.

/** `[row, col, text, kind, style]`; kind: n number, s text, b boolean, e error. */
export type ViewCell = [number, number, string, "n" | "s" | "b" | "e", number];

/** One border edge: width 1-3 px, kind (s solid, d dashed, o dotted, = double), colour. */
export interface ViewBorder {
  w: number;
  k: "s" | "d" | "o" | "=";
  color: string;
}

/** A cell's look. Ids are local to one viewport (they include conditional formatting). */
export interface ViewStyle {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  color?: string;
  fill?: string;
  h?: "l" | "c" | "r";
  /** t top, m middle; absent = bottom. */
  v?: "t" | "m";
  wrap?: boolean;
  indent?: number;
  rot?: number;
  /** p superscript, b subscript. */
  va?: "p" | "b";
  /** Font family when not the default (Calibri). */
  font?: string;
  size: number;
  /** Number format code when not General (the text is already formatted). */
  fmt?: string;
  bt?: ViewBorder;
  br?: ViewBorder;
  bb?: ViewBorder;
  bl?: ViewBorder;
  /** Conditional data bar: [fraction 0-1, colour]. */
  bar?: [number, string];
  /** Conditional icon: [set name, index]. */
  icon?: [string, number];
  /** Conditional format hides the value. */
  hide?: boolean;
}

export interface Viewport {
  revision: number;
  sheet: number;
  cells: ViewCell[];
  styles: Record<string, ViewStyle>;
  col_widths: number[];
  row_heights: number[];
  /** Merged areas touching the window: [r0, c0, r1, c1]. */
  merges: [number, number, number, number][];
  /** AutoFilter range and the column offsets that have criteria. */
  filter?: { range: [number, number, number, number]; active: number[] };
}

export interface SheetInfo {
  name: string;
  hidden: boolean;
  /** Tab colour. */
  color?: string;
}

export interface Info {
  title: string;
  revision: number;
  active: number;
  sheets: SheetInfo[];
  default_col_width: number;
  default_row_height: number;
  used_end: [number, number] | null;
  can_undo: boolean;
  can_redo: boolean;
  /** Frozen [rows, cols] of the active sheet. */
  freeze: [number, number];
  gridlines: boolean;
}

export interface ExecResult {
  result: unknown;
  revision: number;
  /** Shared mode: an op to send to the server. */
  send?: Submit;
  /** Shared mode: this replica must reload the server's state. */
  resync?: boolean;
  /** Shared mode: our ops that no longer applied after someone else's edit. */
  dropped?: number[];
  /** Shared mode: our ops the server hasn't confirmed yet. */
  pending?: number;
}

export interface Step {
  cmd: string;
  params: unknown;
}

/** An op this client sends. */
export interface Submit {
  cid: number;
  sheet: number;
  steps: Step[];
}

/** An op the server ordered. */
export interface Op extends Submit {
  seq: number;
  sid: string;
}

/** Requests the page sends; each maps to one SheetsEngine method. */
export type Request =
  | { op: "info" }
  | { op: "viewport"; r0: number; c0: number; r1: number; c1: number }
  | { op: "editText"; row: number; col: number }
  | { op: "execute"; id: string; params: unknown }
  | { op: "open"; name: string; bytes: Uint8Array }
  | { op: "saveXlsx" }
  | { op: "reset" }
  // Shared mode.
  | { op: "join"; sid: string; snapshot: Uint8Array; seq: number }
  | { op: "remote"; message: Op }
  | { op: "rejected"; cid: number }
  | { op: "resync"; snapshot: Uint8Array; seq: number; acked: number }
  | { op: "unshare" };

export interface Envelope {
  seq: number;
  req: Request;
}

export type Reply = { seq: number; ok: true; value: unknown } | { seq: number; ok: false; error: string };
