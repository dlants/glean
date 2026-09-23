import { describe, expect, it } from "vitest";
import type { DiffLine, Hunk } from "../core/diff.ts";
import {
  type GutterMarks,
  type GutterSource,
  hunkRange,
  hunkStarts,
  nextHunkRow,
  project,
} from "./project.ts";

/** " " context, "+" add, "-" del, starting at post-image line `start`. */
function hunk(start: number, spec: readonly string[]): Hunk {
  const lines: DiffLine[] = [];
  let n = start;
  let o = start;
  for (const s of spec) {
    const text = s.slice(1);
    if (s[0] === "+") lines.push({ kind: "add", text, newLnum: n++ });
    else if (s[0] === "-")
      lines.push({ kind: "del", text, oldLnum: o++, newLnum: n });
    else lines.push({ kind: "context", text, oldLnum: o++, newLnum: n++ });
  }
  return {
    oldStart: start,
    oldCount: 0,
    newStart: start,
    newCount: 0,
    header: "",
    lines,
  };
}
const unseen = () => false;

function dump(marks: GutterMarks): string {
  return [...marks]
    .sort(([a], [b]) => a - b)
    .map(([l, m]) => {
      const kind = m.kind === "del" ? "-" : m.kind;
      return `${l}:${kind}${m.delAbove ? "^" : ""}${m.delBelow ? "v" : ""}${m.seen ? "S" : ""}`;
    })
    .join(" ");
}
/** 1-based "hunk.li", matching the Lua test's expectations. */
const srcs = (marks: GutterMarks, l: number) =>
  (marks.get(l)?.sources ?? [])
    .map((s) => `${s.hunk + 1}.${s.li + 1}`)
    .join(" ");

describe("gutter project", () => {
  it("pure add", () => {
    expect(dump(project([hunk(1, [" a", "+b", "+c", " d"])], unseen))).toBe(
      "2:add 3:add",
    );
  });
  it("interior context is connective tissue", () => {
    const m = project([hunk(1, [" a", "+b", " c", "+d", " e"])], unseen);
    expect(dump(m)).toBe("2:add 3:contextS 4:add");
    expect(hunkStarts(m)).toEqual([2]);
    expect(m.get(3)?.sources).toEqual([]);
  });
  it("similar del+add is a change", () => {
    expect(
      dump(
        project(
          [hunk(1, [" a", "-local x = 1", "+local x = 2", " d"])],
          unseen,
        ),
      ),
    ).toBe("2:change");
  });
  it("3 del / 1 add", () => {
    const m = project(
      [
        hunk(1, [
          " a",
          "-local x = 1",
          "-alpha beta gamma",
          "-delta epsilon zeta",
          "+local x = 2",
          " d",
        ]),
      ],
      unseen,
    );
    expect(dump(m)).toBe("2:changev");
    expect(srcs(m, 2)).toBe("1.5 1.2 1.3 1.4");
  });
  it("dissimilar stays add plus tick", () => {
    expect(
      dump(
        project(
          [hunk(1, [" a", "-alpha beta gamma", "+zzz(999)", " d"])],
          unseen,
        ),
      ),
    ).toBe("2:addv");
  });
  it("sources", () => {
    const m = project([hunk(1, [" a", "+b", "+c", " d"])], unseen);
    expect(srcs(m, 2)).toBe("1.2");
    expect(srcs(m, 3)).toBe("1.3");
    expect(
      srcs(
        project(
          [hunk(1, [" a", "-local x = 1", "+local x = 2", " d"])],
          unseen,
        ),
        2,
      ),
    ).toBe("1.3 1.2");
    expect(srcs(project([hunk(1, ["-gone", " a"])], unseen), 1)).toBe("1.1");
    expect(
      srcs(
        project([hunk(1, [" a", "+b"]), hunk(10, [" x", "+y"])], unseen),
        11,
      ),
    ).toBe("2.2");
  });
  it("trailing del and del at top", () => {
    expect(dump(project([hunk(1, [" a", " b", "-c", " d"])], unseen))).toBe(
      "2:-v",
    );
    expect(dump(project([hunk(1, ["-a", " b"])], unseen))).toBe("1:-^");
  });
  it("seen folding", () => {
    const hs = [hunk(1, [" a", "-local x = 1", "+local x = 2", " d"])];
    expect(dump(project(hs, (dl) => dl.kind === "add"))).toBe("2:change");
    expect(dump(project(hs, () => true))).toBe("2:changeS");
    const d = [hunk(1, [" a", " b", "-c", " d"])];
    expect(dump(project(d, (dl) => dl.kind === "context"))).toBe("2:-v");
    expect(dump(project(d, () => true))).toBe("2:-vS");
  });
  it("two hunks", () => {
    expect(
      dump(
        project(
          [hunk(1, [" a", "+b", " c"]), hunk(20, [" x", "+y", " z"])],
          unseen,
        ),
      ),
    ).toBe("2:add 21:add");
  });
});

describe("gutter navigation", () => {
  const nm = (seen: boolean, ...s: GutterSource[]) => ({ seen, sources: s });
  const nav = new Map([
    [4, nm(false, { hunk: 0, li: 1 })],
    [5, nm(false, { hunk: 0, li: 2 })],
    [20, nm(false, { hunk: 1, li: 0 })],
  ]);
  it("hunk starts and next row", () => {
    const starts = hunkStarts(nav);
    expect(starts).toEqual([4, 20]);
    expect(hunkStarts(new Map())).toEqual([]);
    expect(nextHunkRow(starts, 1, 1)).toBe(4);
    expect(nextHunkRow(starts, 5, 1)).toBe(20);
    expect(nextHunkRow(starts, 20, 1)).toBe(4);
    expect(nextHunkRow(starts, 20, -1)).toBe(4);
    expect(nextHunkRow(starts, 4, -1)).toBe(20);
    expect(nextHunkRow([], 1, 1)).toBeUndefined();
  });
  it("unseen only", () => {
    const seen = new Map([
      [4, nm(true, { hunk: 0, li: 1 })],
      [5, nm(true, { hunk: 0, li: 2 })],
      [20, nm(false, { hunk: 1, li: 0 })],
    ]);
    expect(hunkStarts(seen, true)).toEqual([20]);
    expect(
      hunkStarts(
        new Map([
          [4, nm(true, { hunk: 0, li: 1 })],
          [5, nm(false, { hunk: 0, li: 2 })],
        ]),
        true,
      ),
    ).toEqual([4]);
    seen.set(20, nm(true, { hunk: 1, li: 0 }));
    expect(hunkStarts(seen, true)).toEqual([4, 20]);
  });
  it("hunk range", () => {
    expect(hunkRange(nav, 5)).toEqual({ lo: 4, hi: 5 });
    expect(hunkRange(nav, 20)).toEqual({ lo: 20, hi: 20 });
    expect(hunkRange(nav, 7)).toBeUndefined();
  });
});
