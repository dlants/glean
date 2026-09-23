import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../core/state.ts";
import type { RepoPath } from "../core/types.ts";
import { WORKTREE } from "../core/types.ts";
import { Git, type Outcome, spawnRunner } from "../git/git.ts";
import { buildModel, Classifier, loadWorktreeSeen } from "../session/model.ts";
import { makeRepo } from "../test/repo.ts";
import {
  commentOrigin,
  commentsAtLine,
  commentTarget,
  commentUnder,
  summaryCommentsIn,
} from "./commentActions.ts";
import { render } from "./render.ts";

function ok<T>(o: Outcome<T>): T {
  if (o.kind !== "ok") throw new Error(o.message);
  return o.value;
}
// The init_test fixture: c1 edits two, c2 edits three.
async function setup(
  commits: Parameters<typeof makeRepo>[0] = [
    { files: { "f.txt": "one\ntwo\nthree\n" } },
    { msg: "c1", files: { "f.txt": "one\nTWO\nthree\n" } },
    { msg: "c2", files: { "f.txt": "one\nTWO\nTHREE\n" } },
  ],
  dirty: Record<string, string> = {},
) {
  const repo = makeRepo(commits);
  for (const [f, t] of Object.entries(dirty))
    writeFileSync(join(repo.root, f), t);
  const target = Object.keys(dirty).length
    ? ({ kind: "worktree" } as const)
    : ({ kind: "ref", ref: "HEAD" } as const);
  const git = new Git({ repoRoot: repo.root, runner: spawnRunner(repo.env) });
  const store = new Store(mkdtempSync(join(tmpdir(), "glean-cm-")));
  const model = ok(await buildModel(git, repo.shas[0] ?? "", target));
  const wt = ok(await loadWorktreeSeen(git, repo.root, store, model));
  const cls = new Classifier(model, store, wt, undefined);
  const frame = (scope: "commits" | "combined") =>
    render({
      scope,
      cls,
      collapse: new Map(),
      isSticky: () => false,
      minSeenRun: 5,
      ignoreWhitespace: false,
    });
  return { repo, store, cls, frame };
}
const P = "f.txt" as RepoPath;

describe("comment authoring targets", () => {
  it("single line in commit scope: content, lnum and origin commit", async () => {
    const { repo, cls, frame } = await setup();
    const f = frame("commits");
    const row = f.lines.indexOf("TWO");
    const ct = commentTarget(cls, "commits", f.rows, row, row, false);
    expect(ct).toEqual({
      path: P,
      lnum: 2,
      content: [{ kind: "add", text: "TWO" }],
      origin: { sha: repo.shas[1], dirty: false },
    });
    // Decoration rows are not commentable.
    expect(commentTarget(cls, "commits", f.rows, 0, 0, false)).toBeUndefined();
  });
  it("visual span from the hunk header captures the contiguous diff-line run", async () => {
    const { repo, cls, frame } = await setup();
    const f = frame("combined");
    const hdr = f.lines.findIndex((l) => l.startsWith("--- @@"));
    const two = f.lines.indexOf("TWO");
    const ct = commentTarget(cls, "combined", f.rows, hdr, two, false);
    expect(ct?.content.length).toBeGreaterThanOrEqual(2);
    expect(ct?.content.some((e) => e.text.includes("@@"))).toBe(false);
    expect(ct?.content.at(-1)).toEqual({ kind: "add", text: "TWO" });
    // Combined scope: the last in-range commit touching the path.
    expect(ct?.origin).toEqual({ sha: repo.shas[2], dirty: false });
    // A del-only selection keeps its pre-image line and post-image slot.
    const del = f.lines.indexOf("two");
    expect(commentTarget(cls, "combined", f.rows, del, del, false)).toEqual(
      expect.objectContaining({
        lnum: 2,
        content: [{ kind: "del", text: "two", oldLnum: 2 }],
      }),
    );
  });
  it("commentUnder and summaryCommentsIn resolve rows to stored records once", async () => {
    const { store, cls } = await setup();
    const a = store.addCommentRecord(P, {
      lnum: 2,
      content: [{ kind: "add", text: "TWO" }],
      text: "a\nb",
      reply: undefined,
      origin: undefined,
    });
    const rows = [
      { kind: "summary-comment" as const, path: P, commentId: a.id },
      { kind: "summary-comment" as const, path: P, commentId: a.id },
      { kind: "blank" as const },
    ];
    expect(commentUnder(cls, store, rows[0])?.record.id).toBe(a.id);
    expect(commentUnder(cls, store, rows[2])).toBeUndefined();
    expect(summaryCommentsIn(store, rows, 2, 0)).toEqual([
      { path: P, record: a },
    ]);
  });
  const long = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const twoHunks = [
    { files: { "f.txt": `${long.join("\n")}\n` } },
    {
      msg: "c1",
      files: {
        "f.txt": `${long.map((l, i) => (i === 1 || i === 18 ? l.toUpperCase() : l)).join("\n")}\n`,
      },
    },
  ];
  it("capture stops where the selection crosses into another file", async () => {
    const { cls, frame } = await setup([
      { files: { "a.txt": "a\n", "b.txt": "b\n" } },
      { msg: "c1", files: { "a.txt": "A\n", "b.txt": "B\n" } },
    ]);
    const f = frame("combined");
    const a = f.lines.indexOf("A");
    const b = f.lines.indexOf("B");
    const ct = commentTarget(cls, "combined", f.rows, a, b, false);
    expect(ct?.path).toBe("a.txt");
    expect(ct?.content.map((e) => e.text)).not.toContain("B");
    expect(ct?.content.at(-1)).toEqual({ kind: "add", text: "A" });
  });
  it("commentsAtLine indexes lines across earlier hunks", async () => {
    const { cls, frame } = await setup(twoHunks);
    const f = frame("combined");
    const t = f.rows[f.lines.indexOf("L18")];
    const seen: number[] = [];
    commentsAtLine(cls, t, (_ref, file) => {
      const h0 = file.hunks[0]?.lines.length ?? 0;
      const li = file.hunks[1]?.lines.findIndex((l) => l.text === "L18") ?? -1;
      seen.push(h0 + li);
      return new Map();
    });
    expect(seen).toHaveLength(1);
    const r = commentsAtLine(cls, t, (_ref, file) => {
      const h0 = file.hunks[0]?.lines.length ?? 0;
      const li = file.hunks[1]?.lines.findIndex((l) => l.text === "L18") ?? -1;
      return new Map([[h0 + li, [{ record: { id: 7 } } as never]]]);
    });
    expect(r?.records).toEqual([{ id: 7 }]);
  });
  it("origin: dirty worktree edits and uncommitted paths", async () => {
    const { repo, cls, frame } = await setup(undefined, {
      "f.txt": "one\nTWO\nTHREE\nfour\n",
      "g.txt": "new\n",
    });
    const f = frame("combined");
    const four = f.lines.indexOf("four");
    expect(
      commentTarget(cls, "combined", f.rows, four, four, true)?.origin,
    ).toEqual({ sha: repo.shas[2], dirty: true });
    expect(
      commentOrigin(
        cls,
        "combined",
        { scope: "combined" } as never,
        "g.txt" as RepoPath,
        true,
      ),
    ).toEqual({ sha: WORKTREE, dirty: true });
    const wtIdx = cls.model.commits.findIndex((c) => c.sha === WORKTREE);
    expect(wtIdx).toBeGreaterThanOrEqual(0);
    expect(
      commentOrigin(
        cls,
        "commits",
        { scope: "commits", commit: wtIdx } as never,
        P,
        true,
      ),
    ).toEqual({ sha: WORKTREE, dirty: true });
  });
});
