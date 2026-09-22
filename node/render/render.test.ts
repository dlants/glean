import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../core/state.ts";
import type { RepoPath } from "../core/types.ts";
import { Git, type Outcome, spawnRunner } from "../git/git.ts";
import { buildModel, Classifier, loadWorktreeSeen } from "../session/model.ts";
import { makeRepo } from "../test/repo.ts";
import { type CollapseKey, keys, render } from "./render.ts";

function ok<T>(o: Outcome<T>): T {
  if (o.kind !== "ok") throw new Error(o.message);
  return o.value;
}
async function setup() {
  const repo = makeRepo([
    { files: { "src/a.txt": "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n" } },
    {
      msg: "one",
      files: { "src/a.txt": "1\nX\n3\n4\n5\n6\n7\n8\n9\n10\n11\nY\n" },
    },
  ]);
  const git = new Git({ repoRoot: repo.root, runner: spawnRunner(repo.env) });
  const store = new Store(mkdtempSync(join(tmpdir(), "glean-render-")));
  const model = ok(
    await buildModel(git, repo.shas[0] ?? "", { kind: "ref", ref: "HEAD" }),
  );
  const wt = ok(await loadWorktreeSeen(git, repo.root, store, model));
  return {
    model,
    store,
    cls: () => new Classifier(model, store, wt, undefined),
  };
}
const base = { isSticky: () => false, minSeenRun: 5, ignoreWhitespace: false };

describe("render", () => {
  it("renders the combined scope with a row target per line", async () => {
    const { cls } = await setup();
    const f = render({
      ...base,
      scope: "combined",
      cls: cls(),
      collapse: new Map(),
    });
    expect(f.lines.length).toBe(f.rows.length);
    expect(f.lines[0]).toContain("unreviewed: 1 file / 2 hunks [+2 / -2]");
    expect(f.lines[1]).toBe("▼ src/a.txt [modify]");
    expect(f.rows.filter((r) => r.kind === "hunk-header")).toHaveLength(2);
    expect(f.intraBlocks).toHaveLength(2);
    expect(f.sections.map((s) => s.key)).toEqual(["header", "cf:src/a.txt"]);
  });
  it("seen hunks move into a collapsed seen section; collapse overrides apply", async () => {
    const { model, store, cls } = await setup();
    const path = "src/a.txt" as RepoPath;
    const c0 = cls();
    const hunk = model.files[0]?.hunks[0];
    if (!hunk) throw new Error("no hunk");
    store.mark(c0.changedIds(hunk, path, c0.combinedOwner(path)));
    const f = render({
      ...base,
      scope: "combined",
      cls: cls(),
      collapse: new Map(),
    });
    expect(f.lines).toContain("  ▶ seen (1 hunks)");
    const collapse = new Map<CollapseKey, boolean>([[keys.cfile(path), true]]);
    const g = render({ ...base, scope: "combined", cls: cls(), collapse });
    expect(
      g.lines.some((l) =>
        l.includes("src/a.txt [modify]  (1 seen / 1 unseen)"),
      ),
    ).toBe(true);
  });
  it("emits comment rows after their placed line", async () => {
    const { cls } = await setup();
    const record = {
      id: 7,
      lnum: 2,
      content: [],
      text: "why X?",
      reply: "because",
      origin: undefined,
    };
    const f = render({
      ...base,
      scope: "combined",
      cls: cls(),
      collapse: new Map(),
      comments: () => new Map([[1, [{ record, outdated: false }]]]),
    });
    const i = f.rows.findIndex((r) => r.kind === "comment");
    expect(f.lines[i]).toBe("    💬 why X?");
    expect(f.lines[i + 1]).toBe("      ↳ because");
    expect(f.rows[i - 1]).toMatchObject({ kind: "line", li: 1 });
  });
  it("renders commits with their files", async () => {
    const { cls } = await setup();
    const f = render({
      ...base,
      scope: "commits",
      cls: cls(),
      collapse: new Map(),
    });
    expect(f.rows[1]).toEqual({ kind: "commit-header", commit: 0 });
    expect(f.lines[1]).toMatch(/^▼ ● [0-9a-f]{8} one$/);
  });
});
