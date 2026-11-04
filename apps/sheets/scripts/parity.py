"""Recomputes the "Today's score" table in PARITY.md from its checklist rows.

    python scripts/parity.py                  # print the scores
    python scripts/parity.py --write DATE     # also rewrite the table, its heading and the overall line
    python scripts/parity.py --done 2.3 2.4   # flip rows to `done` first (combine with --write)
"""

import argparse
import re
import sys
from pathlib import Path

DOC = Path(__file__).resolve().parent.parent / "PARITY.md"
ROW = re.compile(r"^\| (\d+)\.(\d+) \| (.*?) \| `(done|engine|missing)` \|", re.M)
CATEGORY = re.compile(r"^\| (\d+) \| ([^|]+?) \| (\d+) \|", re.M)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--done", nargs="*", default=[], help="row ids to mark done, e.g. 2.3")
    ap.add_argument("--write", metavar="DATE", help="rewrite the score table, dated DATE")
    args = ap.parse_args()
    text = DOC.read_text(encoding="utf-8")

    for rid in args.done:
        pat = re.compile(rf"^(\| {re.escape(rid)} \| .*? \| )`(?:engine|missing)`", re.M)
        text, n = pat.subn(r"\1`done`", text)
        if n == 0 and not re.search(rf"^\| {re.escape(rid)} \| .*? \| `done`", text, re.M):
            sys.exit(f"row {rid} not found")

    table_start = text.index("## Today's score")
    table_end = text.index("**Overall:", table_start)
    cats = {int(m[1]): (m[2].strip(), int(m[3])) for m in CATEGORY.finditer(text[table_start:table_end])}
    counts = {c: {"done": 0, "engine": 0, "missing": 0} for c in cats}
    for m in ROW.finditer(text):
        c = int(m[1])
        if c in counts:
            counts[c][m[4]] += 1

    lines = [
        "| # | Category | Weight | Items | done | engine | missing | Category % | Weighted points | Reachable % |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    total = {"items": 0, "done": 0, "engine": 0, "missing": 0, "points": 0.0, "reach": 0.0}
    for c, (name, weight) in sorted(cats.items()):
        k = counts[c]
        items = sum(k.values())
        pct = k["done"] / items if items else 0
        reach = (k["done"] + k["engine"]) / items if items else 0
        points = weight * pct
        total["items"] += items
        for s in ("done", "engine", "missing"):
            total[s] += k[s]
        total["points"] += points
        total["reach"] += weight * reach
        lines.append(
            f"| {c} | {name} | {weight} | {items} | {k['done']} | {k['engine']} | {k['missing']} | "
            f"{pct * 100:.1f}% | {points:.2f} | {reach * 100:.1f}% |"
        )
    lines.append(
        f"| | **Total** | **100** | **{total['items']}** | **{total['done']}** | **{total['engine']}** | "
        f"**{total['missing']}** | | **{total['points']:.1f}** | **{total['reach']:.1f}** |"
    )
    table = "\n".join(lines)
    print(table)
    print(f"\nOverall {total['points']:.1f}% | reachable {total['reach']:.1f}%")

    if args.write:
        head = text.index("| # | Category |", table_start)
        tail = text.index("\n\n", text.index("| | **Total**", head))
        text = text[:head] + table + text[tail:]
        text = re.sub(r"## Today's score \([^)]*\)", f"## Today's score ({args.write})", text)
        text = re.sub(
            r"\*\*Overall: [\d.]+% of Google Sheets\*\* \(reachable with UI work alone on the existing engine: [\d.]+%\)",
            f"**Overall: {total['points']:.1f}% of Google Sheets** (reachable with UI work alone on the existing engine: "
            f"{total['reach']:.1f}%)",
            text,
        )
    if args.write or args.done:
        DOC.write_text(text, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
