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

  it("perform/undo/redo a seen plan with sticky overrides", async () => {
    const { s } = session();
    await s.refresh();
    const cur = s.current;
    if (!cur) throw new Error("no snapshot");
    const f = cur.model.files.find((x) => x.path === "a.txt");
    if (!f) throw new Error("no file");
    const owner = cur.cls.combinedOwner(f.path);
    const ids = f.hunks.flatMap((h) => cur.cls.changedIds(h, f.path, owner));
    const path = ids[0]?.path;
    if (!path) throw new Error("no ids");
    const unseen = () => s.current?.cls.progressCounts("combined").adds;
    await s.perform({
      kind: "seen",
      plan: { op: "mark", ids, sticky: [{ path, text: "X" }], clear: [] },
    });
    expect(unseen()).toBe(0);
    expect(s.current?.store.isSticky(path, "X")).toBe(true);
    expect((await s.undo())?.kind).toBe("seen");
    expect(unseen()).toBe(1);
    expect(s.current?.store.isSticky(path, "X")).toBe(false);
    await s.redo();
    expect(unseen()).toBe(0);
    expect(await s.redo()).toBeUndefined();
  });

  it("commentsHook places store comments on the display file", async () => {
    const { s } = session();
    await s.refresh();
    const cur = s.current;
    if (!cur) throw new Error("no snapshot");
    const idx = cur.model.files.findIndex((x) => x.path === "a.txt");
    const f = cur.model.files[idx];
    if (!f) throw new Error("no file");
    cur.store.addCommentRecord(f.path, {
      lnum: 2,
      content: [{ kind: "add", text: "X" }],
      text: "why X?",
      reply: undefined,
      origin: undefined,
    });
    const placed = s.commentsHook()({ scope: "combined", file: idx }, f);
    const all = [...placed.values()].flat();
    expect(all.map((p) => [p.record.text, p.outdated])).toEqual([
      ["why X?", false],
    ]);
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
