import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../core/state.ts";
import { Git, type Outcome, spawnRunner } from "../git/git.ts";
import {
  buildModel,
  Classifier,
  loadWorktreeSeen,
  type Scope,
} from "../session/model.ts";
import { makeRepo } from "../test/repo.ts";
import { resolveFile } from "./actions.ts";
import { cursorAnchor, restoreAnchor } from "./anchor.ts";
import { type Frame, render } from "./render.ts";

function ok<T>(o: Outcome<T>): T {
  if (o.kind !== "ok") throw new Error(o.message);
  return o.value;
}
async function setup() {
  const repo = makeRepo([
    {
      msg: "base",
      files: { "a.txt": "l1\nl2\nl3\nl4\nl5\n", "b.txt": "b1\n" },
    },
    { msg: "c1", files: { "a.txt": "l1\nALPHA\nl3\nTEMP\nl5\n" } },
    {
      msg: "c2",
      files: { "a.txt": "ALPHA\nl3\nTEMP\nBETA\n", "b.txt": "B1\n" },
    },
    { msg: "c3", files: { "a.txt": "ALPHA\nl3\nBETA\n" } },
  ]);
  const git = new Git({ repoRoot: repo.root, runner: spawnRunner(repo.env) });
  const store = new Store(mkdtempSync(join(tmpdir(), "glean-anchor-")));
  const model = ok(
    await buildModel(git, repo.shas[0] ?? "", { kind: "ref", ref: "HEAD" }),
  );
  const wt = ok(await loadWorktreeSeen(git, repo.root, store, model));
  const cls = new Classifier(model, store, wt, undefined);
  const frame = (scope: Scope) =>
    render({
      scope,
      cls,
      collapse: new Map(),
      isSticky: () => false,
      minSeenRun: 5,
      ignoreWhitespace: false,
    });
  return { cls, frame };
}
const rowWith = (f: Frame, text: string) =>
  f.rows.findIndex((t, i) => t.kind === "line" && f.lines[i]?.endsWith(text));

describe("scope toggle cursor anchor", () => {
  it("keeps the same physical line across scopes and round trips", async () => {
    const { cls, frame } = await setup();
    const comb = frame("combined");
    const commits = frame("commits");
    for (const text of ["ALPHA", "BETA"]) {
      const row = rowWith(comb, text);
      expect(row).toBeGreaterThanOrEqual(0);
      const a = cursorAnchor(cls, comb.rows[row]);
      if (!a) throw new Error("no anchor");
      const dest = restoreAnchor(cls, commits, a) ?? -1;
      expect(commits.lines[dest]).toMatch(new RegExp(`${text}$`));
      const back = cursorAnchor(cls, commits.rows[dest]);
      if (!back) throw new Error("no anchor");
      expect(restoreAnchor(cls, comb, back)).toBe(row);
    }
  });
  it("a header lands on the same file's header", async () => {
    const { cls, frame } = await setup();
    const comb = frame("combined");
    const commits = frame("commits");
    const hdr = comb.rows.findIndex(
      (t) =>
        t.kind === "file-header" &&
        resolveFile(cls, t.file)?.file.path === "b.txt",
    );
    const a = cursorAnchor(cls, comb.rows[hdr]);
    if (!a) throw new Error("no anchor");
    const dest = restoreAnchor(cls, commits, a) ?? -1;
    const t = commits.rows[dest];
    expect(t?.kind).toBe("file-header");
  });
});
