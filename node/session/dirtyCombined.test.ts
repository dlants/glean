// Port of dirty_combined_test (model level): marking in the combined scope of
// a work-tree review persists across a reload, and untracked files appear in
// both scopes and are markable.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Git, spawnRunner } from "../git/git.ts";
import { makeRepo } from "../test/repo.ts";
import { Session } from "./session.ts";

async function open(stateDir = mkdtempSync(join(tmpdir(), "glean-store-"))) {
  const repo = makeRepo([{ files: { "f.txt": "one\ntwo\nthree\n" } }]);
  writeFileSync(join(repo.root, "f.txt"), "one\nTWO\nthree\n");
  writeFileSync(join(repo.root, "new.txt"), "alpha\nbeta\n");
  const git = new Git({ repoRoot: repo.root, runner: spawnRunner(repo.env) });
  const s = new Session({
    git,
    base: "HEAD",
    target: { kind: "worktree" },
    stateDir,
  });
  await s.refresh();
  const snap = () => {
    const c = s.current;
    if (!c) throw new Error("no snapshot");
    return c;
  };
  const fileIds = (path: string) => {
    const { model, cls } = snap();
    const f = model.files.find((x) => x.path === path);
    if (!f) throw new Error(`no ${path}`);
    const owner = cls.combinedOwner(f.path);
    return f.hunks.flatMap((h) => cls.changedIds(h, f.path, owner));
  };
  const fileSeen = (path: string) => {
    const { model, cls } = snap();
    const f = model.files.find((x) => x.path === path);
    if (!f) throw new Error(`no ${path}`);
    const owner = cls.combinedOwner(f.path);
    return f.hunks.every((h) => cls.hunkSeen(h, f.path, owner));
  };
  return { s, snap, fileIds, fileSeen };
}

describe("dirty combined scope", () => {
  it("marks an uncommitted edit and keeps it across a reload", async () => {
    const { s, snap, fileIds, fileSeen } = await open();
    const ids = fileIds("f.txt");
    expect(ids.length).toBeGreaterThan(0);
    await s.applySeen(ids, "mark");
    expect(fileSeen("f.txt")).toBe(true);
    await s.refresh();
    expect(ids.every((id) => snap().cls.idSeen(id))).toBe(true);
  });

  it("shows untracked files in both scopes and marks them", async () => {
    const { s, snap, fileIds } = await open();
    const { model } = snap();
    expect(model.files.map((f) => f.path)).toContain("new.txt");
    const wt = model.commits.at(-1);
    expect(wt?.files.map((f) => f.path)).toContain("new.txt");
    const ids = fileIds("new.txt");
    expect(ids[0]).toEqual({ kind: "worktree-add", path: "new.txt", lnum: 1 });
    await s.applySeen(ids, "mark");
    expect(ids.every((id) => snap().cls.idSeen(id))).toBe(true);
  });
});
