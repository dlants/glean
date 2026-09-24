import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { WorktreeLnum } from "../core/types.ts";
import { Git, spawnRunner } from "../git/git.ts";
import { Session } from "../session/session.ts";
import { makeRepo } from "../test/repo.ts";
import { type GutterBuffer, recordGutterUi } from "../test/ui.ts";
import { FileGutter } from "./fileGutter.ts";

const UNSEEN = "2:change 3:context+ 4:add 5:add";
const ROW4_SEEN = "2:change 3:context+ 4:add+ 5:add";
const F = 1;
const D = 2;
const L = (n: number) => n as WorktreeLnum;

async function setup() {
  const repo = makeRepo([
    { files: { "f.txt": "one\ntwo\nthree\n", "d.txt": "a\nb\nc\nd\ne\n" } },
    { msg: "c1", files: { "f.txt": "one\ntwo\nthree\nfour\n" } },
  ]);
  const f = ["one", "two more", "three", "four", "five"];
  const d = ["a", "d", "e"];
  writeFileSync(join(repo.root, "f.txt"), `${f.join("\n")}\n`);
  writeFileSync(join(repo.root, "d.txt"), `${d.join("\n")}\n`);
  const git = new Git({ repoRoot: repo.root, runner: spawnRunner(repo.env) });
  const session = new Session({
    git,
    base: repo.shas[0] ?? "",
    target: { kind: "worktree" },
    stateDir: mkdtempSync(join(tmpdir(), "glean-gutter-")),
  });
  await session.refresh();
  const buffers = new Map<number, GutterBuffer>([
    [F, { name: join(repo.root, "f.txt"), lines: f, modified: false, seq: 1 }],
    [D, { name: join(repo.root, "d.txt"), lines: d, modified: false, seq: 1 }],
  ]);
  const { ui, rec } = recordGutterUi(buffers);
  const g = new FileGutter(ui, () => session);
  const buf = (n: number) => buffers.get(n) as GutterBuffer;
  await g.refreshAll();
  const mark = (line1: number, line2?: number) =>
    g.handle({
      kind: "toggle-mark",
      buf: F,
      line1: L(line1),
      line2: L(line2 ?? line1),
    });
  const repaint = async () => {
    await session.refresh();
    await g.refreshAll();
  };
  return { repo, session, g, rec, buf, mark, repaint };
}

it("paints a worktree buffer, goes stale when modified, fresh on revert", async () => {
  const t = await setup();
  expect(t.rec.signs.get(F)).toBe(UNSEEN);
  expect(t.rec.attached.has(F)).toBe(true);
  t.buf(F).modified = true;
  await t.g.handle({ kind: "refresh", buf: F });
  expect(t.rec.signs.get(F)).toBe("2:stale 3:stale 4:stale 5:stale");
  t.buf(F).modified = false;
  await t.g.handle({ kind: "refresh", buf: F });
  expect(t.rec.signs.get(F)).toBe(UNSEEN);
});

it("marks lines and ranges, and undo/redo ride the stack", async () => {
  const t = await setup();
  await t.mark(4);
  await t.repaint();
  expect(t.rec.signs.get(F)).toBe(ROW4_SEEN);
  expect(t.rec.depth.get(F)).toMatchObject({ undo: 1, redo: 0 });
  await t.g.handle({ kind: "undo", buf: F, seq: 1 });
  await t.repaint();
  expect(t.rec.signs.get(F)).toBe(UNSEEN);
  expect(t.rec.parked.at(-1)).toEqual({ buf: F, row: 4 });
  expect(t.rec.depth.get(F)).toMatchObject({ undo: 0, redo: 1 });
  await t.g.handle({ kind: "redo", buf: F, seq: 1 });
  await t.repaint();
  expect(t.rec.signs.get(F)).toBe(ROW4_SEEN);
  await t.mark(2, 4);
  await t.repaint();
  expect(t.rec.signs.get(F)).toBe("2:change+ 3:context+ 4:add+ 5:add");
});

it("a novel edit wipes the stack", async () => {
  const t = await setup();
  await t.mark(4);
  await t.g.handle({ kind: "undo", buf: F, seq: 7 });
  await t.repaint();
  expect(t.rec.signs.get(F)).toBe(UNSEEN.replace("4:add ", "4:add+ "));
});

it("a write followed by a refresh reconciles before marking", async () => {
  const t = await setup();
  t.buf(F).lines = ["one", "two more", "three", "four", "five edited"];
  writeFileSync(
    join(t.repo.root, "f.txt"),
    "one\ntwo more\nthree\nfour\nfive edited\n",
  );
  await t.mark(5);
  await t.repaint();
  expect(t.rec.signs.get(F)).toBe("2:change 3:context+ 4:add 5:add+");
});

it("refuses a modified buffer or one out of date with the model", async () => {
  const t = await setup();
  t.buf(F).modified = true;
  await t.mark(4);
  expect(t.rec.notes.at(-1)?.msg).toContain("write it first");
  t.buf(F).modified = false;
  t.buf(F).lines = ["x"];
  await t.mark(1);
  expect(t.rec.notes.at(-1)?.msg).toContain("out of date");
});

it("gmc marks the hunk and focus covers it", async () => {
  const t = await setup();
  t.buf(F).cursor = 4;
  await t.g.handle({ kind: "focus", buf: F, row: L(4) });
  expect(t.rec.focus.get(F)).toBe("2:change 3:context+ 4:add 5:add");
  t.buf(F).cursor = 3;
  await t.g.handle({ kind: "focus", buf: F, row: L(3) });
  expect(t.rec.focus.get(F)).toBe("");
  await t.g.handle({ kind: "toggle-mark", buf: F, line1: L(2) });
  await t.repaint();
  expect(t.rec.signs.get(F)).toBe("2:change+ 3:context+ 4:add+ 5:add+");
});

it("uncommitted deletions mark and unmark", async () => {
  const t = await setup();
  expect(t.rec.signs.get(D)).toBe("1:del");
  await t.g.handle({ kind: "toggle-mark", buf: D, line1: L(1) });
  await t.repaint();
  expect(t.rec.signs.get(D)).toBe("1:del+");
  await t.g.handle({ kind: "toggle-mark", buf: D, line1: L(1) });
  await t.repaint();
  expect(t.rec.signs.get(D)).toBe("1:del");
});

it("]c parks on hunk starts, wrapping, within the buffer", async () => {
  const t = await setup();
  await t.g.handle({ kind: "goto-hunk", buf: F, row: L(1), dir: 1 });
  expect(t.rec.parked.at(-1)).toEqual({ buf: F, row: 2 });
  await t.g.handle({ kind: "goto-hunk", buf: F, row: L(5), dir: 1 });
  expect(t.rec.parked.at(-1)).toEqual({ buf: F, row: 2 });
  // A model row past the buffer's end is not parked on.
  t.buf(F).lines = ["one"];
  const n = t.rec.parked.length;
  await t.g.handle({ kind: "goto-hunk", buf: F, row: L(1), dir: 1 });
  expect(t.rec.parked.length).toBe(n);
});

it("per-buffer and global toggles stop painting and detach", async () => {
  const t = await setup();
  await t.g.handle({ kind: "toggle", buf: F });
  expect(t.rec.signs.get(F)).toBe("");
  expect(t.rec.attached.has(F)).toBe(false);
  await t.g.handle({ kind: "toggle", buf: F });
  expect(t.rec.signs.get(F)).toBe(UNSEEN);
  await t.g.setEnabled(false);
  expect(t.rec.signs.get(F)).toBe("");
  expect(t.rec.attached.size).toBe(0);
  await t.g.setEnabled(true);
  expect(t.rec.signs.get(F)).toBe(UNSEEN);
  expect(t.rec.attached.has(F)).toBe(true);
});
