import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Git, type GitRunner, spawnRunner } from "../git/git.ts";
import { makeRepo } from "../test/repo.ts";
import { Session } from "./session.ts";

describe("reload", () => {
  it("reuses commit patches until HEAD moves", async () => {
    const repo = makeRepo([
      { files: { "f.txt": "a1\na2\na3\n", "g.txt": "b1\nb2\nb3\n" } },
      { files: { "f.txt": "a1\nA2\na3\n" } },
    ]);
    const inner = spawnRunner(repo.env);
    const calls: string[][] = [];
    const runner: GitRunner = {
      run: (args, opts) => {
        calls.push([...args]);
        return inner.run(args, opts);
      },
    };
    const s = new Session({
      git: new Git({ repoRoot: repo.root, runner }),
      base: repo.shas[0] ?? "",
      target: { kind: "worktree" },
      stateDir: mkdtempSync(join(tmpdir(), "glean-store-")),
    });
    const logs = () => calls.filter((a) => a[0] === "log").length;
    expect((await s.refresh()).kind).toBe("applied");
    expect(logs()).toBe(1);

    writeFileSync(join(repo.root, "g.txt"), "b1\nB2\nb3\n");
    calls.length = 0;
    expect((await s.refresh()).kind).toBe("applied");
    expect(logs()).toBe(0);
    const wt = s.current?.model.commits.at(-1);
    expect(wt?.files.map((f) => f.path)).toEqual(["g.txt"]);

    repo.run(["add", "-A"]);
    repo.run(["commit", "-q", "-m", "c2"]);
    calls.length = 0;
    expect((await s.refresh()).kind).toBe("applied");
    expect(logs()).toBe(1);
    expect(s.current?.model.commits).toHaveLength(3);
  });

  function traced(repo: ReturnType<typeof makeRepo>, ignoreWhitespace = false) {
    const inner = spawnRunner(repo.env);
    const calls: string[][] = [];
    const runner: GitRunner = {
      run: (args, opts) => {
        calls.push([...args]);
        return inner.run(args, opts);
      },
    };
    const s = new Session({
      git: new Git({ repoRoot: repo.root, runner }),
      base: repo.shas[0] ?? "",
      target: { kind: "worktree" },
      stateDir: mkdtempSync(join(tmpdir(), "glean-store-")),
      build: { ignoreWhitespace },
    });
    return { s, calls };
  }

  it("an idle poll refreshes and repaints nothing", async () => {
    const repo = makeRepo([
      { files: { "f.txt": "a\n" } },
      { files: { "f.txt": "b\n" } },
    ]);
    const { s, calls } = traced(repo);
    await s.refresh();
    let changes = 0;
    s.onChange = () => {
      changes++;
    };
    calls.length = 0;
    expect(await s.poll({ untracked: true })).toBe("unchanged");
    expect(changes).toBe(0);
    expect(calls.filter((a) => a[0] === "log")).toHaveLength(0);
  });

  it("untracked files are picked up only by the untracked tick", async () => {
    const repo = makeRepo([
      { files: { "f.txt": "a\n" } },
      { files: { "f.txt": "b\n" } },
    ]);
    const { s, calls } = traced(repo);
    await s.refresh();
    writeFileSync(join(repo.root, "new.txt"), "n\n");
    calls.length = 0;
    expect(await s.poll()).toBe("unchanged");
    expect(calls.some((a) => a[0] === "ls-files")).toBe(false);
    const paths = () => s.current?.model.files.map((f) => f.path) ?? [];
    expect(paths()).not.toContain("new.txt");
    expect(await s.poll({ untracked: true })).toBe("refreshed");
    expect(paths()).toContain("new.txt");
  });

  it("ignore-whitespace hides whitespace-only saves but keeps the exact model", async () => {
    const repo = makeRepo([
      { files: { "m.txt": "a\nb\nc\n" } },
      { files: { "m.txt": "a\nB\nc\n" } },
    ]);
    const { s } = traced(repo, true);
    await s.refresh();
    writeFileSync(join(repo.root, "m.txt"), "a\nB\n  c\n");
    expect(await s.poll()).toBe("refreshed");
    const wt = () => s.current?.model.commits.at(-1);
    expect(wt()?.files ?? []).toHaveLength(0);
    const canon = s.current?.model.canonicalFiles.find(
      (f) => f.path === "m.txt",
    );
    expect(
      canon?.hunks.flatMap((h) => h.lines).some((l) => l.text === "  c"),
    ).toBe(true);

    writeFileSync(join(repo.root, "m.txt"), "a\nB\n  c\nd\n");
    expect(await s.poll()).toBe("refreshed");
    const lines = wt()?.files.flatMap((f) => f.hunks.flatMap((h) => h.lines));
    expect(lines?.find((l) => l.kind === "add")).toMatchObject({
      text: "d",
      newLnum: 4,
    });
  });
});
