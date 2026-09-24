import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PostLnum, PreLnum, RepoPath } from "../core/types.ts";
import { Git, spawnRunner } from "../git/git.ts";
import type { JumpTarget } from "../render/nav.ts";
import { makeRepo } from "../test/repo.ts";
import { resolveJump } from "./jump.ts";

const path = "a.txt" as RepoPath;
function setup() {
  const repo = makeRepo([
    { files: { "a.txt": "1\n2\n3\n" } },
    { msg: "two", files: { "a.txt": "1\nX\n3\n" } },
    { msg: "head", files: { "a.txt": "0\n1\nX\n3\n" } },
  ]);
  const git = new Git({ repoRoot: repo.root, runner: spawnRunner(repo.env) });
  return { repo, git };
}

describe("resolveJump", () => {
  it("is live for the work tree and HEAD", async () => {
    const { git, repo } = setup();
    const post = (rev: string | undefined): JumpTarget => ({
      kind: "post",
      ref: rev ? { kind: "rev", rev } : { kind: "worktree" },
      path,
      lnum: 2 as PostLnum,
      text: "1",
    });
    expect(await resolveJump(git, post(undefined))).toEqual({
      kind: "live",
      path,
      lnum: 2,
      fallback: { rev: "HEAD", lnum: 2 },
    });
    expect((await resolveJump(git, post(repo.shas[2] ?? ""))).kind).toBe(
      "live",
    );
  });

  it("maps a surviving committed line into the work tree, else opens the blob", async () => {
    const { git, repo } = setup();
    const sha = repo.shas[1] ?? "";
    const jt = {
      kind: "post",
      ref: { kind: "rev", rev: sha },
      path,
      lnum: 2 as PostLnum,
      text: "X",
    } as const;
    expect(await resolveJump(git, jt)).toEqual({
      kind: "live",
      path,
      lnum: 3,
      fallback: { rev: sha, lnum: 2 },
    });
    // An unsaved buffer counts: the reader overrides what is on disk.
    expect((await resolveJump(git, jt, async () => "Y")).kind).toBe("scratch");
    writeFileSync(join(repo.root, "a.txt"), "0\n1\nY\n3\n");
    expect(await resolveJump(git, jt)).toEqual({
      kind: "scratch",
      path,
      lnum: 2,
      rev: sha,
    });
  });

  it("a deleted line always opens its pre-image blob", async () => {
    const { git, repo } = setup();
    const rev = `${repo.shas[1]}^`;
    expect(
      await resolveJump(git, {
        kind: "del",
        ref: { kind: "rev", rev },
        path,
        lnum: 2 as PreLnum,
      }),
    ).toEqual({ kind: "scratch", path, lnum: 2, rev });
  });
});
