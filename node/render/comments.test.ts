import { describe, expect, it } from "vitest";
import { parse } from "../core/diff.ts";
import type { CommentRecord } from "../core/state.ts";
import type { RepoPath } from "../core/types.ts";
import { collectComments, resolveComments } from "./comments.ts";

const patch = [
  "diff --git a/f b/f",
  "--- a/f",
  "+++ b/f",
  "@@ -1,2 +1,3 @@",
  " a",
  "+b",
  " c",
  "",
].join("\n");

function rec(text: string, lnum: number, id = 1): CommentRecord {
  return {
    id,
    lnum,
    content: [{ kind: "add", text }],
    text: "note",
    reply: undefined,
    origin: undefined,
  };
}

describe("resolveComments", () => {
  it("places found and outdated comments", () => {
    const file = parse(patch)[0]!;
    const m = resolveComments(file, undefined, [rec("b", 2), rec("zz", 3, 2)]);
    expect(m.get(1)?.map((c) => [c.record.id, c.outdated])).toEqual([
      [1, false],
    ]);
    expect(m.get(2)?.map((c) => [c.record.id, c.outdated])).toEqual([
      [2, true],
    ]);
  });
});

// Canonical keeps a whitespace-only add of "b"; the whitespace-filtered
// display shows it as context.
const canonicalPatch = [
  "diff --git a/f b/f",
  "--- a/f",
  "+++ b/f",
  "@@ -1,3 +1,4 @@",
  " a",
  "-b ",
  "+b",
  "+x",
  " c",
  "",
].join("\n");
const displayPatch = [
  "diff --git a/f b/f",
  "--- a/f",
  "+++ b/f",
  "@@ -1,3 +1,4 @@",
  " a",
  " b",
  "+x",
  " c",
  "",
].join("\n");
describe("resolveComments with a distinct canonical", () => {
  it("places matches shown in display and omits whitespace-hidden ones", () => {
    const canonical = parse(canonicalPatch)[0]!;
    const display = parse(displayPatch)[0]!;
    const m = resolveComments(display, canonical, [
      rec("b", 2),
      rec("x", 3, 2),
    ]);
    expect(
      [...m.entries()].map(([i, cs]) => [i, cs.map((c) => c.record.id)]),
    ).toEqual([[2, [2]]]);
  });
});
describe("collectComments", () => {
  const path = "f" as RepoPath;
  it("keeps one copy of duplicate records", () => {
    const file = parse(patch)[0]!;
    const groups = collectComments(
      [{ path, canonical: file, display: file }],
      () => [rec("b", 2, 1), rec("b", 2, 2)],
      () => undefined,
      false,
    );
    expect(groups.map((g) => g.entries.length)).toEqual([1]);
    expect(groups[0]?.entries[0]?.state).toBe("diff");
  });
  it("marks a diff anchor filtered out by whitespace mode as hidden", () => {
    const groups = collectComments(
      [
        {
          path,
          canonical: parse(canonicalPatch)[0],
          display: parse(displayPatch)[0],
        },
      ],
      () => [rec("b", 2), rec("x", 3, 2)],
      () => undefined,
      true,
    );
    expect(
      groups[0]?.entries.map((e) => [e.record.id, e.state, e.hidden]),
    ).toEqual([
      [1, "diff", true],
      [2, "diff", false],
    ]);
  });
});
