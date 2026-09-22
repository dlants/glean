import { describe, expect, it } from "vitest";
import type { DiffLine } from "../core/diff.ts";
import type { RepoPath } from "../core/types.ts";
import { displaySeenSet, hunkMarkerRuns, markerKey } from "./markers.ts";

const hunk: { lines: DiffLine[] } = {
  lines: [
    { kind: "context", text: "l1", oldLnum: 1, newLnum: 1 },
    { kind: "add", text: "l2", newLnum: 2 },
    { kind: "add", text: "l3", newLnum: 3 },
    { kind: "add", text: "l4", newLnum: 4 },
    { kind: "del", text: "gone", oldLnum: 2, newLnum: 5 },
    { kind: "context", text: "l5", oldLnum: 3, newLnum: 5 },
    { kind: "add", text: "l7", newLnum: 7 },
    { kind: "context", text: "l8", oldLnum: 4, newLnum: 8 },
  ],
};
const seen = (texts: string[]) => (dl: DiffLine) => texts.includes(dl.text);

describe("hunkMarkerRuns", () => {
  it("splits runs and records bounds", () => {
    const runs = hunkMarkerRuns(hunk, seen(["l2", "l3", "l4", "l7"]));
    expect(runs).toEqual([
      { lo: 1, hi: 3, lnumLo: 2, lnumHi: 4, texts: ["l2", "l3", "l4"] },
      { lo: 6, hi: 6, lnumLo: 7, lnumHi: 7, texts: ["l7"] },
    ]);
  });
  it("coalesces a seen del with an adjacent seen add", () => {
    const runs = hunkMarkerRuns(hunk, seen(["l4", "gone"]));
    expect(runs.map((r) => r.texts)).toEqual([["l4", "gone"]]);
  });
  it("a del-only run has no lnum bounds", () => {
    const runs = hunkMarkerRuns(hunk, seen(["gone"]));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.lnumLo).toBeUndefined();
  });
  it("an unseen changed line breaks a run; nothing seen gives no runs", () => {
    expect(hunkMarkerRuns(hunk, seen(["l2", "l4"]))).toHaveLength(2);
    expect(hunkMarkerRuns(hunk, seen([]))).toHaveLength(0);
  });
});

describe("displaySeenSet", () => {
  const runs = hunkMarkerRuns(hunk, seen(["l2", "l3", "l4", "l7"]));
  it("demotes short runs except sticky lines", () => {
    expect([...displaySeenSet(runs, 3, (i) => i === 6)]).toEqual([1, 2, 3, 6]);
    expect([...displaySeenSet(runs, 4, () => false)]).toEqual([]);
  });
  it("threshold <= 1 disables demotion", () => {
    expect([...displaySeenSet(runs, 1, () => false)]).toEqual([1, 2, 3, 6]);
  });
});

describe("markerKey", () => {
  const p = "f.txt" as RepoPath;
  it("is stable, content-sensitive and scope-prefixed", () => {
    expect(markerKey("commits", p, ["a", "b"])).toBe(
      markerKey("commits", p, ["a", "b"]),
    );
    expect(markerKey("commits", p, ["a", "b"])).not.toBe(
      markerKey("commits", p, ["a", "c"]),
    );
    expect(markerKey("commits", p, ["a"]).startsWith("mk:")).toBe(true);
    expect(markerKey("combined", p, ["a"]).startsWith("cmk:")).toBe(true);
  });
});
