import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PostLnum, RepoPath } from "../core/types.ts";
import { Git, spawnRunner } from "../git/git.ts";
import { Session } from "../session/session.ts";
import { type CommitSpec, makeRepo } from "../test/repo.ts";
import { recordReviewUi } from "../test/ui.ts";
import { ReviewController } from "./review.ts";

async function open(spec: CommitSpec[], edit?: Record<string, string>) {
  const repo = makeRepo(spec);
  for (const [p, t] of Object.entries(edit ?? {}))
    writeFileSync(join(repo.root, p), t);
  const git = new Git({ repoRoot: repo.root, runner: spawnRunner(repo.env) });
  const session = new Session({
    git,
    base: repo.shas[0] ?? "",
    target: { kind: "worktree" },
    stateDir: mkdtempSync(join(tmpdir(), "glean-review-")),
  });
  const { ui, rec } = recordReviewUi();
  const c = new ReviewController(session, ui);
  await session.refresh();
  await c.redraw();
  const row = (pred: string | ((l: string) => boolean), from = 0) => {
    const f = typeof pred === "string" ? (l: string) => l === pred : pred;
    const i = rec.lines().findIndex((l, k) => k >= from && f(l));
    if (i < 0)
      throw new Error(`no row ${String(pred)}:\n${rec.lines().join("\n")}`);
    return i;
  };
  const hunks = () =>
    rec.lines().flatMap((l, i) => (l.includes("@@") ? [i] : []));
  return { repo, session, c, rec, row, hunks };
}
const twoFiles: CommitSpec[] = [
  { files: { "a.txt": "1\n", "b.txt": "1\n" } },
  { msg: "one", files: { "a.txt": "A\n", "b.txt": "B\n" } },
];

describe("ReviewController", () => {
  it("m marks a hunk and lands on the next unseen hunk; the last clamps", async () => {
    const h = await open(twoFiles);
    const [first] = h.hunks();
    await h.c.dispatch({ kind: "toggle-seen", row: first ?? 0 });
    expect(h.hunks()).toHaveLength(1);
    expect(h.rec.cursor).toBe(h.hunks()[0]);
    const last = h.hunks()[0] ?? 0;
    await h.c.dispatch({ kind: "toggle-seen", row: last });
    expect(h.hunks()).toHaveLength(0);
    expect(h.rec.cursor).toBeLessThan(h.rec.lines().length);
    expect(h.rec.cursor).toBe(Math.min(last, h.rec.lines().length - 1));
  });

  it("visual mark, unmark-hunk, U and u/<C-r>", async () => {
    const h = await open(twoFiles);
    const n = h.rec.lines().length;
    await h.c.dispatch({ kind: "visual-mark", srow: 0, erow: n - 1 });
    expect(h.hunks()).toHaveLength(0);
    await h.c.dispatch({ kind: "undo" });
    expect(h.hunks()).toHaveLength(2);
    expect(h.rec.cursor).toBe(0);
    await h.c.dispatch({ kind: "redo" });
    expect(h.hunks()).toHaveLength(0);
    await h.c.dispatch({ kind: "unmark-all" });
    expect(h.hunks()).toHaveLength(2);
    await h.c.dispatch({ kind: "toggle-seen", row: h.hunks()[0] ?? 0 });
    // The marked hunk collapses into its file's seen section; expand and unmark it.
    const seen = h.row((l) => l.includes("seen ("));
    await h.c.dispatch({ kind: "toggle-fold", row: seen });
    const back = h.row("A");
    await h.c.dispatch({ kind: "unmark-hunk", row: back });
    expect(h.hunks()).toHaveLength(2);
  });

  it("= collapses and expands a file", async () => {
    const h = await open(twoFiles);
    const header = h.row((l) => l.includes("a.txt"));
    await h.c.dispatch({ kind: "toggle-fold", row: header });
    expect(h.rec.lines()).not.toContain("A");
    await h.c.dispatch({
      kind: "toggle-fold",
      row: h.row((l) => l.includes("a.txt")),
    });
    expect(h.rec.lines()).toContain("A");
  });

  it("S keeps the cursor on the same line and expands a collapsed destination", async () => {
    const h = await open([
      { files: { "a.txt": "keep\n" } },
      { msg: "edit", files: { "a.txt": "keep\nadded line\n" } },
    ]);
    await h.c.dispatch({
      kind: "toggle-fold",
      row: h.row((l) => l.includes("a.txt")),
    });
    expect(h.rec.lines()).not.toContain("added line");
    await h.c.dispatch({ kind: "toggle-scope", row: 0 });
    expect(h.c.scope).toBe("commits");
    const r = h.row("added line");
    await h.c.dispatch({ kind: "toggle-scope", row: r });
    expect(h.c.scope).toBe("combined");
    expect(h.rec.lines()[h.rec.cursor ?? -1]).toBe("added line");
  });

  it("W round-trips the whitespace projection keeping the cursor", async () => {
    const h = await open([
      { files: { "a.txt": "a\nb\n" } },
      { msg: "e", files: { "a.txt": "a \nb\nNEW\n" } },
    ]);
    const r = h.row("NEW");
    await h.c.dispatch({ kind: "toggle-whitespace", row: r });
    expect(h.session.ignoreWhitespace).toBe(true);
    expect(h.rec.lines()[h.rec.cursor ?? -1]).toBe("NEW");
    await h.c.dispatch({ kind: "toggle-whitespace", row: h.rec.cursor ?? 0 });
    expect(h.session.ignoreWhitespace).toBe(false);
    expect(h.rec.lines()[h.rec.cursor ?? -1]).toBe("NEW");
  });

  it("c adds a comment from the editor; dismissing adds nothing", async () => {
    const h = await open(twoFiles);
    const r = h.row("A");
    h.rec.answer(undefined);
    await h.c.dispatch({ kind: "add-comment", srow: r, erow: r });
    expect(h.rec.lines().join("\n")).not.toContain("hello");
    h.rec.answer("hello");
    await h.c.dispatch({ kind: "add-comment", srow: r, erow: r });
    expect(h.rec.editors).toEqual([[], []]);
    expect(h.rec.lines().filter((l) => l.includes("hello"))).toHaveLength(2);
  });

  it("c on an uncommentable row notifies", async () => {
    const h = await open(twoFiles);
    await h.c.dispatch({ kind: "add-comment", srow: 0, erow: 0 });
    expect(h.rec.notes).toEqual([
      { msg: "glean: cannot comment here", level: "warn" },
    ]);
  });

  it("i with unchanged text pushes no undo; dd deletes", async () => {
    const h = await open(twoFiles);
    const r = h.row("A");
    h.rec.answer("note");
    await h.c.dispatch({ kind: "add-comment", srow: r, erow: r });
    const inline = h.row((l) => l.includes("note"));
    h.rec.answer("note");
    await h.c.dispatch({ kind: "edit-comment", row: inline });
    expect(h.rec.editors[1]).toEqual(["note"]);
    // The only undo entry is the add.
    await h.c.dispatch({ kind: "undo" });
    expect(h.rec.lines().join("\n")).not.toContain("note");
    await h.c.dispatch({ kind: "redo" });
    h.rec.answer("changed");
    await h.c.dispatch({
      kind: "edit-comment",
      row: h.row((l) => l.includes("note")),
    });
    expect(h.rec.lines().join("\n")).toContain("changed");
    await h.c.dispatch({
      kind: "delete-comment",
      row: h.row((l) => l.includes("changed")),
    });
    expect(h.rec.lines().join("\n")).not.toContain("changed");
  });

  it("dc with two comments picks which to delete; visual d over the summary is one undo", async () => {
    const h = await open(twoFiles);
    const r = h.row("A");
    h.rec.answer("first");
    await h.c.dispatch({ kind: "add-comment", srow: r, erow: r });
    h.rec.answer("second");
    await h.c.dispatch({ kind: "add-comment", srow: r, erow: r });
    h.rec.answer(1);
    await h.c.dispatch({ kind: "delete-comment-at", row: h.row("A") });
    expect(h.rec.picks).toEqual([["first", "second"]]);
    const text = () => h.rec.lines().join("\n");
    expect(text()).toContain("first");
    expect(text()).not.toContain("second");
    await h.c.dispatch({ kind: "undo" });
    expect(text()).toContain("second");
    const n = h.rec.lines().length;
    await h.c.dispatch({ kind: "delete-comments", srow: 0, erow: n - 1 });
    expect(text()).not.toContain("first");
    expect(text()).not.toContain("second");
    await h.c.dispatch({ kind: "undo" });
    expect(text()).toContain("first");
    expect(text()).toContain("second");
  });

  it("<CR> on a summary file row goes to the header; on a summary comment reveals it", async () => {
    const h = await open(twoFiles);
    const r = h.row("B");
    h.rec.answer("why B");
    await h.c.dispatch({ kind: "add-comment", srow: r, erow: r });
    // Mark b.txt so it collapses into the seen section.
    await h.c.dispatch({ kind: "toggle-seen", row: h.row("B") - 1 });
    const hits = () =>
      h.rec.lines().flatMap((l, i) => (l.includes("why B") ? [i] : []));
    const [summary] = hits();
    await h.c.dispatch({ kind: "jump", row: summary ?? 0, col: 0 });
    const cur = h.rec.cursor ?? -1;
    expect(h.rec.lines()[cur]).toContain("why B");
    expect(cur).not.toBe(summary);
    const fileRow =
      h.rec.frame?.rows.findIndex(
        (t) => t.kind === "summary-file" && t.path === "b.txt",
      ) ?? -1;
    expect(fileRow).toBeGreaterThanOrEqual(0);
    await h.c.dispatch({ kind: "jump", row: fileRow, col: 0 });
    const header = h.rec.cursor ?? -1;
    expect(header).not.toBe(fileRow);
    expect(h.rec.lines()[header]).toContain("b.txt");
  });

  it("<CR>/D on diff rows open the resolved target; a superseded jump never opens", async () => {
    const h = await open(twoFiles);
    const r = h.row("A");
    await h.c.dispatch({ kind: "jump", row: r, col: 3 });
    expect(h.rec.jumps).toEqual([
      {
        target: {
          kind: "live",
          path: "a.txt",
          lnum: 1,
          fallback: { rev: "HEAD", lnum: 1 },
        },
        col: 3,
      },
    ]);
    await Promise.all([
      h.c.dispatch({ kind: "jump", row: r, col: 0 }),
      h.c.dispatch({ kind: "jump", row: r, col: 1 }),
    ]);
    expect(h.rec.jumps.map((j) => j.col)).toEqual([3, 1]);
    await h.c.dispatch({ kind: "diffsplit", row: r });
    expect(h.rec.diffsplits).toHaveLength(1);
    expect(h.rec.diffsplits[0]?.ctx.path).toBe("a.txt");
  });

  it("gotoSource reveals a line of a collapsed seen file", async () => {
    const h = await open(twoFiles);
    await h.c.dispatch({ kind: "toggle-seen", row: h.row("A") - 1 });
    expect(h.rec.lines()).not.toContain("A");
    const row = await h.c.gotoSource("a.txt" as RepoPath, 1 as PostLnum);
    expect(row).toBeDefined();
    // Lands inside the revealed hunk.
    expect(["1", "A"]).toContain(h.rec.lines()[row ?? -1]);
    expect(h.rec.cursor).toBe(row);
    expect(
      await h.c.gotoSource("nope.txt" as RepoPath, 1 as PostLnum),
    ).toBeUndefined();
  });
});
