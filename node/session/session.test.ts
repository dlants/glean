import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Git, spawnRunner } from "../git/git.ts";
import { makeRepo } from "../test/repo.ts";
import { Session } from "./session.ts";

function session() {
  const repo = makeRepo([
    { files: { "a.txt": "1\n2\n" } },
    { files: { "a.txt": "1\nX\n" } },
  ]);
  const git = new Git({ repoRoot: repo.root, runner: spawnRunner(repo.env) });
  const s = new Session({
    git,
    base: repo.shas[0] ?? "",
    target: { kind: "worktree" },
    stateDir: mkdtempSync(join(tmpdir(), "glean-store-")),
  });
  return { repo, s };
}

describe("Session", () => {
  it("refreshes into a snapshot", async () => {
    const { s } = session();
    const r = await s.refresh();
    expect(r.kind).toBe("applied");
    expect(s.current?.cls.progressCounts("combined").adds).toBe(1);
  });

  it("drops a refresh superseded by a newer one", async () => {
    const { s } = session();
    const [a, b] = await Promise.all([s.refresh(), s.refresh()]);
    expect(a.kind).toBe("stale");
    expect(b.kind).toBe("applied");
  });

  it("polls: baseline first, then refresh only on change", async () => {
    const { repo, s } = session();
    let changes = 0;
    s.onChange = () => changes++;
    expect(await s.poll()).toBe("unchanged");
    expect(await s.poll()).toBe("unchanged");
    expect(changes).toBe(0);
    writeFileSync(join(repo.root, "a.txt"), "1\nX\nY\n");
    expect(await s.poll()).toBe("refreshed");
    expect(changes).toBe(1);
    expect(s.current?.cls.progressCounts("combined").adds).toBe(2);
  });
});
