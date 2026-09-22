import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as ranges from "./ranges.ts";
import {
  COMMENTS_ID,
  type CommentEntry,
  contentHash,
  lineHash,
  resolve,
  Store,
} from "./state.ts";
import type {
  HeadLnum,
  LineId,
  PostLnum,
  PreLnum,
  RepoPath,
  Sha,
} from "./types.ts";

const P = (p: string) => p as RepoPath;
const tmp = () => mkdtemp(join(tmpdir(), "glean-state-"));
const str = (rs: ranges.RangeSet<number>) =>
  rs.map(([s, e]) => `${s}-${e}`).join(",");
const r = (s: number, e: number) => [s, e] as const;

describe("ranges", () => {
  it("merge", () => {
    expect(str(ranges.merge([r(1, 3), r(4, 6)]))).toBe("1-6");
    expect(str(ranges.merge([r(1, 5), r(3, 8)]))).toBe("1-8");
    expect(str(ranges.merge([r(5, 6), r(1, 2)]))).toBe("1-2,5-6");
  });
  it("add / remove", () => {
    let x = ranges.add([r(1, 2)], r(5, 6));
    expect(str(x)).toBe("1-2,5-6");
    x = ranges.add(x, r(3, 4));
    expect(str(x)).toBe("1-6");
    expect(str(ranges.remove(x, r(3, 3)))).toBe("1-2,4-6");
    expect(str(ranges.remove([r(1, 10)], r(1, 10)))).toBe("");
  });
  it("covers / rangeCovered", () => {
    expect(ranges.covers([r(1, 3), r(7, 9)], 8)).toBe(true);
    expect(ranges.covers([r(1, 3), r(7, 9)], 5)).toBe(false);
    expect(ranges.rangeCovered([r(1, 10)], r(3, 7))).toBe(true);
    expect(ranges.rangeCovered([r(1, 4), r(6, 10)], r(3, 7))).toBe(false);
  });
});

describe("resolve", () => {
  const diff = ["alpha", "beta", "gamma", "beta", "delta"];
  it("closest consecutive block (indices 0-based, default lnum = index + 1)", () => {
    expect(
      resolve(["}"], ["alpha", "}", "beta", "}", "gamma"], undefined, 4),
    ).toBe(3);
    expect(resolve(["gamma"], diff, undefined, 1)).toBe(2);
    expect(resolve(["beta"], diff, undefined, 1)).toBe(1);
    expect(resolve(["beta"], diff, undefined, 5)).toBe(3);
    expect(resolve(["beta"], diff, undefined, 3)).toBe(1);
    expect(resolve(["alpha", "beta"], diff, undefined, 1)).toBe(0);
    expect(resolve(["alpha", "gamma"], diff, undefined, 1)).toBeUndefined();
    expect(
      resolve(["-removed"], ["ctx", "-removed", "ctx2"], undefined, 2),
    ).toBe(1);
    expect(resolve(["missing"], diff, undefined, 1)).toBeUndefined();
    expect(resolve([], diff, undefined, 1)).toBeUndefined();
  });
  it("tiebreaks in lnumOf space", () => {
    const lnums = [100, 101, 5, 6];
    const dup = ["x", "y", "x", "y"];
    expect(resolve(["x"], dup, (i) => lnums[i], 5)).toBe(2);
    expect(resolve(["x"], dup, (i) => lnums[i], 99)).toBe(0);
  });
});

describe("Store", () => {
  it("seen and seen_del ranges round-trip", async () => {
    const dir = await tmp();
    const s = new Store(dir);
    await s.load(["shaA" as Sha, "shaB" as Sha]);
    s.markSeen("shaA" as Sha, P("f.txt"), [2, 4] as [PostLnum, PostLnum]);
    s.markSeen("shaA" as Sha, P("f.txt"), [10, 10] as [PostLnum, PostLnum]);
    s.markSeenDel("shaA" as Sha, P("f.txt"), [7, 9] as [PreLnum, PreLnum]);
    await s.save("shaA" as Sha);
    const s2 = new Store(dir);
    await s2.load(["shaA" as Sha, "shaB" as Sha]);
    expect(str(s2.seenRanges("shaA" as Sha, P("f.txt")))).toBe("2-4,10-10");
    expect(str(s2.seenDelRanges("shaA" as Sha, P("f.txt")))).toBe("7-9");
    expect(str(s2.seenRanges("shaB" as Sha, P("f.txt")))).toBe("");
  });

  it("mark then unmark restores identical JSON", async () => {
    const s = new Store(await tmp());
    const empty = JSON.stringify(s.serialize("shaA" as Sha));
    const sha = "shaA" as Sha as Sha;
    const ids: LineId[] = [
      { kind: "committed-add", sha, path: P("f.txt"), lnum: 2 as PostLnum },
      { kind: "committed-add", sha, path: P("f.txt"), lnum: 3 as PostLnum },
      {
        kind: "committed-del",
        removerSha: sha,
        path: P("f.txt"),
        lnum: 9 as PreLnum,
      },
    ];
    s.mark(ids);
    expect(s.allSeen(ids)).toBe(true);
    s.unmark(ids);
    expect(s.isSeen(ids[0]!)).toBe(false);
    expect(JSON.stringify(s.serialize("shaA" as Sha))).toBe(empty);
  });

  it("content-addressed comments round-trip and load outside the review's shas", async () => {
    const dir = await tmp();
    const s = new Store(dir);
    await s.load(["shaA" as Sha]);
    const single: CommentEntry[] = [{ kind: "add", text: "two" }];
    s.addCommentRecord(P("f.txt"), {
      lnum: 3,
      content: single,
      text: "single",
      reply: undefined,
      origin: undefined,
    });
    s.addCommentRecord(P("f.txt"), {
      lnum: 5,
      content: [
        { kind: "add", text: "a" },
        { kind: "add", text: "b" },
      ],
      text: "multi",
      reply: undefined,
      origin: undefined,
    });
    await s.save(COMMENTS_ID);
    const s2 = new Store(dir);
    await s2.load(["shaA" as Sha, "shaB" as Sha]);
    const list = s2.commentsFor(P("f.txt"));
    expect(list.map((c) => c.text)).toEqual(["single", "multi"]);
    expect(list[1]!.content[1]!.text).toBe("b");
    expect(list[1]!.lnum).toBe(5);
    s2.removeCommentRecord(P("f.txt"), {
      lnum: 3,
      content: single,
      text: "single",
    });
    expect(s2.commentsFor(P("f.txt")).map((c) => c.text)).toEqual(["multi"]);
    expect(s2.commentsFor(P("other.txt"))).toEqual([]);
    s2.addCommentRecord(P("f.txt"), {
      lnum: 7,
      content: [
        { kind: "context", text: "kept" },
        { kind: "del", text: "removed", oldLnum: 42 },
        { kind: "add", text: "added" },
      ],
      text: "mixed",
      reply: undefined,
      origin: { sha: "abc123" as Sha, dirty: true },
    });
    await s2.save(COMMENTS_ID);
    const s3 = new Store(dir);
    await s3.load([]);
    const mixed = s3.commentsFor(P("f.txt")).at(-1)!;
    expect(mixed.content).toEqual([
      { kind: "context", text: "kept" },
      { kind: "del", text: "removed", oldLnum: 42 },
      { kind: "add", text: "added" },
    ]);
    expect(mixed.origin).toEqual({ sha: "abc123", dirty: true });
  });

  it("baselines are anchored, pruned when empty, and restore JSON when cleared", async () => {
    const dir = await tmp();
    const s = new Store(dir);
    await s.load([COMMENTS_ID]);
    const empty = JSON.stringify(s.serialize(COMMENTS_ID));
    const base = ["a", "b", "c"];
    const hb = contentHash(base);
    expect(s.baseline(P("f.txt"), hb)).toBeUndefined();
    s.setBaseline(P("f.txt"), hb, ["a", "B", "c"]);
    expect(s.baseline(P("f.txt"), hb)!.lines![1]).toBe("B");
    const moved = contentHash([...base, "d"]);
    expect(s.baseline(P("f.txt"), moved)).toBeUndefined();
    expect(s.baseline(P("f.txt"), hb)).toBeDefined();
    await s.save(COMMENTS_ID);
    const s2 = new Store(dir);
    await s2.load([COMMENTS_ID]);
    expect(s2.baseline(P("f.txt"), hb)!.lines![1]).toBe("B");
    expect(s2.baseline(P("f.txt"), moved)).toBeUndefined();
    s.setBaseline(P("g.txt"), hb, base);
    expect(s.baseline(P("g.txt"), hb)).toBeUndefined();
    s.setBaseline(P("f.txt"), hb, undefined);
    expect(s.baseline(P("f.txt"), hb)).toBeUndefined();
    expect(JSON.stringify(s.serialize(COMMENTS_ID))).toBe(empty);
  });

  it("explicit del ranges share the record, anchor and pruning rule", async () => {
    const dir = await tmp();
    const s = new Store(dir);
    await s.load([COMMENTS_ID]);
    const empty = JSON.stringify(s.serialize(COMMENTS_ID));
    const base = ["a", "b", "c"];
    const hb = contentHash(base);
    const h = (a: number, b: number) => [a, b] as [HeadLnum, HeadLnum];
    const f = P("f.txt");
    s.setBaseline(f, hb, undefined, [h(2, 2)]);
    expect(s.baseline(f, hb)!.dels.length).toBe(1);
    expect(s.baseline(f, hb)!.lines).toBeUndefined();
    s.setBaseline(f, hb, undefined, [h(2, 2), h(3, 3)]);
    expect(s.baseline(f, hb)!.dels).toEqual([[2, 3]]);
    await s.save(COMMENTS_ID);
    const s2 = new Store(dir);
    await s2.load([COMMENTS_ID]);
    expect(s2.baseline(f, hb)!.dels[0]![1]).toBe(3);
    expect(s2.baseline(f, contentHash([...base, "d"]))).toBeUndefined();
    s.setBaseline(f, hb, undefined, []);
    expect(s.baseline(f, hb)).toBeUndefined();
    expect(JSON.stringify(s.serialize(COMMENTS_ID))).toBe(empty);
    s.setBaseline(f, hb, ["a", "B2", "c"], [h(1, 1)]);
    s.setBaseline(f, hb, ["a", "B2", "c"], []);
    expect(s.baseline(f, hb)!.lines![1]).toBe("B2");
    s.setBaseline(f, hb, base, [h(1, 1)]);
    expect(s.baseline(f, hb)!.dels.length).toBe(1);
  });

  it("branch-anchored worktree shards are isolated and slash-safe", async () => {
    const dir = await tmp();
    const hash = contentHash(["line"]);
    const a = new Store(dir, "WORKTREE/feature/a");
    await a.load([]);
    a.setBaseline(P("w.txt"), hash, ["line", "more"]);
    a.addCommentRecord(P("c.txt"), {
      lnum: 1,
      content: [{ kind: "add", text: "x" }],
      text: "hi",
      reply: undefined,
      origin: undefined,
    });
    await a.save(a.wtShard);
    expect(a.shardPath("WORKTREE/feature/a")).toBe(
      join(dir, "WORKTREE%2Ffeature%2Fa.json"),
    );
    await readFile(a.shardPath("WORKTREE/feature/a"), "utf8");
    const b = new Store(dir, "WORKTREE/feature/b");
    await b.load([]);
    expect(b.baseline(P("w.txt"), hash)).toBeUndefined();
    expect(b.commentsFor(P("c.txt"))).toEqual([]);
    const a2 = new Store(dir, "WORKTREE/feature/a");
    await a2.load([]);
    expect(a2.baseline(P("w.txt"), hash)).toBeDefined();
  });

  it("sticky overrides are content-addressed and prune to identical JSON", async () => {
    const dir = await tmp();
    const s = new Store(dir);
    await s.load([COMMENTS_ID]);
    const empty = JSON.stringify(s.serialize(COMMENTS_ID));
    s.addSticky(P("s.txt"), "A1");
    expect(s.isSticky(P("s.txt"), "A1")).toBe(true);
    expect(s.isSticky(P("s.txt"), "A1x")).toBe(false);
    expect(s.isSticky(P("o.txt"), "A1")).toBe(false);
    await s.save(COMMENTS_ID);
    const s2 = new Store(dir);
    await s2.load([COMMENTS_ID]);
    expect(s2.isSticky(P("s.txt"), "A1")).toBe(true);
    s.removeSticky(P("s.txt"), "A1");
    expect(s.isSticky(P("s.txt"), "A1")).toBe(false);
    expect(JSON.stringify(s.serialize(COMMENTS_ID))).toBe(empty);
  });

  it("comment ids are monotonic and persisted; replies replace", async () => {
    const dir = await tmp();
    const s = new Store(dir);
    await s.load([COMMENTS_ID]);
    const rec = (text: string) => ({
      lnum: 1,
      content: [{ kind: "add", text } as const],
      text,
      reply: undefined,
      origin: undefined,
    });
    const id1 = s.addCommentRecord(P("f.txt"), rec("one")).id;
    const id2 = s.addCommentRecord(P("g.txt"), rec("two")).id;
    expect(id2).toBe(id1 + 1);
    expect(s.commentsFor(P("f.txt"))[0]!.reply).toBeUndefined();
    s.setCommentReply(P("f.txt"), { id: id1 }, "first answer");
    s.setCommentReply(P("f.txt"), { id: id1 }, "second answer");
    expect(s.commentsFor(P("f.txt"))[0]).toMatchObject({
      reply: "second answer",
      text: "one",
    });
    await s.save(COMMENTS_ID);
    const s2 = new Store(dir);
    await s2.load([COMMENTS_ID]);
    expect(s2.commentsFor(P("f.txt"))[0]).toMatchObject({
      reply: "second answer",
      id: id1,
    });
    expect(s2.commentsFor(P("g.txt"))[0]!.reply).toBeUndefined();
    expect(s2.addCommentRecord(P("f.txt"), rec("three")).id).toBe(id2 + 1);
    s2.setCommentReply(P("f.txt"), { id: id1 }, undefined);
    expect(s2.commentsFor(P("f.txt"))[0]!.reply).toBeUndefined();
    expect(s2.setCommentReply(P("f.txt"), { id: 999 }, "x")).toBeUndefined();
  });

  it("legacy shards: ids backfilled in path order; seen_marks dropped, sticky kept", async () => {
    const dir = await tmp();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${COMMENTS_ID}.json`),
      JSON.stringify({
        worktree: true,
        files: {},
        seen_marks: { "f.txt": [{ anchor: 1, content: ["one", "two"] }] },
        sticky: { "f.txt": { [lineHash("one")]: true } },
        comments: {
          "b.txt": [
            { lnum: 1, content: [{ text: "x", kind: "add" }], text: "bee" },
          ],
          "a.txt": [
            { lnum: 1, content: [{ text: "y", kind: "add" }], text: "one" },
            { lnum: 2, content: [{ text: "z", kind: "add" }], text: "two" },
          ],
        },
      }),
    );
    const s = new Store(dir);
    await s.load([COMMENTS_ID]);
    expect(s.isSticky(P("f.txt"), "one")).toBe(true);
    expect(s.baseline(P("f.txt"), contentHash(["one"]))).toBeUndefined();
    expect(s.commentsFor(P("a.txt")).map((c) => c.id)).toEqual([1, 2]);
    expect(s.commentsFor(P("b.txt"))[0]!.id).toBe(3);
    await s.save(COMMENTS_ID);
    const s2 = new Store(dir);
    await s2.load([COMMENTS_ID]);
    expect(s2.commentsFor(P("a.txt"))[1]!.id).toBe(2);
    expect(
      s2.addCommentRecord(P("a.txt"), {
        lnum: 9,
        content: [{ kind: "add", text: "w" }],
        text: "new",
        reply: undefined,
        origin: undefined,
      }).id,
    ).toBe(4);
  });

  it("corrupt shards read as empty", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "shaA.json"), "{not json");
    const s = new Store(dir);
    await s.load(["shaA" as Sha]);
    expect(s.seenRanges("shaA" as Sha, P("f.txt"))).toEqual([]);
  });
});

describe("shards written by the Lua implementation", () => {
  const fixtures = join(import.meta.dirname, "fixtures", "lua-store");

  it("hashes agree with vim.fn.sha256", () => {
    expect(contentHash(["a", "b", "c"])).toBe(
      "ea7fb08b7a2dc4619ffb7c7bb38d95a2047935fa165d71b12efd3852a2e6d0cc",
    );
    expect(lineHash("A1")).toBe(
      "16a36e86f6fed5d465ff332511a0ce1a863b55d364b25a7cdaa25db19abf9648",
    );
  });

  it("loads commit and branch worktree shards", async () => {
    const dir = await tmp();
    await cp(fixtures, dir, { recursive: true });
    const s = new Store(dir, "WORKTREE/feature/x");
    await s.load(["aaaa" as Sha]);
    expect(str(s.seenRanges("aaaa" as Sha, P("f.txt")))).toBe("2-4,10-10");
    expect(str(s.seenDelRanges("aaaa" as Sha, P("f.txt")))).toBe("7-9");
    expect(str(s.seenRanges("aaaa" as Sha, P("g.txt")))).toBe("1-1");
    const hb = contentHash(["a", "b", "c"]);
    expect(s.baseline(P("w.txt"), hb)).toEqual({
      head: hb,
      lines: ["a", "B", "b", "c"],
      dels: [[2, 2]],
    });
    expect(s.baseline(P("d.txt"), hb)).toEqual({
      head: hb,
      lines: undefined,
      dels: [
        [1, 1],
        [3, 3],
      ],
    });
    expect(s.isSticky(P("s.txt"), "A1")).toBe(true);
    const cs = s.commentsFor(P("f.txt"));
    expect(cs.map((c) => [c.id, c.text, c.reply])).toEqual([
      [1, "mixed", undefined],
      [2, "single", "an answer"],
    ]);
    expect(cs[0]!.content[1]).toEqual({
      kind: "del",
      text: "removed",
      oldLnum: 42,
    });
    expect(cs[0]!.origin).toEqual({ sha: "abc123", dirty: true });
    expect(s.nextCommentId()).toBe(3);
  });

  it("re-saving a Lua shard preserves its content", async () => {
    const dir = await tmp();
    await cp(fixtures, dir, { recursive: true });
    const s = new Store(dir, "WORKTREE/feature/x");
    await s.load(["aaaa" as Sha]);
    const before = JSON.parse(await readFile(s.shardPath(s.wtShard), "utf8"));
    await s.save(s.wtShard);
    expect(JSON.parse(await readFile(s.shardPath(s.wtShard), "utf8"))).toEqual({
      ...before,
      worktree: true,
    });
  });

  it("loads a legacy worktree shard (bare-string content, `anchor`)", async () => {
    const dir = await tmp();
    await cp(fixtures, dir, { recursive: true });
    const s = new Store(dir);
    await s.load([]);
    const a = s.commentsFor(P("a.txt"));
    expect(a.map((c) => c.id)).toEqual([1, 2]);
    expect(a[1]).toMatchObject({
      lnum: 2,
      content: [{ kind: "add", text: "z" }],
    });
    expect(s.commentsFor(P("b.txt"))[0]!.id).toBe(3);
    expect(s.isSticky(P("f.txt"), "one")).toBe(true);
  });
});
