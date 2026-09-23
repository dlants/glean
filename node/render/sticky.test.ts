import { describe, expect, it } from "vitest";
import type { FileRef, RowTarget } from "./render.ts";
import { computeAncestry, computePinned } from "./sticky.ts";

const cf: FileRef = { scope: "commits", commit: 0, file: 0 };
const commits: RowTarget[] = [
  { kind: "mode-header" },
  { kind: "commit-header", commit: 0 },
  { kind: "file-header", file: cf },
  { kind: "hunk-header", file: cf, hunk: 0, sec: "unseen" },
  { kind: "line", file: cf, hunk: 0, li: 0, sec: "unseen" },
  { kind: "seen-section", file: cf },
  { kind: "hunk-header", file: cf, hunk: 1, sec: "seen" },
  { kind: "line", file: cf, hunk: 1, li: 0, sec: "seen" },
  {
    kind: "marker-line",
    file: cf,
    hunk: 1,
    li: 1,
    key: "m" as never,
  },
];
const cc: FileRef = { scope: "combined", file: 0 };
const combined: RowTarget[] = [
  { kind: "mode-header" },
  { kind: "file-header", file: cc },
  { kind: "hunk-header", file: cc, hunk: 0, sec: "unseen" },
  { kind: "line", file: cc, hunk: 0, li: 0, sec: "unseen" },
];

describe("computeAncestry", () => {
  const anc = computeAncestry(commits);
  it("classifies header levels (commits scope)", () => {
    expect(anc[0]).toEqual({});
    expect(anc[1]).toEqual({ commit: 1 });
    expect(anc[2]).toEqual({ commit: 1, file: 2 });
    expect(anc[3]).toEqual({ commit: 1, file: 2, hunk: 3 });
    expect(anc[4]).toEqual({ commit: 1, file: 2, hunk: 3 });
    expect(anc[5]).toMatchObject({ commit: 1, file: 2, sec: 5 });
    expect(anc[5]?.hunk).toBeUndefined();
    expect(anc[6]).toEqual({ commit: 1, file: 2, sec: 5, hunk: 6 });
    expect(anc[7]).toEqual({ commit: 1, file: 2, sec: 5, hunk: 6 });
    expect(anc[8]).toEqual({ commit: 1, file: 2, sec: 5, hunk: 6 });
  });
  it("has no commit level in the combined scope", () => {
    const c = computeAncestry(combined);
    expect(c[1]).toEqual({ file: 1 });
    expect(c[3]).toEqual({ file: 1, hunk: 2 });
  });
});

describe("computePinned", () => {
  const anc = computeAncestry(commits);
  it.each([
    [0, []],
    [1, [0]],
    [2, [0, 1]],
    [4, [0, 1, 2, 3]],
    [7, [0, 1, 2, 5, 6]],
    [6, [0, 1, 2, 5]],
    [8, [0, 1, 2, 5, 6]],
    [99, []],
  ])("w0=%i pins %j", (w0, exp) => {
    expect(computePinned(anc, w0)).toEqual(exp);
  });
  it("pins summary+file+hunk in the combined scope", () => {
    expect(computePinned(computeAncestry(combined), 3)).toEqual([0, 1, 2]);
  });
});
