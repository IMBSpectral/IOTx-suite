import { describe, expect, it } from "vitest";
import { a1, Axis, colName, normalize, rangeA1 } from "../../src/grid/axis";

describe("Axis", () => {
  it("lays out default lines without storing them", () => {
    const ax = new Axis(20, 1_048_576);
    expect(ax.offset(0)).toBe(0);
    expect(ax.offset(10)).toBe(200);
    expect(ax.total()).toBe(20 * 1_048_576);
    expect(ax.indexAt(199)).toBe(9);
    expect(ax.indexAt(200)).toBe(10);
    expect(ax.indexAt(-5)).toBe(0);
    expect(ax.indexAt(1e12)).toBe(1_048_575);
  });

  it("shifts later lines by overridden sizes", () => {
    const ax = new Axis(64, 100);
    expect(ax.apply(2, [100, 64, 0])).toBe(true);
    expect(ax.size(2)).toBe(100);
    expect(ax.size(4)).toBe(0);
    expect(ax.offset(3)).toBe(64 * 3 + 36);
    expect(ax.offset(5)).toBe(64 * 5 + 36 - 64);
    expect(ax.indexAt(64 * 2 + 99)).toBe(2);
    expect(ax.indexAt(64 * 2 + 100)).toBe(3);
    // Hidden column 4 is skipped by hit-testing.
    expect(ax.indexAt(ax.offset(5))).toBe(5);
    expect(ax.apply(2, [100])).toBe(false);
    expect(ax.apply(2, [64])).toBe(true);
    expect(ax.offset(3)).toBe(64 * 3);
  });
});

describe("addresses", () => {
  it("names columns like a spreadsheet", () => {
    expect(colName(0)).toBe("A");
    expect(colName(25)).toBe("Z");
    expect(colName(26)).toBe("AA");
    expect(colName(701)).toBe("ZZ");
    expect(colName(702)).toBe("AAA");
    expect(colName(16383)).toBe("XFD");
    expect(a1(0, 0)).toBe("A1");
  });

  it("normalizes and prints ranges", () => {
    const r = normalize({ row: 4, col: 3 }, { row: 1, col: 0 });
    expect(r).toEqual({ r0: 1, c0: 0, r1: 4, c1: 3 });
    expect(rangeA1(r)).toBe("A2:D5");
    expect(rangeA1({ r0: 2, c0: 2, r1: 2, c1: 2 })).toBe("C3");
  });
});

import { sameText } from "../../src/grid/grid";

describe("sameText", () => {
  it("ignores line-ending style and trailing newlines", () => {
    expect(sameText("5\r\n10\r\n", "5\n10")).toBe(true);
    expect(sameText("a\tb\rc", "a\tb\nc")).toBe(true);
    expect(sameText("5\n10", "5\n11")).toBe(false);
  });
});

import { parseRange } from "../../src/grid/axis";

describe("parseRange", () => {
  it("reads cells and ranges and rejects the rest", () => {
    expect(parseRange("b7")).toEqual({ r0: 6, c0: 1, r1: 6, c1: 1 });
    expect(parseRange("C3:A1")).toEqual({ r0: 0, c0: 0, r1: 2, c1: 2 });
    expect(parseRange("XFD1048576")).toEqual({ r0: 1048575, c0: 16383, r1: 1048575, c1: 16383 });
    expect(parseRange("A0")).toBeNull();
    expect(parseRange("Sheet1!A1")).toBeNull();
    expect(parseRange("")).toBeNull();
  });
});
