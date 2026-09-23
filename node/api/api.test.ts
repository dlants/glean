/** Port of api_test: the agent api over live sessions and the repo store. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../core/state.ts";
import type { RepoPath } from "../core/types.ts";
import { Git, spawnRunner } from "../git/git.ts";
import type { Target } from "../session/model.ts";
import { Session } from "../session/session.ts";
import { makeRepo, type TestRepo } from "../test/repo.ts";
import { Api, type LiveReview } from "./api.ts";

type Comment = {
  id: number;
  path: string;
  lnum: number;
  text: string;
  reply?: string;
  code: string;
  side: string;
  state: string;
  outdated: boolean;
  content: string[];
  origin?: { sha: string; dirty: boolean };
};
type ApiHunk = {
  id: string;
  mode: string;
  sha?: string;
  path: string;
  header: string;
  new_start: number;
  adds: number;
  dels: number;
  unseen_lines: number;
  seen: boolean;
  lines: {
    i: number;
    kind: string;
    lnum: number;
    side: string;
    text: string;
    seen: boolean;
  }[];
};
type Page = { hunks: ApiHunk[]; cursor?: string; total: number };

function harness() {
  const reviews: LiveReview[] = [];
  const stateDirs = new Map<string, string>();
  const stateDir = (root: string) => {
    const d = stateDirs.get(root) ?? mkdtempSync(join(tmpdir(), "glean-api-"));
    stateDirs.set(root, d);
    return d;
  };
  let cwd = "/";
  const api = new Api({
    reviews: () => reviews,
    repoContext: async (path) => {
      const root = path ?? cwd;
      if (!stateDirs.has(root))
        throw new Error(`glean: ${root} is not inside a git repository`);
      const store = new Store(stateDir(root));
      await store.load([]);
      return {
        root,
        git: new Git({ repoRoot: root, runner: spawnRunner() }),
        store,
      };
    },
  });
  let n = 0;
  const open = async (repo: TestRepo, base: string, target: Target) => {
    const session = new Session({
      git: new Git({ repoRoot: repo.root, runner: spawnRunner(repo.env) }),
      base,
      target,
      stateDir: stateDir(repo.root),
    });
    await session.refresh();
    const r: LiveReview = {
      id: `g${++n}`,
      session,
      base,
      target: target.kind === "ref" ? target.ref : "worktree",
      title: `Glean:g${n}`,
      scope: () => "combined",
      frame: () => undefined,
    };
    reviews.push(r);
    return r;
  };
  const close = (r: LiveReview) => reviews.splice(reviews.indexOf(r), 1);
  const call = <T>(name: string, ...args: unknown[]) =>
    api.call(name, args) as Promise<T>;
  return {
    open,
    close,
    call,
    stateDir,
    setCwd: (c: string) => {
      cwd = c;
    },
  };
}

describe("agent api: comments", () => {
  it("lists, replies, filters and agrees with repo mode", async () => {
    const repo = makeRepo([
      { files: { "f.txt": "one\ntwo\nthree\n" } },
      { files: { "f.txt": "one\nTWO\nthree\n", "g.txt": "gee\n" } },
    ]);
    const h = harness();
    h.stateDir(repo.root);
    h.setCwd(repo.root);
    expect(await h.call("sessions")).toEqual([]);
    expect(await h.call("comments", { repo: repo.root })).toEqual([]);
    await expect(h.call("comments", { repo: "/nope" })).rejects.toThrow(
      "git repository",
    );

    const r = await h.open(repo, repo.shas[0]!, {
      kind: "ref",
      ref: repo.shas[1]!,
    });
    const store = r.session.current!.store;
    const add = (path: string, text: string, content: string) =>
      store.addCommentRecord(path as RepoPath, {
        lnum: 1,
        content: [{ kind: "add", text: content }],
        text,
        reply: undefined,
        origin: undefined,
      });
    add("f.txt", "on two", "TWO");
    add("g.txt", "on gee", "gee");
    add("f.txt", "stale", "NOT IN THE DIFF");
    await store.save(store.wtShard);

    const list = await h.call<Comment[]>("comments");
    expect(list.map((c) => c.path)).toEqual(["f.txt", "f.txt", "g.txt"]);
    const two = list.find((c) => c.text === "on two")!;
    expect(two).toMatchObject({
      code: "TWO",
      side: "new",
      lnum: 2,
      outdated: false,
    });
    expect(two.reply).toBeUndefined();
    expect(list.find((c) => c.text === "stale")?.outdated).toBe(true);
    expect(
      await h.call<Comment[]>("comments", null, { path: "g.txt" }),
    ).toHaveLength(1);

    const gee = list.find((c) => c.path === "g.txt")!;
    await h.call("reply", null, gee.id, "agent says hi");
    await h.call("reply", null, gee.id, "second answer");
    const again = await h.call<Comment[]>("comments", null, { path: "g.txt" });
    expect(again[0]).toMatchObject({
      id: gee.id,
      text: "on gee",
      reply: "second answer",
    });
    await r.session.undo();
    expect(
      (await h.call<Comment[]>("comments", null, { path: "g.txt" }))[0]?.reply,
    ).toBe("agent says hi");
    const unanswered = await h.call<Comment[]>("comments", null, {
      unanswered: true,
    });
    expect(unanswered.map((c) => c.text).sort()).toEqual(["on two", "stale"]);
    await h.call("unreply", null, gee.id);
    expect(
      (await h.call<Comment[]>("comments", null, { path: "g.txt" }))[0]?.reply,
    ).toBeUndefined();
    await h.call("reply", null, gee.id, "final answer");
    await expect(h.call("reply", null, 99999, "nope")).rejects.toThrow("99999");
    await expect(h.call("reply", null, gee.id, "")).rejects.toThrow(
      "non-empty",
    );

    // Repo mode reads the same store.
    h.close(r);
    const repoList = await h.call<Comment[]>("comments", { repo: repo.root });
    const byText = new Map(repoList.map((c) => [c.text, c]));
    expect(byText.get("on two")).toMatchObject({ state: "file", lnum: 2 });
    expect(byText.get("stale")).toMatchObject({
      state: "outdated",
      outdated: true,
    });
    expect(byText.get("on gee")?.reply).toBe("final answer");

    const newId = await h.call<number>("add_comment", {
      repo: repo.root,
      path: "f.txt",
      lnum: 3,
      text: "from an agent",
    });
    const authored = (
      await h.call<Comment[]>("comments", { repo: repo.root })
    ).find((c) => c.id === newId);
    expect(authored).toMatchObject({ code: "three", state: "file", lnum: 3 });
    expect(authored?.origin).toEqual({ sha: repo.shas[1], dirty: false });
    await expect(
      h.call("add_comment", { repo: repo.root, path: "nope.txt", text: "x" }),
    ).rejects.toThrow();
    await expect(
      h.call("add_comment", {
        repo: repo.root,
        path: "f.txt",
        lnum: 99,
        text: "x",
      }),
    ).rejects.toThrow();
    await expect(
      h.call("add_comment", { repo: repo.root, path: "f.txt", text: "  " }),
    ).rejects.toThrow();
    await h.call("reply", { repo: repo.root }, newId, "self");
    expect(
      (await h.call<Comment[]>("comments", { repo: repo.root })).find(
        (c) => c.id === newId,
      )?.reply,
    ).toBe("self");
    await expect(
      h.call("reply", { repo: repo.root }, 99999, "x"),
    ).rejects.toThrow();

    // Session and repo mode agree on the records.
    const r2 = await h.open(repo, repo.shas[0]!, {
      kind: "ref",
      ref: repo.shas[1]!,
    });
    const sess = await h.call<Comment[]>("comments", r2.id);
    const repoAll = await h.call<Comment[]>("comments", { repo: repo.root });
    expect(sess.map((c) => c.id).sort()).toEqual(
      repoAll.map((c) => c.id).sort(),
    );
  });

  it("resolves sessions and names the fix in errors", async () => {
    const repo = makeRepo([
      { files: { "z.txt": "z\n" } },
      { files: { "z.txt": "Z\n" } },
    ]);
    const h = harness();
    await expect(h.call("hunks")).rejects.toThrow("no review is open");
    const a = await h.open(repo, repo.shas[0]!, {
      kind: "ref",
      ref: repo.shas[1]!,
    });
    const b = await h.open(repo, repo.shas[0]!, {
      kind: "ref",
      ref: repo.shas[1]!,
    });
    await expect(h.call("hunks")).rejects.toThrow(a.id);
    await expect(h.call("hunks", "g999")).rejects.toThrow("g999");
    expect((await h.call<Page>("hunks", b.id)).total).toBe(1);
    expect(await h.call<{ id: string }[]>("sessions")).toHaveLength(2);
    await expect(h.call("nope")).rejects.toThrow("unknown api call");
  });
});

describe("agent api: hunks", () => {
  it("enumerates both modes, filters, pages and marks", async () => {
    const repo = makeRepo([
      {
        files: {
          "lua/a.lua": "a1\na2\na3\na4\na5\na6\na7\na8\na9\na10\n",
          "b.txt": "b1\n",
        },
      },
      { files: { "lua/a.lua": "A1\na2\na3\na4\na5\na6\na7\na8\na9\nA10\n" } },
      { files: { "b.txt": "B1\n" } },
    ]);
    const h = harness();
    const r = await h.open(repo, repo.shas[0]!, {
      kind: "ref",
      ref: repo.shas[2]!,
    });
    const all = await h.call<Page>("hunks", r.id, { limit: 100 });
    expect(all.cursor).toBeUndefined();
    expect(all.hunks.map((x) => x.path)).toEqual([
      "b.txt",
      "lua/a.lua",
      "lua/a.lua",
    ]);
    const first = all.hunks[0]!;
    expect(first).toMatchObject({
      mode: "combined",
      new_start: 1,
      adds: 1,
      dels: 1,
      unseen_lines: 2,
      seen: false,
    });
    expect(first.header.slice(0, 2)).toBe("@@");
    expect(first.lines.find((l) => l.kind === "del")).toMatchObject({
      text: "b1",
      side: "old",
    });
    expect(first.lines.find((l) => l.kind === "add")).toMatchObject({
      text: "B1",
      side: "new",
      lnum: 1,
      seen: false,
    });

    const byc = await h.call<Page>("hunks", r.id, {
      mode: "commits",
      limit: 100,
    });
    expect(byc.hunks[0]).toMatchObject({
      mode: "commits",
      sha: repo.shas[1],
      path: "lua/a.lua",
    });
    expect(byc.hunks.at(-1)).toMatchObject({
      sha: repo.shas[2],
      path: "b.txt",
    });

    expect(
      (await h.call<Page>("hunks", r.id, { path: "lua/**/*.lua" })).total,
    ).toBe(2);
    expect((await h.call<Page>("hunks", r.id, { path: "*.txt" })).total).toBe(
      1,
    );
    expect((await h.call<Page>("hunks", r.id, { path: "*.rs" })).total).toBe(0);

    const walked: string[] = [];
    let cursor: string | undefined;
    do {
      const page: Page = await h.call<Page>("hunks", r.id, {
        limit: 1,
        cursor,
      });
      walked.push(...page.hunks.map((x) => x.id));
      cursor = page.cursor;
    } while (cursor && walked.length < 20);
    expect(walked).toEqual(all.hunks.map((x) => x.id));

    const lua = { path: "lua/**/*.lua", limit: 100 };
    const target = (await h.call<Page>("hunks", r.id, lua)).hunks[0]!;
    const addI = target.lines.find((l) => l.kind === "add")!.i;
    expect(
      await h.call("mark", r.id, { id: target.id, lines: [addI] }),
    ).toEqual({ hunks: 1, lines: 1 });
    const after = (await h.call<Page>("hunks", r.id, lua)).hunks[0]!;
    expect(after.seen).toBe(false);
    expect(after.unseen_lines).toBe(target.unseen_lines - 1);
    expect(after.lines.find((l) => l.i === addI)?.seen).toBe(true);
    await r.session.undo();
    expect(
      (await h.call<Page>("hunks", r.id, lua)).hunks[0]?.unseen_lines,
    ).toBe(target.unseen_lines);

    const both = (await h.call<Page>("hunks", r.id, lua)).hunks;
    expect(
      await h.call(
        "mark",
        r.id,
        both.map((x) => x.id),
      ),
    ).toMatchObject({ hunks: 2 });
    expect(
      (await h.call<Page>("hunks", r.id, { ...lua, seen: false })).total,
    ).toBe(0);
    await r.session.undo();
    expect(
      (await h.call<Page>("hunks", r.id, { ...lua, seen: true })).total,
    ).toBe(0);
    await h.call("mark", r.id, both[0]!.id);
    expect(await h.call("mark", r.id, both[0]!.id)).toMatchObject({ lines: 0 });
    await h.call("mark", r.id, both[0]!.id, false);
    expect(
      (await h.call<Page>("hunks", r.id, { ...lua, seen: true })).total,
    ).toBe(0);

    await expect(h.call("mark", r.id, "b:000099:000001")).rejects.toThrow(
      "b:000099:000001",
    );
    await expect(
      h.call("mark", r.id, { id: both[0]!.id, lines: [999] }),
    ).rejects.toThrow("999");
    await expect(h.call("hunks", r.id, { mode: "nope" })).rejects.toThrow(
      "nope",
    );
  });

  it("marks uncommitted deletions of repeated lines", async () => {
    const repo = makeRepo([
      { files: { "d.txt": "--\nkeep\n--\ndrop one\n--\ndrop two\n" } },
    ]);
    writeFileSync(join(repo.root, "d.txt"), "--\nkeep\n");
    const h = harness();
    const r = await h.open(repo, repo.shas[0]!, { kind: "worktree" });
    const hk = (await h.call<Page>("hunks", r.id)).hunks[0]!;
    expect(hk).toMatchObject({ dels: 4, unseen_lines: 4 });
    expect(await h.call("mark", r.id, hk.id)).toMatchObject({ lines: 4 });
    const after = (await h.call<Page>("hunks", r.id)).hunks[0]!;
    expect(after).toMatchObject({ seen: true, unseen_lines: 0 });
    await h.call("mark", r.id, hk.id, false);
    expect((await h.call<Page>("hunks", r.id)).hunks[0]?.unseen_lines).toBe(4);
  });

  it("answers pending while a session has no snapshot yet", async () => {
    const repo = makeRepo([{ files: { "z.txt": "z\n" } }]);
    const h = harness();
    const r = await h.open(repo, repo.shas[0]!, { kind: "worktree" });
    r.session.current = undefined;
    expect(await h.call("hunks", r.id)).toEqual({ status: "pending" });
  });
});
