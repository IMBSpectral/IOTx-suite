// One grid axis (rows or columns): a default line size plus sparse overrides, so a million rows
// cost nothing until one of them is resized. Offsets are computed from the overrides alone.

export class Axis {
  private sizes = new Map<number, number>();
  private keys: number[] = [];
  private prefix: number[] = [0]; // prefix[i] = sum of (size - default) for keys[0..i)

  constructor(
    public defaultSize: number,
    public count: number,
  ) {}

  size(i: number): number {
    return this.sizes.get(i) ?? this.defaultSize;
  }

  /** Records line sizes reported for `start..start+sizes.length`. Returns true when anything changed. */
  apply(start: number, sizes: number[]): boolean {
    let changed = false;
    sizes.forEach((s, k) => {
      const i = start + k;
      const old = this.size(i);
      if (s === this.defaultSize) {
        if (this.sizes.delete(i)) changed = true;
      } else if (old !== s) {
        this.sizes.set(i, s);
        changed = true;
      }
    });
    if (changed) this.rebuild();
    return changed;
  }

  setDefault(size: number): void {
    if (size !== this.defaultSize) {
      this.defaultSize = size;
      this.rebuild();
    }
  }

  private rebuild(): void {
    this.keys = [...this.sizes.keys()].sort((a, b) => a - b);
    this.prefix = [0];
    for (const k of this.keys) this.prefix.push(this.prefix[this.prefix.length - 1] + (this.size(k) - this.defaultSize));
  }

  /** Number of override keys below `i`. */
  private rank(i: number): number {
    let lo = 0;
    let hi = this.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.keys[mid] < i) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Pixel offset of line `i`'s leading edge. */
  offset(i: number): number {
    return i * this.defaultSize + this.prefix[this.rank(i)];
  }

  total(): number {
    return this.offset(this.count);
  }

  /** Index of the line containing pixel `px` (clamped to the axis). */
  indexAt(px: number): number {
    if (px <= 0) return 0;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offset(mid) <= px) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

export function colName(c: number): string {
  let s = "";
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function a1(row: number, col: number): string {
  return `${colName(col)}${row + 1}`;
}

export interface Range {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export function normalize(a: { row: number; col: number }, b: { row: number; col: number }): Range {
  return { r0: Math.min(a.row, b.row), c0: Math.min(a.col, b.col), r1: Math.max(a.row, b.row), c1: Math.max(a.col, b.col) };
}

export function rangeA1(r: Range): string {
  const s = a1(r.r0, r.c0);
  return r.r0 === r.r1 && r.c0 === r.c1 ? s : `${s}:${a1(r.r1, r.c1)}`;
}

/** Parses `B7` or `A1:C3` (case-insensitive). Returns null for anything else. */
export function parseRange(s: string): Range | null {
  const m = /^([A-Za-z]{1,3})([0-9]{1,7})(?::([A-Za-z]{1,3})([0-9]{1,7}))?$/.exec(s.trim());
  if (!m) return null;
  const col = (t: string) => [...t.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const a = { row: Number(m[2]) - 1, col: col(m[1]) };
  const b = m[3] ? { row: Number(m[4]) - 1, col: col(m[3]) } : a;
  if (a.row < 0 || b.row < 0) return null;
  return normalize(a, b);
}
