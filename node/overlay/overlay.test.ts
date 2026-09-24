import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../core/state.ts";
import type { RepoPath } from "../core/types.ts";
import { Git, spawnRunner } from "../git/git.ts";
import { repoRelative } from "../glean.ts";
import type { FileUndo } from "../gutter/fileGutter.ts";
import { makeRepo } from "../test/repo.ts";
import { type RecBuffer, recordOverlayUi } from "../test/ui.ts";
import { Overlay } from "./overlay.ts";

const F = "f.txt" as RepoPath;
const FILES = { "f.txt": "alpha\nbeta\ngamma\n", "q.txt": "quiet\n" };

function setup(opts: { noRepo?: boolean } = {}) {
  const root = opts.noRepo
    ? mkdtempSync(join(tmpdir(), "glean-norepo-"))
    : makeRepo([{ files: FILES }]).root;
  if (opts.noRepo) writeFileSync(join(root, "f.txt"), "alpha\n");
  const stateDir = mkdtempSync(join(tmpdir(), "glean-ov-"));
  const buffers = new Map<number, RecBuffer>([
    [
      1,
      {
        name: join(root, "f.txt"),
        lines: ["alpha", "beta", "gamma"],
        modified: false,
        seq: 0,
      },
    ],
    [
      2,
      {
        name: join(root, "q.txt"),
        lines: ["quiet"],
        modified: false,
        seq: 0,
      },
    ],
  ]);
  const { ui, rec } = recordOverlayUi(buffers, root);
  const undos: FileUndo[] = [];
  const git = new Git({ repoRoot: root, runner: spawnRunner() });
  const store = async () => {
    const s = new Store(stateDir);
    await s.load([]);
    return s;
  };
  const ov = new Overlay(ui, {
    async repoContext() {
      if (opts.noRepo) throw new Error("not a repo");
      return { root, git, store: await store() };
    },
    repoRelative,
    async pushUndo(_buf, _seq, a) {
      undos.push(a);
    },
    afterWrite() {},
  });
  const buf = (n: number) => buffers.get(n) as RecBuffer;
  /** Let a scripted editor/pick answer run its continuation. */
  const settle = async () => {
    await new Promise((r) => setImmediate(r));
    await ov.handle({ kind: "refresh", buf: 1 });
  };
  const recs = async () => (await store()).commentsFor(F);
  const run = async (u: FileUndo | undefined, reverse: boolean) => {
    if (u?.kind !== "comment") throw new Error("no comment undo");
    await u.run(reverse);
  };
  const add = async (text: string, line1 = 2, line2 = line1) => {
    rec.answer(text);
    await ov.handle({ kind: "add", buf: 1, line1, line2 });
    await settle();
  };
  return { ov, rec, buf, undos, settle, recs, run, add, root, store };
}

it("stamps resolved comments, follows edits, and outdates deleted lines", async () => {
  const t = setup();
  await t.add("note");
  const signRows = () =>
    (t.rec.stamps.get(1) ?? [])
      .filter((s) => "sign_text" in s.opts)
      .map((s) => s.row);
  expect(signRows()).toEqual([1]);
  expect(t.rec.activated).toEqual([1]);
  t.buf(1).lines = ["new", "alpha", "beta", "gamma"];
  await t.ov.handle({ kind: "refresh", buf: 1 });
  expect(signRows()).toEqual([2]);
  expect((await t.recs())[0]?.lnum).toBe(3);
  t.buf(1).lines = ["new", "alpha", "gamma"];
  await t.ov.handle({ kind: "refresh", buf: 1 });
  expect(
    t.rec.stamps
      .get(1)
      ?.some((s) => s.opts.sign_hl_group === "GleanCommentOutdated"),
  ).toBe(true);
});

it("re-stamps after an api write via refreshAll", async () => {
  const t = setup();
  await t.ov.handle({ kind: "refresh", buf: 1 });
  expect(t.rec.stamps.get(1)).toEqual([]);
  const s = await t.store();
  s.addCommentRecord(F, {
    lnum: 3,
    content: [{ kind: "add", text: "gamma" }],
    text: "api",
    reply: undefined,
    origin: undefined,
  });
  await s.save(s.wtShard);
  await t.ov.refreshAll();
  expect(t.rec.stamps.get(1)?.[0]?.row).toBe(2);
});

it("a buffer with no comments gets no stamps and no undo takeover", async () => {
  const t = setup();
  await t.ov.handle({ kind: "refresh", buf: 2 });
  expect(t.rec.stamps.get(2)).toEqual([]);
  expect(t.rec.activated).toEqual([]);
});

it("adds on a line and a range with HEAD / dirty origin", async () => {
  const t = setup();
  await t.add("one");
  t.buf(1).modified = true;
  await t.add("range", 1, 3);
  const [a, b] = await t.recs();
  expect(a?.origin?.dirty).toBe(false);
  expect(a?.content.map((c) => c.text)).toEqual(["beta"]);
  expect(b?.origin?.dirty).toBe(true);
  expect(b?.content.map((c) => c.text)).toEqual(["alpha", "beta", "gamma"]);
  expect(t.undos).toHaveLength(2);
});

it("undo/redo of an add keeps the same id; a dismissed editor adds nothing", async () => {
  const t = setup();
  t.rec.answer(undefined);
  await t.ov.handle({ kind: "add", buf: 1, line1: 2, line2: 2 });
  await t.settle();
  expect(await t.recs()).toEqual([]);
  await t.add("x");
  const id = (await t.recs())[0]?.id;
  await t.run(t.undos[0], true);
  expect(await t.recs()).toEqual([]);
  await t.run(t.undos[0], false);
  expect((await t.recs())[0]?.id).toBe(id);
});

it("edit round-trips through undo; unchanged edit pushes nothing", async () => {
  const t = setup();
  await t.add("before");
  t.rec.answer("before");
  await t.ov.handle({ kind: "edit", buf: 1, lnum: 2 });
  await t.settle();
  expect(t.undos).toHaveLength(1);
  t.rec.answer("after");
  await t.ov.handle({ kind: "edit", buf: 1, lnum: 2 });
  await t.settle();
  expect(t.rec.editors.at(-1)).toEqual(["before"]);
  expect((await t.recs())[0]?.text).toBe("after");
  await t.run(t.undos[1], true);
  expect((await t.recs())[0]?.text).toBe("before");
});

it("reply fills then replaces the slot, each undoable", async () => {
  const t = setup();
  await t.add("c");
  t.rec.answer("r1");
  await t.ov.handle({ kind: "reply", buf: 1, lnum: 2 });
  await t.settle();
  t.rec.answer("r2");
  await t.ov.handle({ kind: "reply", buf: 1, lnum: 2 });
  await t.settle();
  expect(t.rec.editors.at(-1)).toEqual(["r1"]);
  expect((await t.recs())[0]?.reply).toBe("r2");
  await t.run(t.undos[2], true);
  expect((await t.recs())[0]?.reply).toBe("r1");
  await t.run(t.undos[1], true);
  expect((await t.recs())[0]?.reply).toBeUndefined();
});

it("delete asks which of several; a dismissed pick deletes nothing", async () => {
  const t = setup();
  await t.add("first");
  await t.add("second");
  t.rec.answer(undefined);
  await t.ov.handle({ kind: "delete", buf: 1, lnum: 2 });
  await t.settle();
  expect(await t.recs()).toHaveLength(2);
  t.rec.answer(1);
  await t.ov.handle({ kind: "delete", buf: 1, lnum: 2 });
  await t.settle();
  expect(t.rec.picks.at(-1)).toEqual({
    items: ["first", "second"],
    title: "glean: delete comment",
  });
  expect((await t.recs()).map((r) => r.text)).toEqual(["first"]);
  await t.run(t.undos.at(-1), true);
  expect(await t.recs()).toHaveLength(2);
  await t.ov.handle({ kind: "delete", buf: 1, lnum: 3 });
  expect(t.rec.notes.at(-1)?.msg).toBe("glean: no comment on this line");
});

it("show floats bodies, jump parks, quickfix lists", async () => {
  const t = setup();
  await t.add("hello");
  await t.ov.handle({ kind: "show", buf: 1, lnum: 2 });
  expect(t.rec.floats[0]?.some((l) => l.text.includes("hello"))).toBe(true);
  await t.ov.handle({ kind: "jump", buf: 1, lnum: 1, dir: 1 });
  expect(t.rec.parked).toEqual([{ buf: 1, lnum: 2 }]);
  await t.ov.handle({ kind: "quickfix", buf: 1 });
  expect(t.rec.quickfix).toHaveLength(1);
  expect(t.rec.quickfix?.[0]).toMatchObject({ lnum: 2 });
});

it("outside a repo, add only notifies", async () => {
  const t = setup({ noRepo: true });
  await t.ov.handle({ kind: "add", buf: 1, line1: 1, line2: 1 });
  expect(t.rec.editors).toEqual([]);
  expect(t.rec.notes[0]?.level).toBe("warn");
});
