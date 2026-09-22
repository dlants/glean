import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileEntry } from "../core/diff.ts";
import type { RepoPath } from "../core/types.ts";
import { makeRepo, type TestRepo } from "../test/repo.ts";
import {
  Git,
  type GitResult,
  type GitRunner,
  MAX_UNTRACKED_BYTES,
  type Outcome,
  Poller,
  spawnRunner,
} from "./git.ts";

const gitFor = (repo: TestRepo, root = repo.root) =>
  new Git({ repoRoot: root, runner: spawnRunner(repo.env) });

function ok<T>(o: Outcome<T>): T {
  if (o.kind !== "ok") throw new Error(o.message);
  return o.value;
}

const addTexts = (f: FileEntry) =>
  new Set(
    f.hunks.flatMap((h) =>
      h.lines.filter((l) => l.kind === "add").map((l) => l.text),
    ),
  );

function changed(files: readonly FileEntry[]) {
  return files.flatMap((f) =>
    f.hunks.flatMap((h) =>
      h.lines
        .filter((l) => l.kind !== "context")
        .map((l) =>
          [
            f.path,
            l.kind,
            l.kind === "add" ? "" : l.oldLnum,
            l.newLnum,
            l.text,
          ].join("|"),
        ),
    ),
  );
}
const P = (s: string) => s as RepoPath;

describe("git against a fixture repo", () => {
  const repo = makeRepo([
    { msg: "base", files: { "f.txt": "one\ntwo\nthree\n" } },
    { msg: "c1: edit two", files: { "f.txt": "one\nTWO\nthree\n" } },
    {
      msg: "c2: edit three + add g",
      files: { "f.txt": "one\nTWO\nTHREE\n", "g.txt": "gee\n" },
    },
  ]);
  const [base, , target] = repo.shas as unknown as [string, string, string];
  const git = gitFor(repo);

  it("logPatches", async () => {
    const commits = ok(await git.logPatches(base, target));
    expect(commits.map((c) => [c.sha, c.summary])).toEqual([
      [repo.shas[1], "c1: edit two"],
      [repo.shas[2], "c2: edit three + add g"],
    ]);
    const files = commits[0]!.files;
    expect(files.map((f) => f.path)).toEqual(["f.txt"]);
    const adds = files[0]!.hunks[0]!.lines.filter((l) => l.kind === "add");
    expect(adds).toEqual([{ kind: "add", text: "TWO", newLnum: 2 }]);
  });

  it("per-commit patches match diff C^ C", async () => {
    for (const c of ok(await git.logPatches(base, target))) {
      const direct = ok(await git.rangeDiff(`${c.sha}^`, c.sha));
      expect(changed(c.files).sort()).toEqual(changed(direct).sort());
    }
  });

  it("logCommits and paging", async () => {
    const commits = ok(await git.logCommits());
    expect(commits.length).toBe(3);
    expect(commits[0]!.sha).toBe(repo.shas[2]);
    expect(commits[0]!.summary).toBe("c2: edit three + add g");
    expect(commits[0]!.shortSha).toBe(repo.shas[2]!.slice(0, 8));
    expect(commits[0]!.parents[0]).toBe(repo.shas[1]);
    expect(commits[2]!.parents).toEqual([]);
    const page = ok(await git.logCommits({ limit: 2 }));
    expect(page.map((c) => c.sha)).toEqual([repo.shas[2], repo.shas[1]]);
    const rest = ok(await git.logCommits({ skip: 2, limit: 2 }));
    expect(rest.map((c) => c.sha)).toEqual([repo.shas[0]]);
  });

  it("combinedDiff, rangeDiff with path, show, revParse, mergeBase", async () => {
    const files = ok(await git.combinedDiff(base, target));
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get(P("g.txt"))?.kind).toBe("add");
    const adds = addTexts(byPath.get(P("f.txt"))!);
    expect(adds.has("TWO") && adds.has("THREE")).toBe(true);
    const one = ok(await git.rangeDiff(base, target, { path: P("g.txt") }));
    expect(one.map((f) => f.path)).toEqual(["g.txt"]);
    expect(ok(await git.show(base, P("f.txt")))).toBe("one\ntwo\nthree\n");
    expect(ok(await git.revParse(target))).toBe(target);
    expect(ok(await git.mergeBase(base, target))).toBe(base);
    expect(
      (await git.run(["blame", "-p", "nonexistent-ref", "--", "nope"])).kind,
    ).toBe("error");
  });

  it("showMany reads many blobs in one process", async () => {
    const m = ok(
      await git.showMany(target, [P("f.txt"), P("missing"), P("g.txt")]),
    );
    expect(m.get(P("f.txt"))).toEqual({
      kind: "found",
      text: "one\nTWO\nTHREE\n",
    });
    expect(m.get(P("g.txt"))).toEqual({ kind: "found", text: "gee\n" });
    expect(m.get(P("missing"))).toEqual({ kind: "missing" });
  });

  it("showMany walks multi-byte blobs by byte size", async () => {
    const r = makeRepo([
      { files: { u: "héllo 🎉\nwörld\n", v: "after\n", w: "last\n" } },
    ]);
    const m = ok(
      await gitFor(r).showMany(r.shas[0]!, [P("u"), P("v"), P("nope"), P("w")]),
    );
    expect(m.get(P("u"))).toEqual({ kind: "found", text: "héllo 🎉\nwörld\n" });
    expect(m.get(P("v"))).toEqual({ kind: "found", text: "after\n" });
    expect(m.get(P("nope"))).toEqual({ kind: "missing" });
    expect(m.get(P("w"))).toEqual({ kind: "found", text: "last\n" });
  });

  it("untracked skips binary, keeps empty files, placeholders huge ones", async () => {
    const r = makeRepo([{ files: { a: "a\n" } }]);
    writeFileSync(join(r.root, "bin"), "a\0b");
    writeFileSync(join(r.root, "empty"), "");
    writeFileSync(join(r.root, "huge"), "x".repeat(MAX_UNTRACKED_BYTES + 1));
    const u = ok(await gitFor(r).untracked());
    expect(u.map((f) => f.path)).toEqual(["empty", "huge"]);
    expect(u[0]!.hunks).toEqual([]);
    expect(u[1]!.hunks[0]!.lines).toHaveLength(1);
  });

  it("emptyTree, commonDir", async () => {
    expect(ok(await git.emptyTree())).toBe(
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    );
    const cd = ok(await git.commonDir());
    expect(cd.endsWith(".git")).toBe(true);
    const wt = join(tmpdir(), `glean_wt_${process.pid}_${Date.now()}`);
    repo.run(["worktree", "add", "--detach", wt]);
    expect(ok(await gitFor(repo, wt).commonDir())).toBe(cd);
    repo.run(["worktree", "remove", "--force", wt]);
    const other = makeRepo([{ msg: "x", files: { a: "a\n" } }]);
    expect(ok(await gitFor(other).commonDir())).not.toBe(cd);
  });

  it("working tree: worktreeDiff, diffToWorktree, untracked, mnemonicPrefix", async () => {
    writeFileSync(join(repo.root, "f.txt"), "ONE\nTWO\nTHREE\n");
    repo.run(["add", "--", "f.txt"]);
    writeFileSync(join(repo.root, "f.txt"), "ONE\nTWO\nthree-dirty\n");
    writeFileSync(join(repo.root, "u.txt"), "alpha\nbeta\n");

    const wt = ok(await git.worktreeDiff());
    expect(wt.map((f) => f.path)).toEqual(["f.txt"]);
    const wadds = addTexts(wt[0]!);
    expect(wadds.has("ONE") && wadds.has("three-dirty")).toBe(true);

    const all = new Map(
      ok(await git.diffToWorktree(base)).map((f) => [f.path, f]),
    );
    expect(all.has(P("g.txt"))).toBe(true);
    const fadds = addTexts(all.get(P("f.txt"))!);
    expect(fadds.has("TWO") && fadds.has("three-dirty")).toBe(true);

    const u = ok(await git.untracked());
    expect(u).toEqual([
      {
        path: "u.txt",
        oldPath: "u.txt",
        kind: "add",
        hunks: [
          {
            oldStart: 0,
            oldCount: 0,
            newStart: 1,
            newCount: 2,
            header: "@@ -0,0 +1,2 @@",
            lines: [
              { kind: "add", text: "alpha", newLnum: 1 },
              { kind: "add", text: "beta", newLnum: 2 },
            ],
          },
        ],
      },
    ]);

    repo.run(["config", "diff.mnemonicPrefix", "true"]);
    const paths = ok(await git.combinedDiff(base, target))
      .map((f) => f.path)
      .sort();
    expect(paths).toEqual(["f.txt", "g.txt"]);
  });
});

describe("git merge history", () => {
  it("first-parent walk keeps merge, drops side commits", async () => {
    const m = makeRepo([
      { msg: "base", files: { "f.txt": "one\ntwo\n" } },
      { msg: "main edit", files: { "f.txt": "ONE\ntwo\n" } },
      { msg: "side", branch: "side", files: { "s.txt": "side\n" } },
      { msg: "merge side", merge: "side" },
      { msg: "empty tail", empty: true },
    ]);
    const patches = ok(await gitFor(m).logPatches(m.shas[0]!, m.shas[4]!));
    expect(patches.map((p) => p.sha)).toEqual([
      m.shas[1],
      m.shas[3],
      m.shas[4],
    ]);
    expect(patches[1]!.files.map((f) => f.path)).toEqual(["s.txt"]);
    expect(patches[2]!.summary).toBe("empty tail");
    expect(patches[2]!.files).toEqual([]);
  });
});

describe("argument vectors", () => {
  const calls: string[] = [];
  const recorder: GitRunner = {
    run: async (args) => {
      calls.push(args.join("|"));
      return { kind: "ok", stdout: "" };
    },
  };
  const g = new Git({ repoRoot: "/nowhere", runner: recorder });
  const last = () => calls[calls.length - 1];
  const LOG =
    "log|--first-parent|--reverse|-p|-U0|-M|--no-color|--format=%x00%H%x09%s";
  const ws = { ignoreWhitespace: true };

  it("places the whitespace flag before refs and pathspecs", async () => {
    await g.logPatches("base", "target");
    expect(last()).toBe(`${LOG}|base..target`);
    await g.logPatches("base", "target", ws);
    expect(last()).toBe(`${LOG}|--ignore-all-space|base..target`);
    await g.logPatchesFromRoot("target", ws);
    expect(last()).toBe(`${LOG}|--ignore-all-space|--root|target`);
    await g.worktreeDiff({ ...ws, path: P("f.txt") });
    expect(last()).toBe("diff|--no-color|--ignore-all-space|HEAD|--|f.txt");
    await g.diffToWorktree("base", ws);
    expect(last()).toBe("diff|--no-color|--ignore-all-space|base");
    await g.diffRefs("base", "target", ws);
    expect(last()).toBe("diff|--no-color|--ignore-all-space|base|target");
    await g.combinedDiff("base", "target", { ...ws, path: P("f.txt") });
    expect(last()).toBe(
      "diff|--no-color|--ignore-all-space|base...target|--|f.txt",
    );
    await g.rangeDiff("base", "target", { ...ws, path: P("f.txt") });
    expect(last()).toBe(
      "diff|--no-color|--ignore-all-space|base..target|--|f.txt",
    );
    await g.worktreeDiff();
    expect(last()).toBe("diff|--no-color|HEAD");
  });
});

describe("whitespace-insensitive diffs", () => {
  it("hide whitespace edits and keep semantic ones", async () => {
    const w = makeRepo([
      {
        msg: "b",
        files: {
          "ws.txt": "plain\n  indented\ninternal space\n\nsemantic old\n",
        },
      },
      {
        msg: "c",
        files: {
          "ws.txt":
            "plain\n    indented\ninternal     space\n   \nsemantic new\n",
        },
      },
    ]);
    const g = gitFor(w);
    const [b, t] = w.shas as unknown as [string, string];
    const ws = { ignoreWhitespace: true };
    const semantic = "ws.txt|del|5|5|semantic old\nws.txt|add||5|semantic new";
    expect(changed(ok(await g.combinedDiff(b, t))).length).toBeGreaterThan(2);
    expect(changed(ok(await g.combinedDiff(b, t, ws))).join("\n")).toBe(
      semantic,
    );
    expect(
      changed(ok(await g.logPatches(b, t))[0]!.files).length,
    ).toBeGreaterThan(2);
    expect(changed(ok(await g.logPatches(b, t, ws))[0]!.files).join("\n")).toBe(
      semantic,
    );
    const root = ok(await g.logPatchesFromRoot(t, ws));
    expect(root.length).toBe(2);
    expect(changed(root[1]!.files).join("\n")).toBe(semantic);

    writeFileSync(
      join(w.root, "ws.txt"),
      "plain\n\tindented\ninternal space\n\nsemantic worktree\n",
    );
    expect(changed(ok(await g.worktreeDiff())).length).toBeGreaterThan(2);
    expect(changed(ok(await g.worktreeDiff(ws))).join("\n")).toBe(
      "ws.txt|del|5|5|semantic new\nws.txt|add||5|semantic worktree",
    );
    expect(changed(ok(await g.diffToWorktree(b, ws))).join("\n")).toBe(
      "ws.txt|del|5|5|semantic old\nws.txt|add||5|semantic worktree",
    );
  });
});

describe("timeouts and polling", () => {
  it("a hung git resolves as a timeout error", async () => {
    const hung: GitRunner = {
      run: (_a, o) =>
        new Promise<GitResult>((r) =>
          setTimeout(() => r({ kind: "timeout" }), o.timeoutMs),
        ),
    };
    const g = new Git({ repoRoot: "/x", runner: hung, timeoutMs: 5 });
    const r = await g.revParse("HEAD");
    expect(r.kind).toBe("timeout");
    expect((await g.poll()).kind).toBe("timeout");
    expect((await g.untrackedSig()).kind).toBe("timeout");
    expect((await g.showMany("HEAD", [P("a")])).kind).toBe("timeout");
    expect((await g.upstream()).kind).toBe("timeout");
  });

  it("spawnRunner kills a process that exceeds its timeout", async () => {
    const repo = makeRepo([{ files: { a: "a\n" } }]);
    const r = await spawnRunner(repo.env).run(
      ["-c", "alias.hang=!sleep 5", "hang"],
      {
        cwd: repo.root,
        timeoutMs: 50,
      },
    );
    expect(r.kind).toBe("timeout");
  });

  it("poll signature changes with the work tree", async () => {
    const repo = makeRepo([{ files: { a: "a\n" } }]);
    const g = gitFor(repo);
    const before = ok(await g.poll());
    expect(before.head).toBe(repo.shas[0]);
    writeFileSync(join(repo.root, "a"), "b\n");
    const after = ok(await g.poll());
    expect(after.sig).not.toBe(before.sig);
    expect(after.diffText).toContain("+b");
  });

  it("Poller never overlaps ticks", async () => {
    let running = 0;
    let maxRunning = 0;
    let release!: () => void;
    const p = new Poller(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise<void>((r) => {
        release = r;
      });
      running--;
    });
    const first = p.poke();
    expect(await p.poke()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(maxRunning).toBe(1);
  });

  it("Poller keeps polling after a tick rejects", async () => {
    let fail = true;
    const p = new Poller(async () => {
      if (fail) {
        fail = false;
        throw new Error("boom");
      }
    });
    await expect(p.poke()).rejects.toThrow("boom");
    expect(await p.poke()).toBe(true);
  });
});
