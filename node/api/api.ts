/**
 * The agent api: a flat, JSON-only surface over live reviews and the repo's
 * comment store, reached from Lua through one `gleanApi` rpcrequest.
 * rpcrequest blocks nvim until we reply, so every call answers from the
 * in-memory snapshot; a call with nothing to answer from yet, or whose work
 * outlives `API_TIMEOUT_MS`, replies `{ status: "pending" }` instead.
 */
import { readFile } from "node:fs/promises";
import { join, matchesGlob } from "node:path";
import { diffProjection, fileProjection, locate } from "../core/comments.ts";
import type { Hunk } from "../core/diff.ts";
import type { CommentOrigin, CommentRecord, Store } from "../core/state.ts";
import type { LineId, RepoPath, Sha } from "../core/types.ts";
import { WORKTREE } from "../core/types.ts";
import type { Git } from "../git/git.ts";
import { resolveFile, type Sticky } from "../render/actions.ts";
import type { Frame } from "../render/render.ts";
import { type Classifier, type OwnerFn, splitLines } from "../session/model.ts";
import type { Session } from "../session/session.ts";

export const API_TIMEOUT_MS = 2000;

export type LiveReview = {
  id: string;
  session: Session;
  base: string;
  target: string;
  title: string;
  scope: () => "combined" | "commits";
  frame: () => Frame | undefined;
};
export type RepoContext = { root: string; git: Git; store: Store };
export interface ApiHost {
  reviews(): readonly LiveReview[];
  /** The repo containing `path` (the nvim cwd when undefined), store loaded. */
  repoContext(path: string | undefined): Promise<RepoContext>;
}

export class ApiError extends Error {}
const fail = (msg: string): never => {
  throw new ApiError(`glean: ${msg}`);
};
export type Pending = { status: "pending" };
const PENDING: Pending = { status: "pending" };
class NotReady extends Error {}

type Side = "new" | "old";
type ApiComment = {
  id: number;
  path: RepoPath;
  lnum: number | undefined;
  side: Side;
  text: string;
  reply: string | undefined;
  content: string[];
  code: string;
  origin: CommentOrigin | undefined;
  state: "diff" | "file" | "outdated";
  outdated: boolean;
};
type HunkMode = "combined" | "commits";
type HunkEntry = {
  id: string;
  mode: HunkMode;
  sha: Sha | undefined;
  path: RepoPath;
  kind: string;
  hunk: Hunk;
  owner: OwnerFn;
};

/** A session slot: an id / buffer number, `{ repo }` / `{ session }`, or nothing. */
type Address =
  | { kind: "default" }
  | { kind: "session"; id: string | number }
  | { kind: "repo"; repo: string | undefined };
function parseAddress(v: unknown): Address {
  if (v === null || v === undefined) return { kind: "default" };
  if (typeof v === "string" || typeof v === "number")
    return { kind: "session", id: v };
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.session === "string" || typeof o.session === "number")
      return { kind: "session", id: o.session };
    return { kind: "repo", repo: str(o.repo) };
  }
  return fail(`bad session argument ${JSON.stringify(v)}`);
}
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

function recordSide(rec: CommentRecord): Side {
  if (rec.content.length === 0) return "new";
  return rec.content.every((e) => e.kind === "del") ? "old" : "new";
}
function apiComment(
  path: RepoPath,
  rec: CommentRecord,
  lnum: number | undefined,
  state: ApiComment["state"],
): ApiComment {
  const content = diffProjection(rec);
  return {
    id: rec.id,
    path,
    lnum,
    side: recordSide(rec),
    text: rec.text,
    reply: rec.reply,
    content,
    code: content.join("\n"),
    origin: rec.origin,
    state,
    outdated: state === "outdated",
  };
}

const pad = (n: number) => String(n).padStart(6, "0");
function allHunks(cls: Classifier, mode: HunkMode): HunkEntry[] {
  const out: HunkEntry[] = [];
  if (mode === "commits") {
    cls.model.commits.forEach((c, ci) => {
      const owner = cls.commitOwner(c);
      c.files.forEach((f, fi) => {
        f.hunks.forEach((hunk, hi) => {
          out.push({
            id: `c:${pad(ci + 1)}:${pad(fi + 1)}:${pad(hi + 1)}`,
            mode,
            sha: c.sha === WORKTREE ? undefined : c.sha,
            path: f.path,
            kind: f.kind,
            hunk,
            owner,
          });
        });
      });
    });
    return out;
  }
  cls.model.files.forEach((f, fi) => {
    const owner = cls.combinedOwner(f.path);
    f.hunks.forEach((hunk, hi) => {
      out.push({
        id: `b:${pad(fi + 1)}:${pad(hi + 1)}`,
        mode,
        sha: undefined,
        path: f.path,
        kind: f.kind,
        hunk,
        owner,
      });
    });
  });
  return out;
}
function apiHunk(cls: Classifier, e: HunkEntry) {
  let adds = 0;
  let dels = 0;
  let unseen = 0;
  const lines = e.hunk.lines.map((dl, i) => {
    const id = cls.lineIdentity(dl, e.path, e.owner);
    const seen = id !== undefined && cls.idSeen(id);
    if (dl.kind === "add") adds++;
    if (dl.kind === "del") dels++;
    if (dl.kind !== "context" && !seen) unseen++;
    return {
      i: i + 1,
      kind: dl.kind,
      lnum: dl.kind === "del" ? dl.oldLnum : dl.newLnum,
      side: dl.kind === "del" ? "old" : "new",
      text: dl.text,
      seen,
    };
  });
  const h = e.hunk;
  return {
    id: e.id,
    mode: e.mode,
    sha: e.sha,
    path: e.path,
    kind: e.kind,
    header: h.header,
    old_start: h.oldStart,
    old_count: h.oldCount,
    new_start: h.newStart,
    new_count: h.newCount,
    seen: cls.hunkSeen(h, e.path, e.owner),
    adds,
    dels,
    unseen_lines: unseen,
    lines,
  };
}

async function readLines(
  root: string,
  path: string,
): Promise<string[] | undefined> {
  return readFile(join(root, path), "utf8").then(splitLines, () => undefined);
}

export class Api {
  constructor(private readonly host: ApiHost) {}

  /** Dispatch one `gleanApi` request; unknown names are caller bugs. */
  async call(name: unknown, args: unknown): Promise<unknown> {
    const a = Array.isArray(args) ? args : [];
    const run = (): Promise<unknown> => {
      switch (name) {
        case "sessions":
          return Promise.resolve(this.sessions());
        case "comments":
          return this.comments(a[0], a[1]);
        case "hunks":
          return Promise.resolve(this.hunks(a[0], a[1]));
        case "mark":
          return this.mark(a[0], a[1], a[2]);
        case "excerpt":
          return Promise.resolve(this.excerpt(a[0], a[1], a[2]));
        case "add_comment":
          return this.addComment(a[0]);
        case "reply":
          return this.setReply(a[0], a[1], a[2], true);
        case "unreply":
          return this.setReply(a[0], a[1], undefined, false);
        default:
          return fail(`unknown api call ${JSON.stringify(name)}`);
      }
    };
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<Pending>((resolve) => {
      timer = setTimeout(() => resolve(PENDING), API_TIMEOUT_MS);
    });
    try {
      // A JSON round trip drops undefined fields, so Lua sees nil, not vim.NIL.
      const out = await Promise.race([run(), timeout]);
      return out === undefined ? null : JSON.parse(JSON.stringify(out));
    } catch (err) {
      if (err instanceof NotReady) return PENDING;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  sessions() {
    return this.host.reviews().map((r) => ({
      id: r.id,
      repo: r.session.repoRoot,
      base: r.base,
      target: r.target,
      scope: r.scope(),
      title: r.title,
    }));
  }

  private describe(): string {
    return this.host
      .reviews()
      .map((r) => `${r.id} (${r.session.repoRoot} ${r.base}..${r.target})`)
      .join(", ");
  }

  review(id: string | number | undefined): LiveReview {
    const live = this.host.reviews();
    if (live.length === 0)
      return fail(
        "no review is open; open one with :Glean before using glean.api",
      );
    if (id === undefined) {
      if (live.length === 1) return live[0]!;
      return fail(
        `${live.length} reviews are open; pass a session id — ${this.describe()}`,
      );
    }
    const hit = live.find((r) => r.id === id || r.id === `g${id}`);
    return (
      hit ??
      fail(
        `no review with session id "${id}"; open reviews: ${this.describe()}`,
      )
    );
  }

  private target(
    addr: Address,
  ):
    | { kind: "review"; r: LiveReview }
    | { kind: "repo"; repo: string | undefined } {
    if (addr.kind === "session")
      return { kind: "review", r: this.review(addr.id) };
    if (addr.kind === "repo") return { kind: "repo", repo: addr.repo };
    const live = this.host.reviews();
    if (live.length === 0) return { kind: "repo", repo: undefined };
    return { kind: "review", r: this.review(undefined) };
  }

  private static snapshot(r: LiveReview) {
    const snap = r.session.current;
    if (!snap) throw new NotReady();
    return snap;
  }

  async comments(sessionArg: unknown, optsArg: unknown): Promise<ApiComment[]> {
    const opts = obj(optsArg ?? sessionArg);
    const path = str(opts.path);
    const unanswered = opts.unanswered === true;
    const t = this.target(parseAddress(sessionArg));
    const keep = (c: ApiComment) =>
      (!path || c.path === path) && !(unanswered && c.reply !== undefined);
    if (t.kind === "repo") {
      const ctx = await this.host.repoContext(t.repo);
      const out: ApiComment[] = [];
      for (const p of ctx.store.commentPaths()) {
        if (path && p !== path) continue;
        const lines = await readLines(ctx.root, p);
        const rows = ctx.store.commentsFor(p).map((rec, order) => {
          let lnum = rec.lnum;
          let state: ApiComment["state"] = "outdated";
          if (lines && fileProjection(rec).length > 0) {
            const loc = locate(rec, lines, undefined, "file");
            if (loc.kind === "found") {
              lnum = loc.lnum;
              state = "file";
            }
          }
          return { order, lnum, c: apiComment(p, rec, lnum, state) };
        });
        rows.sort((a, b) => a.lnum - b.lnum || a.order - b.order);
        out.push(...rows.map((r) => r.c).filter(keep));
      }
      return out;
    }
    Api.snapshot(t.r);
    const groups = await t.r.session.commentSummary();
    return groups.flatMap((g) =>
      g.entries
        .map((e) =>
          apiComment(
            g.path,
            e.record,
            e.state === "diff"
              ? e.displayLnum
              : e.state === "file"
                ? e.fileLnum
                : e.record.lnum,
            e.state,
          ),
        )
        .filter(keep),
    );
  }

  hunks(sessionArg: unknown, optsArg: unknown) {
    const opts = obj(optsArg);
    const mode = opts.mode ?? "combined";
    if (mode !== "combined" && mode !== "commits")
      fail(
        `unknown hunk mode "${String(mode)}"; expected "combined" or "commits"`,
      );
    const r = this.reviewArg(sessionArg);
    const { cls } = Api.snapshot(r);
    const limit = num(opts.limit) ?? 20;
    const glob = str(opts.path);
    const cursor = str(opts.cursor);
    const seen = typeof opts.seen === "boolean" ? opts.seen : undefined;
    const out: ReturnType<typeof apiHunk>[] = [];
    let total = 0;
    for (const e of allHunks(cls, mode as HunkMode)) {
      if (glob && !matchesGlob(e.path, glob)) continue;
      if (cursor && e.id <= cursor) continue;
      const h = apiHunk(cls, e);
      if (seen !== undefined && h.seen !== seen) continue;
      total++;
      if (out.length < limit) out.push(h);
    }
    return {
      hunks: out,
      cursor: total > out.length ? out[out.length - 1]?.id : undefined,
      total,
    };
  }

  private reviewArg(sessionArg: unknown): LiveReview {
    const addr = parseAddress(sessionArg);
    if (addr.kind === "repo") return fail("this call needs an open review");
    return this.review(addr.kind === "session" ? addr.id : undefined);
  }

  async mark(sessionArg: unknown, selArg: unknown, seenArg: unknown) {
    const r = this.reviewArg(sessionArg);
    const { cls } = Api.snapshot(r);
    const single =
      typeof selArg === "string" ||
      (selArg !== null && typeof selArg === "object" && "id" in selArg);
    const sels: unknown[] = single
      ? [selArg]
      : Array.isArray(selArg)
        ? selArg
        : [];
    if (sels.length === 0) fail("mark requires a hunk id or a list of them");
    const idOf = (s: unknown) =>
      typeof s === "string" ? s : String(obj(s).id ?? "");
    const mode: HunkMode = idOf(sels[0]).startsWith("c")
      ? "commits"
      : "combined";
    const index = new Map(allHunks(cls, mode).map((e) => [e.id, e]));
    const op = seenArg === false ? "unmark" : "mark";
    const ids: LineId[] = [];
    const sticky: Sticky[] = [];
    for (const sel of sels) {
      const id = idOf(sel);
      const e =
        index.get(id) ??
        fail(`no hunk with id "${id}" in this review; re-list with hunks()`);
      const wanted = Array.isArray(obj(sel).lines)
        ? (obj(sel).lines as unknown[])
        : e.hunk.lines.map((_, i) => i + 1);
      for (const i of wanted) {
        const dl = typeof i === "number" ? e.hunk.lines[i - 1] : undefined;
        if (!dl)
          fail(
            `hunk ${id} has no line ${String(i)} (it has ${e.hunk.lines.length})`,
          );
        const lid = dl && cls.lineIdentity(dl, e.path, e.owner);
        if (!dl || !lid) continue;
        if ((op === "mark") !== cls.idSeen(lid)) ids.push(lid);
        if (mode === "combined") sticky.push({ path: e.path, text: dl.text });
      }
    }
    if (ids.length > 0 || sticky.length > 0)
      await r.session.perform({
        kind: "seen",
        plan: { op, ids, sticky, clear: [] },
      });
    return { hunks: sels.length, lines: ids.length };
  }

  /** The diff behind review-buffer rows `srow..erow` (1-based, inclusive). */
  excerpt(sessionArg: unknown, srowArg: unknown, erowArg: unknown): string {
    const r = this.reviewArg(sessionArg);
    const { cls } = Api.snapshot(r);
    const frame = r.frame() ?? fail("the review has not rendered yet");
    let lo = num(srowArg) ?? 1;
    let hi = num(erowArg) ?? lo;
    if (lo > hi) [lo, hi] = [hi, lo];
    const groups: { head: string; hunk: Hunk; lines: string[] }[] = [];
    const prefix = { add: "+", del: "-", context: " " } as const;
    for (let row = lo; row <= hi; row++) {
      const t = frame.rows[row - 1];
      if (t?.kind !== "line") continue;
      const res = resolveFile(cls, t.file);
      const hunk = res?.file.hunks[t.hunk];
      const dl = hunk?.lines[t.li];
      if (!res || !hunk || !dl) continue;
      let g = groups[groups.length - 1];
      if (g?.hunk !== hunk) {
        const sha = res.sha && res.sha !== WORKTREE ? res.sha : undefined;
        g = {
          head: sha ? `${res.file.path} (${sha.slice(0, 8)})` : res.file.path,
          hunk,
          lines: [],
        };
        groups.push(g);
      }
      g.lines.push(prefix[dl.kind] + dl.text);
    }
    return groups
      .map((g) => [g.head, g.hunk.header || "@@", ...g.lines].join("\n"))
      .join("\n\n");
  }

  async addComment(optsArg: unknown): Promise<number> {
    const o = obj(optsArg);
    const path = str(o.path);
    const text = str(o.text);
    if (!path) return fail("add_comment requires a repo-relative path");
    if (!text || !/\S/.test(text))
      return fail("add_comment requires a non-empty text");
    const ctx = await this.host.repoContext(str(o.repo));
    const lines =
      (await readLines(ctx.root, path)) ??
      fail(`${path} is not a readable file in ${ctx.root}`);
    let first = num(o.lnum) ?? 1;
    let last = num(o.end_lnum) ?? first;
    if (first > last) [first, last] = [last, first];
    if (first < 1 || last > lines.length)
      fail(
        `lines ${first}..${last} are outside ${path} (${lines.length} lines)`,
      );
    const [head, status] = await Promise.all([
      ctx.git.revParse("HEAD"),
      ctx.git.run(["status", "--porcelain", "--", path]),
    ]);
    const origin: CommentOrigin =
      head.kind === "ok"
        ? {
            sha: head.value,
            dirty: status.kind !== "ok" || /\S/.test(status.value),
          }
        : { sha: WORKTREE as Sha, dirty: true };
    const rec = ctx.store.addCommentRecord(path as RepoPath, {
      lnum: first,
      content: lines
        .slice(first - 1, last)
        .map((t) => ({ kind: "add" as const, text: t })),
      text,
      reply: undefined,
      origin,
    });
    await ctx.store.save(ctx.store.wtShard);
    await this.afterRepoWrite(ctx.root);
    return rec.id;
  }

  /** A live review over the same repo re-reads the store it shares with repo mode. */
  private async afterRepoWrite(root: string) {
    await Promise.all(
      this.host
        .reviews()
        .filter((r) => r.session.repoRoot === root)
        .map((r) => r.session.refresh()),
    );
  }

  async setReply(
    sessionArg: unknown,
    idArg: unknown,
    textArg: unknown,
    set: boolean,
  ): Promise<true> {
    const text = str(textArg);
    if (set && (!text || text === ""))
      fail("reply text must be a non-empty string");
    const reply = set ? text : undefined;
    const t = this.target(parseAddress(sessionArg));
    if (t.kind === "repo") {
      const ctx = await this.host.repoContext(t.repo);
      const path = ctx.store
        .commentPaths()
        .find((p) => ctx.store.commentsFor(p).some((c) => c.id === idArg));
      if (!path)
        return fail(`no comment with id ${String(idArg)} in ${ctx.root}`);
      ctx.store.setCommentReply(path, { id: idArg as number }, reply);
      await ctx.store.save(ctx.store.wtShard);
      await this.afterRepoWrite(ctx.root);
      return true;
    }
    const { store } = Api.snapshot(t.r);
    for (const path of store.commentPaths()) {
      const before = store.commentsFor(path).find((c) => c.id === idArg);
      if (!before) continue;
      await t.r.session.perform({
        kind: "comment",
        path,
        change: {
          op: "edit",
          before: { ...before },
          after: { ...before, reply },
        },
      });
      return true;
    }
    return fail(`no comment with id ${String(idArg)} in this review`);
  }
}
