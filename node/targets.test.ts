import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Git, type GitRunner, type LogCommit, spawnRunner } from "./git/git.ts";
import {
  clampPage,
  type GhRunner,
  githubPrRepo,
  githubRemoteRepo,
  isPrArg,
  logSelection,
  openBranchSpec,
  openDirtySpec,
  openPrSpec,
  PR_LIST_ARGS,
  parsePrList,
  prPageCount,
  renderLog,
  renderPrs,
  resolveBranch,
  resolveDirty,
  resolvePr,
  reviewKey,
  reviewTitle,
} from "./targets.ts";
import { makeRepo } from "./test/repo.ts";

const gitFor = (root: string, env?: NodeJS.ProcessEnv) =>
  new Git({ repoRoot: root, runner: spawnRunner(env) });

/** A Git whose remote-url/fetch are scripted; fetches are recorded. */
function fakeGit(remote: string, fetches: string[]): Git {
  const runner: GitRunner = {
    async run(args) {
      if (args[0] === "remote") return { kind: "ok", stdout: `${remote}\n` };
      if (args[0] === "fetch") {
        fetches.push(`${args[1]}:${args[2]}`);
        return { kind: "ok", stdout: "" };
      }
      return { kind: "error", code: 1, stderr: "unexpected" };
    },
  };
  return new Git({ repoRoot: "/tmp/repo", runner });
}

describe("PR arguments", () => {
  it("is_pr_arg", () => {
    expect(isPrArg("123")).toBe(true);
    expect(isPrArg("https://github.com/acme/widgets/pull/123")).toBe(true);
    expect(isPrArg("https://github.com/acme/widgets/pull/123/files")).toBe(
      true,
    );
    expect(isPrArg("feature/123")).toBe(false);
    expect(isPrArg("abc123")).toBe(false);
  });
  it("github_pr_repo / github_remote_repo", () => {
    expect(githubPrRepo("https://github.com/Acme/Widgets/pull/4")).toBe(
      "acme/widgets",
    );
    expect(githubPrRepo("42")).toBeUndefined();
    for (const url of [
      "https://github.com/acme/widgets.git",
      "git@github.com:acme/widgets.git",
      "ssh://git@github.com/acme/widgets",
      "https://github.com/acme/widgets/",
    ])
      expect(githubRemoteRepo(url)).toBe("acme/widgets");
    expect(githubRemoteRepo("https://gitlab.com/a/b")).toBeUndefined();
  });
});

describe("resolvePr", () => {
  it("delegates to gh, fetches both sides, returns the head branch", async () => {
    const fetches: string[] = [];
    let ghArgs: readonly string[] = [];
    const gh: GhRunner = async (args) => {
      ghArgs = args;
      return {
        kind: "ok",
        stdout: JSON.stringify({
          number: 42,
          baseRefName: "main",
          headRefName: "feature/pr-review",
          baseRefOid: "base-oid",
          headRefOid: "head-oid",
        }),
      };
    };
    const url = "https://github.com/acme/widgets/pull/42";
    const git = fakeGit("git@github.com:acme/widgets.git", fetches);
    const r = await resolvePr(git, url, gh);
    expect(ghArgs[2]).toBe(url);
    expect(fetches).toEqual(["origin:pull/42/head", "origin:main"]);
    expect(r).toEqual({
      base: "base-oid",
      target: "head-oid",
      branch: "feature/pr-review",
      number: 42,
    });
    const spec = await openPrSpec(git, url, gh);
    expect(spec.identifier).toBe("PR #42");
    expect(spec.storageBranch).toBe("feature/pr-review");
  });
  it("rejects a PR URL of another repo before gh or fetch runs", async () => {
    const fetches: string[] = [];
    let ghCalled = false;
    const gh: GhRunner = async () => {
      ghCalled = true;
      return { kind: "ok", stdout: "{}" };
    };
    await expect(
      resolvePr(
        fakeGit("https://github.com/acme/widgets.git", fetches),
        "https://github.com/other/project/pull/42",
        gh,
      ),
    ).rejects.toThrow("other/project does not match origin acme/widgets");
    expect(ghCalled).toBe(false);
    expect(fetches).toEqual([]);
  });
  it("reports a gh failure", async () => {
    const gh: GhRunner = async () => ({ kind: "error", stderr: "boom" });
    await expect(resolvePr(fakeGit("", []), "1", gh)).rejects.toThrow(
      "glean: `gh pr view` failed: boom",
    );
  });
});

describe("resolveDirty / resolveBranch", () => {
  it("falls back to the trunk on the default branch, merge-base on a feature", async () => {
    const repo = makeRepo([
      { files: { "j.txt": "a\n" } },
      { msg: "c1", files: { "j.txt": "a\nb\n" } },
    ]);
    const git = gitFor(repo.root, repo.env);
    expect((await resolveDirty(git, "main")).base).toBe("main");
    const spec = await openDirtySpec(git, "main", undefined);
    expect(spec.identifier).toBe("main");
    expect(spec.target).toEqual({ kind: "worktree" });
    expect((await openDirtySpec(git, "main", "abc123")).identifier).toBe(
      "abc123",
    );
    repo.run(["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(repo.root, "j.txt"), "a\nB\n");
    repo.run(["commit", "-q", "-am", "feature commit"]);
    expect((await resolveDirty(git, "main")).base).toBe(repo.shas[1]);
  });
  it("branch: fork point base, local branch without origin, checkout untouched", async () => {
    const repo = makeRepo([
      { msg: "base", files: { "b.txt": "one\ntwo\n" } },
      { msg: "trunk moves on", files: { "b.txt": "one\ntwo\nthree\n" } },
    ]);
    repo.run(["branch", "feature", repo.shas[0] ?? ""]);
    repo.run(["checkout", "-q", "feature"]);
    writeFileSync(join(repo.root, "b.txt"), "one\ntwo\nFEATURE\n");
    repo.run(["commit", "-q", "-am", "feature edit"]);
    repo.run(["checkout", "-q", "main"]);
    const git = gitFor(repo.root, repo.env);
    expect(await resolveBranch(git, "feature", "main")).toEqual({
      base: repo.shas[0],
      target: "feature",
    });
    expect(repo.run(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    const spec = await openBranchSpec(git, "feature/review-ui", "main");
    expect(spec.identifier).toBe("feature/review-ui");
  });
  it("branch: prefers the remote tracking ref", async () => {
    const repo = makeRepo([
      { msg: "base", files: { "b.txt": "one\ntwo\n" } },
      { msg: "trunk moves on", files: { "b.txt": "one\ntwo\nthree\n" } },
    ]);
    repo.run(["branch", "feature", repo.shas[0] ?? ""]);
    repo.run(["checkout", "-q", "feature"]);
    writeFileSync(join(repo.root, "b.txt"), "one\ntwo\nFEATURE\n");
    repo.run(["commit", "-q", "-am", "feature edit"]);
    const tip = repo.run(["rev-parse", "HEAD"]);
    repo.run(["checkout", "-q", "main"]);
    const origin = mkdtempSync(join(tmpdir(), "glean-origin-"));
    execFileSync("git", ["init", "-q", "--bare", origin], { env: repo.env });
    repo.run(["remote", "add", "origin", origin]);
    repo.run(["push", "-q", "origin", "main", "feature"]);
    repo.run(["remote", "set-head", "origin", "main"]);
    const git = gitFor(repo.root, repo.env);
    const r = await resolveBranch(git, "feature", "main");
    expect(r.target).toBe("origin/feature");
    expect(repo.run(["rev-parse", r.target])).toBe(tip);
    expect(r.base).toBe(repo.shas[0]);
  });
});

describe("review titles", () => {
  const base = "a".repeat(40);
  const target = "b".repeat(40);
  const ref = { kind: "ref", ref: target } as const;
  it("abbreviates full oids; keeps symbolic identifiers with ∕", () => {
    expect(reviewTitle("/x/repo", "g1", { base, target: ref })).toBe(
      "Glean:g1 repo aaaaaaaa..bbbbbbbb",
    );
    expect(
      reviewTitle("/x/repo", "g2", {
        base,
        target: ref,
        identifier: "feature/review-ui",
      }),
    ).toBe("Glean:g2 repo feature∕review-ui [aaaaaaaa..bbbbbbbb]");
    expect(
      reviewTitle("/x/repo", "g3", {
        base: "main",
        target: { kind: "worktree" },
      }),
    ).toBe("Glean:g3 repo main..dirty");
  });
  it("keys reuse on the full refs", () => {
    expect(reviewKey("/r", { base, target: ref })).not.toBe(
      reviewKey("/r", { base, target: { kind: "ref", ref: "other" } }),
    );
  });
});

describe("log view", () => {
  const c = (n: number, parents: string[]): LogCommit =>
    ({
      sha: `${n}`.repeat(40),
      shortSha: `${n}`.repeat(8),
      summary: `c${n}`,
      parents,
    }) as LogCommit;
  // Newest first: c3 → c2 → c1 (root).
  const commits = [c(3, ["2".repeat(40)]), c(2, ["1".repeat(40)]), c(1, [])];
  const frame = renderLog("/x/repo", commits, true);
  it("renders the dirty row, history newest first and the more marker", () => {
    expect(frame.lines[0]).toBe("Glean log — repo");
    expect(frame.lines[1]).toContain("uncommitted changes");
    expect(frame.lines[2]).toBe("33333333  c3");
    expect(frame.lines.at(-1)).toContain("]p to load more");
    expect(frame.rowMap.get(1)).toBe(0);
    expect(frame.rowMap.get(2)).toBe(1);
  });
  it("maps selections to reviews", () => {
    const sel = (s: number, e: number) =>
      logSelection(commits, frame.rowMap, s, e);
    expect(sel(0, 0)).toEqual({ kind: "none" });
    expect(sel(1, 1)).toEqual({
      kind: "open",
      spec: { base: "HEAD", target: { kind: "worktree" }, identifier: "dirty" },
    });
    expect(sel(1, 2)).toMatchObject({
      spec: { base: "2".repeat(40), target: { kind: "worktree" } },
    });
    expect(sel(2, 2)).toEqual({
      kind: "open",
      spec: {
        base: "2".repeat(40),
        target: { kind: "ref", ref: "3".repeat(40) },
        identifier: "33333333",
      },
    });
    expect(sel(3, 2)).toMatchObject({
      spec: { base: "1".repeat(40), identifier: "22222222..33333333" },
    });
    expect(sel(2, 4)).toEqual({
      kind: "from-root",
      target: { kind: "ref", ref: "3".repeat(40) },
      identifier: "11111111..33333333",
    });
  });
});

describe("PR list view", () => {
  const prs = parsePrList(
    JSON.stringify(
      [1, 2, 3, 4, 5].map((i) => ({
        number: 100 + i,
        title: `PR title ${i}`,
        author: { login: `author${i}` },
        baseRefName: "main",
        headRefName: `feature-${i}`,
        isDraft: i === 2,
      })),
    ),
  );
  it("uses the old gh command", () => {
    expect(["gh", ...PR_LIST_ARGS].join(" ")).toBe(
      "gh pr list --state open --limit 1000 --json number,title,author,headRefName,baseRefName,isDraft",
    );
  });
  it("pages locally and maps rows to global indices", () => {
    expect(prPageCount(prs.length, 2)).toBe(3);
    const p1 = renderPrs("/x/repo", prs, 1, 2);
    expect(p1.lines[0]).toContain("page 1/3");
    expect(p1.lines[1]).toBe("#101  author1  main ← feature-1  PR title 1");
    expect(p1.lines[2]).toContain("[draft]");
    expect(p1.rowMap.get(1)).toBe(0);
    const p2 = renderPrs("/x/repo", prs, 2, 2);
    expect(p2.lines[0]).toContain("page 2/3");
    expect(p2.lines[1]).toContain("#103");
    expect(p2.rowMap.get(1)).toBe(2);
    expect(clampPage(99, prs.length, 2)).toBe(3);
    expect(clampPage(0, prs.length, 2)).toBe(1);
    expect(renderPrs("/x/r", [], 1, 2).lines[1]).toBe("No open pull requests");
  });
  it("rejects a non-array response", () => {
    expect(() => parsePrList("{}")).toThrow("invalid `gh pr list` response");
  });
});
