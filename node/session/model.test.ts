import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as baseline from "../core/baseline.ts";
import { compile } from "../core/ignore.ts";
import { contentHash, Store } from "../core/state.ts";
import type {
  HeadLnum,
  LineId,
  RepoPath,
  WorktreeLnum,
} from "../core/types.ts";
import { Git, type Outcome, spawnRunner } from "../git/git.ts";
import { makeRepo, type TestRepo } from "../test/repo.ts";
import {
  buildModel,
  Classifier,
  loadWorktreeSeen,
  type ModelData,
} from "./model.ts";

function ok<T>(o: Outcome<T>): T {
  if (o.kind !== "ok") throw new Error(o.message);
  return o.value;
}
const P = (p: string) => p as RepoPath;
const store = () => new Store(mkdtempSync(join(tmpdir(), "glean-store-")));

async function setup(repo: TestRepo, worktree: boolean, s = store()) {
  const git = new Git({ repoRoot: repo.root, runner: spawnRunner(repo.env) });
  const base = repo.shas[0] ?? "";
  const model = ok(
    await buildModel(
      git,
      base,
      worktree ? { kind: "worktree" } : { kind: "ref", ref: "HEAD" },
    ),
  );
  const wt = ok(await loadWorktreeSeen(git, repo.root, s, model));
  return { git, model, store: s, cls: new Classifier(model, s, wt, undefined) };
}

function combinedIds(cls: Classifier, model: ModelData, path: string) {
  const file = model.files.find((f) => f.path === path);
  if (!file) throw new Error(`no ${path}`);
  const owner = cls.combinedOwner(file.path);
  return file.hunks.flatMap((h) => cls.changedIds(h, file.path, owner));
}

describe("model", () => {
  it("builds commits oldest first and the combined net diff", async () => {
    const repo = makeRepo([
      { files: { "a.txt": "1\n2\n3\n" } },
      { msg: "one", files: { "a.txt": "1\nX\n3\n" } },
      { msg: "two", files: { "b.txt": "b\n" } },
    ]);
    const { model } = await setup(repo, false);
    expect(model.commits.map((c) => c.summary)).toEqual(["one", "two"]);
    expect(model.files.map((f) => f.path).sort()).toEqual(["a.txt", "b.txt"]);
    expect(model.head).toBe(repo.shas[2]);
  });

  it("gives a line the same identity in both scopes", async () => {
    const repo = makeRepo([
      { files: { "a.txt": "1\n2\n3\n" } },
      { files: { "a.txt": "1\nX\n3\n" } },
      { files: { "a.txt": "1\nX\n3\nY\n" } },
    ]);
    const { model, cls } = await setup(repo, false);
    const commitIds = model.commits.flatMap((c) =>
      c.files.flatMap((f) =>
        f.hunks.flatMap((h) => cls.changedIds(h, f.path, cls.commitOwner(c))),
      ),
    );
    const combined = combinedIds(cls, model, "a.txt");
    // Every combined identity is one of the per-commit ones.
    for (const id of combined) expect(commitIds).toContainEqual(id);
    expect(combined).toContainEqual({
      kind: "committed-add",
      sha: repo.shas[2],
      path: "a.txt",
      lnum: 4,
    });
  });

  it("classifies committed seen marks and rolls them up", async () => {
    const repo = makeRepo([
      { files: { "a.txt": "1\n2\n" } },
      { files: { "a.txt": "1\nX\n" } },
    ]);
    const { model, cls, store: s } = await setup(repo, false);
    expect(cls.progressCounts("combined")).toEqual({
      files: 1,
      hunks: 1,
      adds: 1,
      dels: 1,
    });
    s.mark(combinedIds(cls, model, "a.txt"));
    expect(cls.progressCounts("combined")).toEqual({
      files: 0,
      hunks: 0,
      adds: 0,
      dels: 0,
    });
    expect(cls.commitSeen(model.commits[0] ?? model.commits[1]!)).toBe(true);
  });

  it("rolls seen files up into directory rows in both scopes", async () => {
    const repo = makeRepo([
      { files: { "d/a.txt": "1\n", "d/b.txt": "1\n" } },
      { files: { "d/a.txt": "1\nA\n", "d/b.txt": "1\nB\n" } },
    ]);
    const { model, cls, store: s } = await setup(repo, false);
    const commit = model.commits[0]!;
    const idx = (list: readonly { path: string }[], p: string) =>
      list.findIndex((f) => f.path === p);
    const all = [idx(model.files, "d/a.txt"), idx(model.files, "d/b.txt")];
    const commitAll = [0, 1];
    expect(cls.dirSeen({ scope: "combined", fileIndices: all })).toBe(false);
    s.mark(combinedIds(cls, model, "d/a.txt"));
    expect(cls.dirSeen({ scope: "combined", fileIndices: [all[0]!] })).toBe(
      true,
    );
    expect(cls.dirSeen({ scope: "combined", fileIndices: all })).toBe(false);
    s.mark(combinedIds(cls, model, "d/b.txt"));
    expect(cls.dirSeen({ scope: "combined", fileIndices: all })).toBe(true);
    expect(
      cls.dirSeen({ scope: "commits", commit, fileIndices: commitAll }),
    ).toBe(true);
  });
  it("decides worktree lines by the reviewed baseline and del ranges", async () => {
    const repo = makeRepo([{ files: { "a.txt": "1\n2\n3\n" } }]);
    writeFileSync(join(repo.root, "a.txt"), "1\nA\nB\n");
    const s = store();
    const head = ["1", "2", "3"];
    // Approve the first addition and deleting head line 2.
    s.setBaseline(
      P("a.txt"),
      contentHash(head),
      baseline.markAdds(head, ["1", "A", "B"], [2 as WorktreeLnum]),
      [[2 as HeadLnum, 2 as HeadLnum]],
    );
    const { model, cls } = await setup(repo, true, s);
    const seen = (id: LineId) => cls.idSeen(id);
    const ids = combinedIds(cls, model, "a.txt");
    expect(ids.filter(seen)).toEqual([
      { kind: "worktree-del", path: "a.txt", lnum: 2 },
      { kind: "worktree-add", path: "a.txt", lnum: 2 },
    ]);
    expect(model.commits.at(-1)?.sha).toBe("WORKTREE");
  });

  it("treats untracked lines as worktree-owned and .gleanignore as seen", async () => {
    const repo = makeRepo([{ files: { "a.txt": "1\n" } }]);
    writeFileSync(join(repo.root, "gen.txt"), "g\n");
    const { model, store: s } = await setup(repo, true);
    const cls = new Classifier(model, s, new Map(), compile("gen.txt\n"));
    const ids = combinedIds(cls, model, "gen.txt");
    expect(ids).toEqual([{ kind: "worktree-add", path: "gen.txt", lnum: 1 }]);
    expect(ids.every((id) => cls.idSeen(id))).toBe(true);
    expect(cls.progressCounts("combined").adds).toBe(0);
  });
});
