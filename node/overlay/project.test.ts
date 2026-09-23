import { describe, expect, it } from "vitest";
import type { CommentEntry, CommentRecord } from "../core/state.ts";
import type { RepoPath } from "../core/types.ts";
import {
  firstLine,
  floatLines,
  jumpLnum,
  quickfixItems,
  recordsAt,
  resolveOverlay,
  stamps,
} from "./project.ts";

let nextId = 1;
const rec = (
  lnum: number,
  content: CommentEntry[],
  text: string,
  reply?: string,
): CommentRecord => ({
  id: nextId++,
  lnum,
  content,
  text,
  reply,
  origin: undefined,
});
const add = (text: string): CommentEntry => ({ kind: "add", text });

describe("overlay projection (overlay_test)", () => {
  it("a record shows on its resolved line with the body's first line", () => {
    const r = rec(2, [add("beta")], "why beta?\nsecond line");
    const { groups, moved } = resolveOverlay([r], ["alpha", "beta", "gamma"]);
    expect(moved).toBe(false);
    const s = stamps(groups, false, 3).filter((x) => x.opts.sign_text);
    expect(s).toHaveLength(1);
    expect(s[0]!.row).toBe(1);
    const virt = s[0]!.opts.virt_text as [string, string][];
    expect(virt[0]![0]).toContain("why beta?");
    expect(virt[0]![0]).not.toContain("second line");
  });

  it("an external rewrite re-resolves and reports the move", () => {
    const r = rec(2, [add("beta")], "note");
    const { groups, moved } = resolveOverlay(
      [r],
      ["prefix", "prefix2", "alpha", "beta", "gamma"],
    );
    expect(moved).toBe(true);
    expect(r.lnum).toBe(4);
    expect(groups[0]!.lnum).toBe(4);
    expect(
      resolveOverlay([r], ["prefix", "prefix2", "alpha", "beta"]).moved,
    ).toBe(false);
  });

  it("mixed selections anchor on surviving lines; del-only has no position", () => {
    const mixed = rec(
      2,
      [
        { kind: "context", text: "two" },
        { kind: "del", text: "gone", oldLnum: 7 },
        add("three"),
      ],
      "mixed",
    );
    const delOnly = rec(3, [{ kind: "del", text: "gone", oldLnum: 7 }], "d");
    const lines = ["one", "two", "three", "four"];
    const { groups } = resolveOverlay([mixed, delOnly], lines);
    const s = stamps(groups, false, lines.length);
    const signs = s.filter((x) => x.opts.sign_text);
    expect(signs.map((x) => x.row)).toEqual([1]);
    expect(s.filter((x) => x.opts.line_hl_group)).toHaveLength(2);
  });

  it("deleted text renders outdated at its fallback slot", () => {
    const r = rec(2, [add("two"), add("three")], "gone");
    const { groups, moved } = resolveOverlay([r], ["one", "rewritten", "four"]);
    const [sign] = stamps(groups, false, 3);
    expect(sign!.opts.sign_hl_group).toBe("GleanCommentOutdated");
    expect((sign!.opts.virt_text as [string, string][])[0]![0]).toContain(
      "(outdated)",
    );
    expect(r.lnum).toBe(sign!.row + 1);
    expect(moved).toBe(false);
  });

  it("a file with no comments stamps nothing", () => {
    expect(stamps(resolveOverlay([], ["x"]).groups, true, 1)).toEqual([]);
  });

  it("float carries the whole body and reply; inline toggles virt_lines", () => {
    const r = rec(1, [add("a")], "first\nsecond line", "agent says hi");
    const { groups } = resolveOverlay([r], ["a"]);
    const text = floatLines(recordsAt(groups, 1))
      .map((l) => l.text)
      .join("\n");
    expect(text).toContain("second line");
    expect(text).toContain("agent says hi");
    expect(recordsAt(groups, 2)).toEqual([]);
    expect(stamps(groups, true, 1)[0]!.opts.virt_lines).toBeDefined();
    expect(stamps(groups, false, 1)[0]!.opts.virt_lines).toBeUndefined();
  });

  it("several records on a line share one sign", () => {
    const a = rec(1, [add("a")], "one");
    const b = rec(1, [add("a")], "two");
    const [s] = stamps(resolveOverlay([a, b], ["a"]).groups, false, 1);
    expect((s!.opts.virt_text as [string, string][])[0]![0]).toContain(
      "(+1 more)",
    );
  });

  it("quickfix lists every record, del-only ones as outdated", () => {
    const items = quickfixItems("/r", [
      {
        path: "f.txt" as RepoPath,
        records: [rec(2, [add("beta")], "why beta?")],
        lines: ["alpha", "beta"],
      },
      {
        path: "multi.txt" as RepoPath,
        records: [rec(3, [{ kind: "del", text: "g", oldLnum: 7 }], "del only")],
        lines: ["x"],
      },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ filename: "/r/f.txt", lnum: 2 });
    expect(items[1]!.text).toContain("del only (outdated)");
  });

  it("jumps by resolved position and truncates labels", () => {
    const groups = [
      { lnum: 3, entries: [] },
      { lnum: 8, entries: [] },
    ];
    expect(jumpLnum(groups, 3, 1)).toBe(8);
    expect(jumpLnum(groups, 3, -1)).toBeUndefined();
    expect(jumpLnum(groups, 9, -1)).toBe(8);
    expect(firstLine("x".repeat(80))).toHaveLength(60);
  });
});
