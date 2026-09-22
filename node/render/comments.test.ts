import { describe, expect, it } from "vitest";
import { parse } from "../core/diff.ts";
import type { CommentRecord } from "../core/state.ts";
import { resolveComments } from "./comments.ts";

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
