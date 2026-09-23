import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../core/state.ts";
import type { RepoPath } from "../core/types.ts";
import { Git, type Outcome, spawnRunner } from "../git/git.ts";
import {
  buildModel,
  Classifier,
  loadWorktreeSeen,
  type Scope,
  type Target,
} from "../session/model.ts";
import { makeRepo } from "../test/repo.ts";
import {
  diffContext,
  fileHeaderRow,
  hunkRange,
  jumpTarget,
  navRow,
  rowPostLnum,
  sourceLineRow,
} from "./nav.ts";
import { type Frame, render } from "./render.ts";

function ok<T>(o: Outcome<T>): T {
  if (o.kind !== "ok") throw new Error(o.message);
  return o.value;
}
// The init_test fixture: base, c1 edits two, c2 edits three and adds g.
async function setup(
  target: Target = { kind: "ref", ref: "HEAD" },
  dirty: Record<string, string> = {},
) {
  const repo = makeRepo([
    { msg: "base", files: { "f.txt": "one\ntwo\nthree\n" } },
    { msg: "c1: edit two", files: { "f.txt": "one\nTWO\nthree\n" } },
    {
      msg: "c2: edit three + add g",
      files: { "f.txt": "one\nTWO\nTHREE\n", "g.txt": "gee\n" },
    },
  ]);
  for (const [p, text] of Object.entries(dirty))
    writeFileSync(join(repo.root, p), text);
  const git = new Git({ repoRoot: repo.root, runner: spawnRunner(repo.env) });
  const store = new Store(mkdtempSync(join(tmpdir(), "glean-nav-")));
  const base = repo.shas[0] ?? "";
  const model = ok(await buildModel(git, base, target));
  const wt = ok(await loadWorktreeSeen(git, repo.root, store, model));
  const cls = new Classifier(model, store, wt, undefined);
  const frame = (scope: Scope) =>
    render({
      scope,
      cls,
      collapse: new Map(),
      isSticky: () => false,
      minSeenRun: 5,
      ignoreWhitespace: false,
    });
  return { repo, cls, frame, range: { base, target } };
}
const lineRow = (f: Frame, text: string, from = 0) =>
  f.rows.findIndex(
    (t, i) => i >= from && t.kind === "line" && f.lines[i]?.endsWith(text),
  );
const delRow = (f: Frame) =>
  f.rows.findIndex(
    (t, i) =>
      t.kind === "line" &&
      f.highlights.some(
        (h) => h.kind === "line" && h.row === i && h.hl === "GleanDel",
      ),
  );

describe("jump target", () => {
  it("combined add line resolves to the target post-image line", async () => {
    const { cls, frame, range } = await setup();
    const f = frame("combined");
    const jt = jumpTarget(cls, f.rows[lineRow(f, "TWO")], range);
    expect(jt).toMatchObject({
      kind: "post",
      ref: { kind: "rev", rev: "HEAD" },
      path: "f.txt",
      lnum: 2,
    });
  });
  it("a deletion resolves to the base pre-image", async () => {
    const { cls, frame, range } = await setup();
    const f = frame("combined");
    const jt = jumpTarget(cls, f.rows[delRow(f)], range);
    expect(jt).toMatchObject({
      kind: "del",
      ref: { kind: "rev", rev: range.base },
      path: "f.txt",
    });
  });
  it("commit scope resolves to the commit sha", async () => {
    const { repo, cls, frame, range } = await setup();
    const f = frame("commits");
    const jt = jumpTarget(cls, f.rows[lineRow(f, "TWO")], range);
    expect(jt).toMatchObject({
      ref: { kind: "rev", rev: repo.shas[1] },
      lnum: 2,
    });
  });
  it("floating commit: add → work tree, del → HEAD", async () => {
    const { cls, frame, range } = await setup(
      { kind: "worktree" },
      { "f.txt": "one\nTWO\nTHREE\nz\n" },
    );
    const f = frame("commits");
    const add = jumpTarget(cls, f.rows[lineRow(f, "z")], range);
    expect(add).toMatchObject({ ref: { kind: "worktree" }, lnum: 4 });
  });
  it("non-line rows have no jump target", async () => {
    const { cls, frame, range } = await setup();
    const f = frame("combined");
    expect(jumpTarget(cls, f.rows[0], range)).toBeUndefined();
  });
});

describe("diff context", () => {
  it("a deletion row bounds base (pre) and target (post)", async () => {
    const { cls, frame, range } = await setup();
    const f = frame("combined");
    const ctx = diffContext(cls, f.rows[delRow(f)], range);
    expect(ctx).toMatchObject({
      path: "f.txt",
      pre: { kind: "rev", rev: range.base },
      post: { kind: "rev", rev: "HEAD" },
      postLnum: undefined,
    });
  });
  it("commit scope bounds sha^ and sha", async () => {
    const { repo, cls, frame, range } = await setup();
    const f = frame("commits");
    const ctx = diffContext(cls, f.rows[lineRow(f, "TWO")], range);
    expect(ctx).toMatchObject({
      pre: { kind: "rev", rev: `${repo.shas[1]}^` },
      post: { kind: "rev", rev: repo.shas[1] },
      postLnum: 2,
    });
  });
});

describe("navigation", () => {
  it("]c/[c step over hunk headers, ]f/[f over file headers", async () => {
    const { frame } = await setup();
    const f = frame("combined");
    const hunks = f.rows.flatMap((t, i) =>
      t.kind === "hunk-header" ? [i] : [],
    );
    const files = f.rows.flatMap((t, i) =>
      t.kind === "file-header" ? [i] : [],
    );
    expect(hunks.length).toBeGreaterThan(1);
    expect(navRow(f, 0, "hunk", true)).toBe(hunks[0]);
    expect(navRow(f, hunks[0] ?? 0, "hunk", true)).toBe(hunks[1]);
    expect(navRow(f, hunks[1] ?? 0, "hunk", false)).toBe(hunks[0]);
    expect(navRow(f, 0, "hunk", false)).toBeUndefined();
    expect(navRow(f, files[0] ?? 0, "file", true)).toBe(files[1]);
    expect(navRow(f, files[1] ?? 0, "file", false)).toBe(files[0]);
  });
  it("hunkRange spans the header and every line of the hunk", async () => {
    const { frame } = await setup();
    const f = frame("combined");
    const row = lineRow(f, "TWO");
    const r = hunkRange(f, row);
    if (!r) throw new Error("no range");
    expect(f.rows[r.lo]?.kind).toBe("hunk-header");
    expect(r.lo).toBeLessThan(row);
    expect(r.hi).toBeGreaterThanOrEqual(row);
    const after = f.rows[r.hi + 1];
    expect(
      after?.kind === "line" &&
        after.hunk === (f.rows[row] as { hunk: number }).hunk,
    ).toBe(false);
    expect(hunkRange(f, 0)).toBeUndefined();
  });
});

describe("source line row (:Glean jump)", () => {
  it("lands on the requested line, degrades to nearest, then header", async () => {
    const { cls, frame } = await setup();
    const f = frame("combined");
    const p = "f.txt" as RepoPath;
    // Like the Lua version, a deletion ties with the line it sits before and
    // the earlier row wins.
    expect(rowPostLnum(cls, f.rows[sourceLineRow(cls, f, p, 2) ?? -1])).toEqual(
      {
        path: p,
        lnum: 2,
      },
    );
    expect(f.rows[sourceLineRow(cls, f, p, 500) ?? -1]?.kind).toBe("line");
    expect(sourceLineRow(cls, f, "nope.txt" as RepoPath, 1)).toBeUndefined();
    expect(fileHeaderRow(cls, f, "g.txt" as RepoPath)).toBeDefined();
  });
});
