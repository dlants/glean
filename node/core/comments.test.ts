import { describe, expect, it } from "vitest";
import { diffProjection, fileProjection, locate } from "./comments.ts";
import type { CommentEntry } from "./state.ts";

const mixed = {
  lnum: 4,
  content: [
    { kind: "context", text: "kept" },
    { kind: "del", text: "removed", oldLnum: 9 },
    { kind: "add", text: "added" },
  ] satisfies CommentEntry[],
};
const delonly = {
  lnum: 4,
  content: [
    { kind: "del", text: "removed", oldLnum: 9 },
  ] satisfies CommentEntry[],
};

describe("comments", () => {
  it("projections", () => {
    expect(diffProjection(mixed)).toEqual(["kept", "removed", "added"]);
    expect(fileProjection(mixed)).toEqual(["kept", "added"]);
    expect(fileProjection(delonly)).toEqual([]);
  });

  it("locates against a diff through the lnum mapping", () => {
    const lnums = [3, 4, 4, 5, 6];
    expect(
      locate(
        mixed,
        ["before", "kept", "removed", "added", "after"],
        (i) => lnums[i],
      ),
    ).toEqual({ kind: "found", index: 1, lnum: 4 });
  });

  it("locates against a plain file", () => {
    expect(
      locate(mixed, ["prelude", "kept", "added", "tail"], undefined, "file"),
    ).toMatchObject({
      kind: "found",
      lnum: 2,
    });
  });

  it("is all-or-nothing, falling back nearest the lnum hint", () => {
    expect(
      locate(
        mixed,
        ["prelude", "kept", "rewritten", "tail"],
        undefined,
        "file",
      ),
    ).toEqual({ kind: "outdated", lnum: 4, fallback: 3 });
    expect(locate(mixed, ["a", "b"], undefined, "file")).toMatchObject({
      lnum: 2,
    });
  });

  it("a del-only record is outdated in a file but anchors in a diff", () => {
    expect(locate(delonly, ["removed"], undefined, "file").kind).toBe(
      "outdated",
    );
    expect(locate(delonly, ["removed"]).kind).toBe("found");
  });
});
