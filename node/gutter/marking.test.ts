import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contentHash } from "../core/state.ts";
import type { HeadLnum, RepoPath } from "../core/types.ts";
import { Git, spawnRunner } from "../git/git.ts";
import { Session } from "../session/session.ts";
import { makeRepo } from "../test/repo.ts";
import { fileStatus, planFileMarks } from "./marking.ts";

const F = "f.txt" as RepoPath;
const D = "d.txt" as RepoPath;

async function open() {
  const repo = makeRepo([
    { files: { "f.txt": "one\ntwo\nthree\n", "d.txt": "a\nb\nc\nd\ne\n" } },
    { msg: "c1", files: { "f.txt": "one\ntwo\nthree\nfour\n" } },
  ]);
  writeFileSync(join(repo.root, "f.txt"), "one\ntwo more\nthree\nfour\nfive\n");
  writeFileSync(join(repo.root, "d.txt"), "a\nd\ne\n");
  const s = new Session({
    git: new Git({ repoRoot: repo.root, runner: spawnRunner(repo.env) }),
    base: repo.shas[0] ?? "",
    target: { kind: "worktree" },
    stateDir: mkdtempSync(join(tmpdir(), "glean-mark-")),
  });
  await s.refresh();
  const cls = () => {
    if (!s.current) throw new Error("no snapshot");
    return s.current.cls;
  };
  const toggle = async (p: RepoPath, a: number, b: number, expand = false) => {
    const r = planFileMarks(cls(), p, a, b, expand);
    if (r.kind === "ok")
      await s.applySeen(r.plan.ids, r.plan.op, r.plan.sticky);
    return r;
  };
  const status = (p: RepoPath) => fileStatus(cls(), p);
  return { s, cls, toggle, status };
}

describe("file-buffer marking (toggle_mark_test)", () => {
  it("a range marks its rows, and a fully seen range unmarks", async () => {
    const { toggle, status } = await open();
    expect((await toggle(F, 4, 5)).kind).toBe("ok");
    expect(status(F)?.get(4)?.seen).toBe(true);
    expect(status(F)?.get(5)?.seen).toBe(true);
    expect(status(F)?.get(2)?.seen).toBe(false);
    await toggle(F, 4, 5);
    expect(status(F)?.get(4)?.seen).toBe(false);
  });
  it("a partial selection completes rather than flips", async () => {
    const { toggle, status } = await open();
    await toggle(F, 4, 4);
    const r = await toggle(F, 4, 5);
    expect(r.kind === "ok" && r.plan.op).toBe("mark");
    expect(status(F)?.get(4)?.seen).toBe(true);
    expect(status(F)?.get(5)?.seen).toBe(true);
  });
  it("no range widens to the hunk", async () => {
    const { toggle, status } = await open();
    await toggle(F, 2, 2, true);
    for (const l of [2, 4, 5]) expect(status(F)?.get(l)?.seen).toBe(true);
  });
  it("context rows and unknown paths are inert", async () => {
    const { toggle } = await open();
    expect((await toggle(F, 3, 3)).kind).toBe("inert");
    expect((await toggle("nope.txt" as RepoPath, 1, 1)).kind).toBe("inert");
  });
  it("uncommitted deletions mark explicit head lines", async () => {
    const { s, cls, toggle, status } = await open();
    expect(status(D)?.get(1)?.delBelow).toBe(true);
    expect(status(D)?.get(1)?.seen).toBe(false);
    await toggle(D, 1, 1);
    for (const l of [2, 3])
      expect(
        cls().idSeen({ kind: "worktree-del", path: D, lnum: l as HeadLnum }),
      ).toBe(true);
    expect(status(D)?.get(1)?.seen).toBe(true);
    const rec = s.current?.store.baseline(
      D,
      contentHash(["a", "b", "c", "d", "e"]),
    );
    expect(rec?.dels).toEqual([[2, 3]]);
    await toggle(D, 1, 1);
    expect(status(D)?.get(1)?.seen).toBe(false);
  });
});
