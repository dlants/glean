import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../core/state.ts";
import { Git, type Outcome, spawnRunner } from "../git/git.ts";
import { buildModel, Classifier, loadWorktreeSeen } from "../session/model.ts";
import { makeRepo } from "../test/repo.ts";
import {
  nextUnseenHunk,
  planToggleSeen,
  planUnmarkAll,
  planUnmarkHunk,
  planVisualMark,
  reviveDest,
  rowOfHunk,
  toggleCollapse,
} from "./actions.ts";
import { type CollapseState, render } from "./render.ts";

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
  const store = new Store(mkdtempSync(join(tmpdir(), "glean-actions-")));
  const model = ok(
    await buildModel(git, repo.shas[0] ?? "", { kind: "ref", ref: "HEAD" }),
  );
  const wt = ok(await loadWorktreeSeen(git, repo.root, store, model));
  return { store, cls: () => new Classifier(model, store, wt, undefined) };
}
const base = { isSticky: () => false, minSeenRun: 5, ignoreWhitespace: false };

describe("actions", () => {
  it("M unmarks the whole hunk from any of its rows; U unmarks everything", async () => {
    const { store, cls } = await setup();
    const f = render({
      ...base,
      scope: "commits",
      cls: cls(),
      collapse: new Map(),
    });
    const lines = f.rows.flatMap((t, i) => (t.kind === "line" ? [i] : []));
    const [first, second] = lines.filter((i) => f.lines[i] !== undefined);
    if (first === undefined || second === undefined) throw new Error("rows");
    // Partially mark the first hunk (its del), then M from its add row.
    const part = planVisualMark(cls(), "commits", f.rows, first, first);
    store.mark(part?.ids ?? []);
    const g = render({
      ...base,
      scope: "commits",
      cls: cls(),
      collapse: new Map(),
    });
    const addRow = g.rows.findIndex(
      (t) => t.kind === "line" && g.lines[g.rows.indexOf(t)]?.includes("X"),
    );
    const m = planUnmarkHunk(
      cls(),
      "commits",
      g.rows[addRow] ?? { kind: "blank" },
    );
    expect(m?.op).toBe("unmark");
    expect(m?.ids).toEqual(part?.ids);
    expect(m?.sticky).toEqual([]);
    expect(
      planUnmarkHunk(cls(), "commits", { kind: "mode-header" }),
    ).toBeUndefined();
    store.unmark(m?.ids ?? []);
    expect(planUnmarkAll(cls(), "commits")).toBeUndefined();
    // Mark both hunks; U in the combined scope unmarks all four ids and drops stickies.
    const all = planToggleSeen(
      cls(),
      "combined",
      render({
        ...base,
        scope: "combined",
        cls: cls(),
        collapse: new Map(),
      }).rows.find((t) => t.kind === "file-header") ?? { kind: "blank" },
    );
    store.mark(all?.ids ?? []);
    const u = planUnmarkAll(cls(), "combined");
    expect(u?.op).toBe("unmark");
    expect(u?.ids).toHaveLength(4);
    expect(u?.sticky).toHaveLength(4);
  });
  it("m on an unseen hunk marks it and lands on the next unseen hunk", async () => {
    const { store, cls } = await setup();
    const c = cls();
    const f = render({
      ...base,
      scope: "combined",
      cls: c,
      collapse: new Map(),
    });
    const row = f.rows.findIndex((t) => t.kind === "hunk-header");
    const t = f.rows[row];
    if (!t) throw new Error("no hunk");
    const plan = planToggleSeen(c, "combined", t);
    expect(plan?.op).toBe("mark");
    expect(plan?.ids).toHaveLength(2);
    expect(plan?.sticky).toHaveLength(2);
    const dest = nextUnseenHunk(f, row);
    store.mark(plan?.ids ?? []);
    const g = render({
      ...base,
      scope: "combined",
      cls: cls(),
      collapse: new Map(),
    });
    expect(g.lines).toContain("  ▶ seen (1 hunks)");
    expect(dest && rowOfHunk(g, dest)).toBeGreaterThan(0);
    const header = g.rows.findIndex((r) => r.kind === "file-header");
    const hp = planToggleSeen(
      cls(),
      "combined",
      g.rows[header] ?? { kind: "blank" },
    );
    expect(hp?.op).toBe("mark");
    expect(hp?.ids).toHaveLength(2);
    const destRow = dest === undefined ? -1 : (rowOfHunk(g, dest) ?? -1);
    // No seen hunk header is visible after it: land on the file's first unseen hunk.
    expect(reviveDest(g, destRow)).toBe(dest);
    expect(reviveDest(g, header)).toBeUndefined();
  });
  it("visual m marks only the selected changed lines", async () => {
    const { store, cls } = await setup();
    const c = cls();
    const f = render({
      ...base,
      scope: "combined",
      cls: c,
      collapse: new Map(),
    });
    const lineRows = f.rows.flatMap((t, i) => (t.kind === "line" ? [i] : []));
    const first = lineRows[0] ?? -1;
    const plan = planVisualMark(c, "combined", f.rows, first + 3, first);
    expect(plan?.op).toBe("mark");
    expect(plan?.ids).toHaveLength(2);
    store.mark(plan?.ids ?? []);
    const again = planVisualMark(cls(), "commits", f.rows, first, first + 3);
    expect(again).toBeUndefined();
    expect(planVisualMark(c, "combined", f.rows, 0, 0)).toBeUndefined();
  });
  it("collapse toggles flip the effective default", async () => {
    const { cls } = await setup();
    const c = cls();
    let collapse: CollapseState = new Map();
    const f = render({ ...base, scope: "commits", cls: c, collapse });
    const t = f.rows[1];
    if (!t) throw new Error("no row");
    collapse = toggleCollapse(c, collapse, t) ?? collapse;
    const g = render({ ...base, scope: "commits", cls: c, collapse });
    expect(g.lines[1]).toMatch(
      /^▶ ● [0-9a-f]{8} one {2}\(0 seen \/ 2 unseen\)$/,
    );
    expect(toggleCollapse(c, collapse, { kind: "blank" })).toBeUndefined();
  });
});
