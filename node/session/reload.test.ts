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
});
