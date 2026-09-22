// Port of wt_dup_lines_test: uncommitted deletions whose text repeats nearby
// must be markable and stay marked (explicit head-line del ranges).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Git, spawnRunner } from "../git/git.ts";
import { makeRepo } from "../test/repo.ts";
import { Session } from "./session.ts";

const HEAD = `$$;\n\n--\n-- Name: A\n--\n\nBODY A\n\n--\n-- Name: B\n--\n\nBODY B\n`;
const WT = `$$;\n\n--\n-- Name: B\n--\n\nBODY B\n`;

async function open() {
  const repo = makeRepo([{ files: { "schema.sql": HEAD } }]);
  writeFileSync(join(repo.root, "schema.sql"), WT);
  const git = new Git({ repoRoot: repo.root, runner: spawnRunner(repo.env) });
  const s = new Session({
    git,
    base: "HEAD",
    target: { kind: "worktree" },
    stateDir: mkdtempSync(join(tmpdir(), "glean-store-")),
  });
  await s.refresh();
  const snap = () => {
    const c = s.current;
    if (!c) throw new Error("no snapshot");
    return c;
  };
  const file = snap().model.files[0];
  const hunk = file?.hunks[0];
  if (!file || !hunk) throw new Error("no hunk");
  const owner = snap().cls.combinedOwner(file.path);
  const ids = () => snap().cls.changedIds(hunk, file.path, owner);
  const closed = () => snap().cls.hunkSeen(hunk, file.path, owner);
  return { s, snap, ids, closed };
}

describe("worktree duplicate-line deletions", () => {
  it("marking the whole hunk closes it", async () => {
    const { s, ids, closed } = await open();
    expect(ids()).toHaveLength(6);
    await s.applySeen(ids(), "mark");
    expect(closed()).toBe(true);
  });

  for (let hold = 0; hold < 6; hold++) {
    it(`holding out deletion ${hold + 1} leaves only it unseen`, async () => {
      const { s, snap, ids } = await open();
      const all = ids();
      const held = all[hold];
      if (!held) throw new Error("no id");
      const sel = all.filter((_, i) => i !== hold);
      await s.applySeen(sel, "mark");
      expect(sel.filter((id) => !snap().cls.idSeen(id))).toEqual([]);
      expect(snap().cls.idSeen(held)).toBe(false);
    });
  }

  it("unmark reopens and re-mark closes again", async () => {
    const { s, ids, closed } = await open();
    const all = ids();
    await s.applySeen(all, "mark");
    await s.applySeen(all, "unmark");
    expect(closed()).toBe(false);
    await s.applySeen(all, "mark");
    expect(closed()).toBe(true);
  });
});
