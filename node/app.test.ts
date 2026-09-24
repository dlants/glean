import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { App, type AppUi, type OpenConfig } from "./app.ts";
import { spawnRunner } from "./git/git.ts";
import type { ListFrame } from "./targets.ts";
import { type CommitSpec, makeRepo } from "./test/repo.ts";
import { recordReviewUi } from "./test/ui.ts";
import type { NotifyLevel } from "./view/review.ts";
import { ReviewController } from "./view/review.ts";

function setup(spec: CommitSpec[], cfg: Partial<OpenConfig> = {}) {
  const repo = makeRepo(spec);
  let nextBuf = 1;
  const rec = {
    valid: new Set<number>(),
    shown: [] as number[],
    names: new Map<number, string>(),
    lists: new Map<number, ListFrame>(),
    notes: [] as { msg: string; level: NotifyLevel }[],
    reviews: new Map<number, ReturnType<typeof recordReviewUi>["rec"]>(),
    file: { name: "", lnum: 1 },
  };
  const config: OpenConfig = {
    cwd: repo.root,
    bufName: "",
    dataDir: mkdtempSync(join(tmpdir(), "glean-app-")),
    stateOverride: mkdtempSync(join(tmpdir(), "glean-app-store-")),
    minSeenRun: undefined,
    ignoreWs: false,
    defaultBase: repo.shas[0] ?? "",
    hunkIndent: 2,
    hunkIndentDelayMs: 0,
    pollMs: 60_000,
    logPageSize: 50,
    ...cfg,
  };
  const newBuf = (name: string) => {
    const b = nextBuf++;
    rec.valid.add(b);
    rec.names.set(b, name);
    rec.shown.push(b);
    return b;
  };
  const ui: AppUi = {
    config: async () => config,
    cursorFile: async () => rec.file,
    bufValid: async (b) => rec.valid.has(b),
    openReviewBuffer: async (t) => newBuf(t),
    renameBuffer: async (b, t) => void rec.names.set(b, t),
    showBuffer: async (b) => void rec.shown.push(b),
    wipeBuffer: async (b) => void rec.valid.delete(b),
    blankBuffer: async () => undefined,
    setCursor: async () => undefined,
    openListBuffer: async (kind, root) =>
      newBuf(`Glean:${basename(root)} ${kind}`),
    paintList: async (b, f) => void rec.lists.set(b, f),
    notify: async (msg, level) => void rec.notes.push({ msg, level }),
    review(buf, session, opts) {
      const r = recordReviewUi();
      rec.reviews.set(buf, r.rec);
      const controller = new ReviewController(session, r.ui, opts);
      return {
        controller,
        session,
        init: async () => undefined,
        detach: async () => undefined,
        dispatch: (a) => controller.dispatch(a),
        query: (q) => controller.query(q),
      };
    },
  };
  const app = new App(ui, {
    runner: spawnRunner(repo.env),
    gh: () => async () => ({ kind: "error", stderr: "no gh" }) as never,
    onModel: () => undefined,
  });
  const lines = (b: number) => rec.reviews.get(b)?.lines() ?? [];
  const settle = async () => {
    for (const r of app.reviews) await r.session.refresh();
  };
  return { repo, app, rec, lines, settle, config };
}
const three: CommitSpec[] = [
  { files: { "a.txt": "1\n" } },
  { msg: "c1: one", files: { "a.txt": "ONE\n" } },
  { msg: "c2: two", files: { "b.txt": "B\n" } },
];

describe("App", () => {
  it("a range review gets the old title and only its commits", async () => {
    const h = setup(three);
    const [b, t] = [h.repo.shas[0] ?? "", h.repo.shas[1] ?? ""];
    await h.app.command({ kind: "range", base: b, target: t });
    await h.settle();
    expect(h.rec.names.get(1)).toBe(
      `Glean:g1 ${basename(h.repo.root)} ${b.slice(0, 8)}..${t.slice(0, 8)}`,
    );
    expect(h.lines(1).join("\n")).toContain("ONE");
    expect(h.lines(1).join("\n")).not.toContain("b.txt");
    for (const r of h.app.reviews) r.session.stop();
  });

  it("reopening the same review reuses the buffer; another replaces it", async () => {
    const h = setup(three);
    const [b, t] = [h.repo.shas[0] ?? "", h.repo.shas[1] ?? ""];
    await h.app.command({ kind: "range", base: b, target: t });
    await h.app.command({ kind: "range", base: b, target: t });
    expect(h.app.reviews.map((r) => r.bufnr)).toEqual([1]);
    await h.app.command({
      kind: "range",
      base: b,
      target: h.repo.shas[2] ?? "",
    });
    expect(h.app.reviews).toHaveLength(1);
    expect(h.app.reviews[0]?.id).toBe("g2");
    expect(h.rec.valid.has(1)).toBe(false);
    expect(h.app.view(1)).toBeUndefined();
    h.app.reviews[0]?.session.stop();
  });

  it(":Glean log <CR> and visual <CR> open the selection, one review at a time", async () => {
    const h = setup(three);
    await h.app.command({ kind: "log" });
    const log = h.rec.lists.get(1);
    expect(log?.lines[1]).toContain("uncommitted changes");
    expect(log?.lines[2]).toContain("c2: two");
    await h.app.list({ kind: "open", buf: 1, srow: 3, erow: 3 });
    await h.settle();
    const body = h.lines(2).join("\n");
    expect(body).toContain("ONE");
    expect(body).not.toContain("b.txt");
    expect(h.rec.names.get(2)).toContain(`${h.repo.shas[1]?.slice(0, 8)} [`);
    await h.app.list({ kind: "open", buf: 1, srow: 2, erow: 3 });
    await h.settle();
    expect(h.app.reviews).toHaveLength(1);
    const both = h.lines(3).join("\n");
    expect(both).toContain("a.txt");
    expect(both).toContain("b.txt");
    h.app.reviews[0]?.session.stop();
  });

  it(":Glean log pages forward and stops at the end", async () => {
    const h = setup(
      [
        { files: { "a.txt": "0\n" } },
        ...[1, 2, 3, 4].map((i) => ({
          msg: `c${i}`,
          files: { "a.txt": `${i}\n` },
        })),
      ],
      { logPageSize: 2 },
    );
    const commits = () =>
      (h.rec.lists.get(1)?.lines ?? [])
        .filter((s) => /^[0-9a-f]{7,} /.test(s))
        .map((s) => s.split("  ")[1]);
    const footer = () => h.rec.lists.get(1)?.lines.at(-1) ?? "";
    await h.app.command({ kind: "log" });
    expect(commits()).toEqual(["c4", "c3"]);
    expect(footer()).toContain("]p to load more");
    await h.app.list({ kind: "page", buf: 1, delta: 1 });
    expect(commits()).toEqual(["c4", "c3", "c2", "c1"]);
    expect(footer()).toContain("]p to load more");
    await h.app.list({ kind: "page", buf: 1, delta: 1 });
    expect(commits()).toHaveLength(5);
    expect(footer()).not.toContain("]p to load more");
    await h.app.list({ kind: "page", buf: 1, delta: 1 });
    expect(commits()).toHaveLength(5);
  });

  it("a wiped log buffer is forgotten; the next :Glean log is fresh", async () => {
    const h = setup(
      [
        { files: { "a.txt": "0\n" } },
        ...[1, 2, 3].map((i) => ({
          msg: `c${i}`,
          files: { "a.txt": `${i}\n` },
        })),
      ],
      { logPageSize: 2 },
    );
    await h.app.command({ kind: "log" });
    await h.app.list({ kind: "page", buf: 1, delta: 1 });
    await h.app.command({ kind: "log" });
    expect(h.rec.shown).toEqual([1, 1]);
    h.rec.valid.delete(1);
    await h.app.list({ kind: "gone", buf: 1 });
    await h.app.command({ kind: "log" });
    const fresh = h.rec.lists.get(2)?.lines ?? [];
    expect(fresh.filter((s) => /^[0-9a-f]{7,} /.test(s))).toHaveLength(2);
  });

  it(":Glean jump with no review opens the default one; a file outside warns", async () => {
    const h = setup([
      { files: { "j.txt": "a\nb\n", "o.txt": "o\n" } },
      { msg: "c1", files: { "j.txt": "a\nB\n" } },
    ]);
    h.rec.file = { name: join(h.repo.root, "o.txt"), lnum: 1 };
    await h.app.command({ kind: "jump" });
    expect(h.app.reviews).toHaveLength(1);
    expect(h.rec.notes.at(-1)?.msg).toContain(
      "o.txt is not part of the review",
    );
    expect(h.rec.notes.at(-1)?.level).toBe("warn");
    await h.settle();
    expect(h.lines(1)).toContain("B");
    h.rec.file = { name: join(h.repo.root, "j.txt"), lnum: 2 };
    const before = h.rec.notes.length;
    await h.app.command({ kind: "jump" });
    expect(h.rec.notes).toHaveLength(before);
    expect(h.rec.reviews.get(1)?.cursor).toBeDefined();
    h.rec.file = { name: "/elsewhere/x.txt", lnum: 1 };
    await expect(h.app.command({ kind: "jump" })).rejects.toThrow(
      "not a file in the repo",
    );
    h.app.reviews[0]?.session.stop();
  });
});
