/**
 * The nvim-free core of `:Glean`: the review registry (one review at a time),
 * `:Glean jump`, the log/PR list buffers and their paging/selection. `glean.ts`
 * implements `AppUi` and keeps the RPC wiring and backend lifecycle.
 */
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { LiveReview } from "./api/api.ts";
import { COMMENTS_ID } from "./core/state.ts";
import { type RepoPath, toRepoPath, type WorktreeLnum } from "./core/types.ts";
import {
  Git,
  type GitRunner,
  type LogCommit,
  type Outcome,
} from "./git/git.ts";
import { Session, type SessionOpts } from "./session/session.ts";
import {
  clampPage,
  type GhRunner,
  type ListFrame,
  logSelection,
  type OpenSpec,
  openBranchSpec,
  openDirtySpec,
  openPrSpec,
  PR_LIST_ARGS,
  PR_PAGE_SIZE,
  type PrListEntry,
  parsePrList,
  renderLog,
  renderPrs,
  revBase,
  reviewKey,
  reviewTitle,
  TargetError,
} from "./targets.ts";
import type {
  Action,
  NotifyLevel,
  Query,
  ReviewController,
  ViewOpts,
} from "./view/review.ts";

/** What the core needs from nvim to open a review; plain data. */
export type OpenConfig = {
  /** nvim's cwd. */
  cwd: string;
  /** The current buffer's name ("" for none). */
  bufName: string;
  dataDir: string;
  stateOverride: string | undefined;
  minSeenRun: number | undefined;
  ignoreWs: boolean;
  defaultBase: string;
  hunkIndent: number;
  hunkIndentDelayMs: number;
  pollMs: number;
  logPageSize: number;
};

/** A review display: the adapter-side view around a controller. */
export type ReviewHost = {
  readonly controller: ReviewController;
  readonly session: Session;
  init(): Promise<void>;
  detach(): Promise<void>;
  dispatch(a: Action): Promise<void>;
  query(q: Query): [number, number] | undefined;
};

export type AppUi = {
  config(): Promise<OpenConfig>;
  /** The current window's buffer name and 1-based cursor line. */
  cursorFile(): Promise<{ name: string; lnum: WorktreeLnum }>;
  bufValid(buf: number): Promise<boolean>;
  openReviewBuffer(title: string): Promise<number>;
  renameBuffer(buf: number, title: string): Promise<void>;
  showBuffer(buf: number): Promise<void>;
  wipeBuffer(buf: number): Promise<void>;
  /** Clear a review buffer's text and decorations (`:e`). */
  blankBuffer(buf: number): Promise<void>;
  setCursor(buf: number, row: number): Promise<void>;
  openListBuffer(kind: "log" | "prs", root: string): Promise<number>;
  paintList(buf: number, frame: ListFrame): Promise<void>;
  notify(msg: string, level: NotifyLevel): Promise<void>;
  review(buf: number, session: Session, opts: ViewOpts): ReviewHost;
};

export type AppDeps = {
  runner: GitRunner;
  gh: (root: string) => GhRunner;
  /** The live session or a review model changed: which followers repaint. */
  onModel(followers: { gutter: boolean; overlay: boolean }): void;
};

export type Command =
  | { kind: "dirty"; base: string | undefined }
  | { kind: "range"; base: string; target: string }
  | { kind: "pr"; pr: string | undefined }
  | { kind: "branch"; branch: string | undefined }
  | { kind: "log" }
  | { kind: "prs" }
  | { kind: "jump" };

export type ListEvent =
  | { kind: "open"; buf: number; srow: number; erow: number }
  | { kind: "page"; buf: number; delta: number }
  | { kind: "reload"; buf: number }
  | { kind: "gone"; buf: number };
export function parseListEvent(v: unknown): ListEvent | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const e = v as Record<string, unknown>;
  if (typeof e.buf !== "number") return undefined;
  const buf = e.buf;
  switch (e.kind) {
    case "open":
      return typeof e.srow === "number" && typeof e.erow === "number"
        ? { kind: "open", buf, srow: e.srow, erow: e.erow }
        : undefined;
    case "page":
      return typeof e.delta === "number"
        ? { kind: "page", buf, delta: e.delta }
        : undefined;
    case "reload":
    case "gone":
      return { kind: e.kind, buf };
  }
  return undefined;
}

export type StoreLocation = { stateDir: string; wtShard: string };
/** Same location the Lua implementation used, so existing stores keep loading:
 * `<data>/glean/<sha256(git common dir)[:16]>`, worktree shard `WORKTREE/<branch>`. */
export async function storeLocation(
  git: Git,
  dataDir: string,
  override: string | undefined,
): Promise<StoreLocation> {
  const [common, branch] = await Promise.all([
    git.commonDir(),
    git.currentBranch(),
  ]);
  return storePaths(dataDir, override, common, branch);
}
/** Pure half of `storeLocation`. A failed common-dir lookup falls back to
 * `<data>/glean`; a failed or empty branch lookup to shard `WORKTREE/HEAD`
 * (a detached HEAD already reports the literal "HEAD"). */
export function storePaths(
  dataDir: string,
  override: string | undefined,
  common: Outcome<string>,
  branch: Outcome<string | undefined>,
): StoreLocation {
  const base = join(dataDir, "glean");
  const stateDir =
    override ??
    (common.kind === "ok"
      ? join(
          base,
          createHash("sha256").update(common.value).digest("hex").slice(0, 16),
        )
      : base);
  const name = branch.kind === "ok" && branch.value ? branch.value : "HEAD";
  return { stateDir, wtShard: `${COMMENTS_ID}/${name}` };
}

/** `name` relative to `root` (symlinks resolved), undefined outside it. */
export async function repoRelative(
  root: string,
  name: string,
): Promise<RepoPath | undefined> {
  if (name === "" || /^\w+:\/\//.test(name)) return undefined;
  const real = async (p: string) => {
    try {
      return await realpath(p);
    } catch {
      return p;
    }
  };
  const rel = relative(await real(root), await real(name));
  return isAbsolute(rel) ? undefined : toRepoPath(rel);
}

type OpenContext = OpenConfig & { root: string; git: Git };
type Current = {
  key: string;
  bufnr: number;
  view: ReviewHost;
  review: LiveReview;
  sessionOpts: SessionOpts;
  viewOpts: ViewOpts;
  pollMs: number;
};
type LogState = {
  kind: "log";
  root: string;
  commits: LogCommit[];
  hasMore: boolean;
  frame: ListFrame;
};
type PrsState = {
  kind: "prs";
  root: string;
  prs: PrListEntry[];
  page: number;
  frame: ListFrame;
};

export class App {
  /** There is one review at a time (as in the Lua version): opening another
   * range discards it; reopening the same `reviewKey` reuses buffer and id. */
  private current: Current | undefined;
  readonly reviews: LiveReview[] = [];
  private nextReviewId = 1;
  /** The live review the file-buffer gutter follows. */
  liveSession: Session | undefined;
  private readonly lists = new Map<number, LogState | PrsState>();
  /** The list buffer per (kind, repo root): reopening reuses it. */
  private readonly listBuffers = new Map<string, number>();

  constructor(
    private readonly ui: AppUi,
    private readonly deps: AppDeps,
  ) {}

  view(buf: number): ReviewHost | undefined {
    return this.current?.bufnr === buf ? this.current.view : undefined;
  }
  private git(root: string) {
    return new Git({ repoRoot: root, runner: this.deps.runner });
  }

  async command(command: Command): Promise<void> {
    switch (command.kind) {
      case "dirty": {
        const ctx = await this.openContext();
        await this.openReview(
          ctx,
          await openDirtySpec(ctx.git, ctx.defaultBase, command.base),
        );
        return;
      }
      case "range":
        await this.openReview(await this.openContext(), {
          base: revBase(command.base),
          target: { kind: "ref", ref: command.target },
        });
        return;
      case "pr": {
        const ctx = await this.openContext();
        await this.openReview(
          ctx,
          await openPrSpec(ctx.git, command.pr, this.deps.gh(ctx.root)),
        );
        return;
      }
      case "branch": {
        if (!command.branch)
          throw new TargetError("glean: branch requires a name");
        const ctx = await this.openContext();
        await this.openReview(
          ctx,
          await openBranchSpec(ctx.git, command.branch, ctx.defaultBase),
        );
        return;
      }
      case "log": {
        const ctx = await this.openContext();
        await this.openLog(ctx.root, ctx.logPageSize);
        return;
      }
      case "prs":
        await this.openPrs((await this.openContext()).root);
        return;
      case "jump":
        await this.jump();
        return;
    }
  }

  /** Review-buffer lifecycle actions; the rest go to the view. */
  async action(buf: number, a: Action): Promise<void> {
    if (a.kind === "reset") return this.reset(buf, a.row);
    if (a.kind === "gone") {
      if (this.current?.bufnr === buf) await this.close({ keepBuf: true });
      return;
    }
    await this.view(buf)?.dispatch(a);
  }

  /** Like the Lua `resolve_repo_root`: the repo of cwd when the current buffer
   * lives under it (or is not a file), else the repo of the buffer's dir. */
  private async openContext(): Promise<OpenContext> {
    const cfg = await this.ui.config();
    const { cwd, bufName } = cfg;
    const bufDir =
      bufName === "" || /^\w+:\/\//.test(bufName) ? cwd : dirname(bufName);
    const discover = async (dir: string) => {
      const r = await this.git(dir).run(["rev-parse", "--show-toplevel"]);
      return r.kind === "ok" ? r.value.trim() : undefined;
    };
    const underCwd = bufDir === cwd || bufDir.startsWith(`${cwd}/`);
    const root =
      (underCwd ? await discover(cwd) : undefined) ??
      (await discover(bufDir)) ??
      cwd;
    return { ...cfg, root, git: this.git(root) };
  }

  /** Tear down the one review: stop its background work and wipe its buffer. */
  async close(opts: { keepBuf: boolean }) {
    const slot = this.current;
    if (!slot) return;
    this.current = undefined;
    this.reviews.length = 0;
    slot.view.session.stop();
    await slot.view.detach();
    if (this.liveSession === slot.view.session) this.liveSession = undefined;
    this.deps.onModel({ gutter: true, overlay: false });
    if (!opts.keepBuf) await this.ui.wipeBuffer(slot.bufnr);
  }

  private async openReview(ctx: OpenContext, spec: OpenSpec): Promise<void> {
    const { root, git } = ctx;
    const key = reviewKey(root, spec);
    const cur = this.current;
    if (cur?.key === key && (await this.ui.bufValid(cur.bufnr))) {
      const title = reviewTitle(root, cur.review.id, spec, cur.review.base);
      cur.review.title = title;
      await this.ui.renameBuffer(cur.bufnr, title);
      await this.ui.showBuffer(cur.bufnr);
      return;
    }
    await this.close({ keepBuf: false });
    const loc = await storeLocation(git, ctx.dataDir, ctx.stateOverride);
    const wtShard =
      spec.storageBranch !== undefined
        ? `${COMMENTS_ID}/${spec.storageBranch}`
        : loc.wtShard;
    let base: string;
    if (spec.base.kind === "rev") base = spec.base.rev;
    else {
      const empty = await git.emptyTree();
      if (empty.kind !== "ok")
        throw new TargetError(
          `glean: resolving the empty tree failed: ${empty.message}`,
        );
      base = empty.value;
    }
    const sessionOpts: SessionOpts = {
      git,
      base,
      target: spec.target,
      stateDir: loc.stateDir,
      wtShard,
      build: {
        ignoreWhitespace: ctx.ignoreWs,
        fromRoot: spec.base.kind === "root",
      },
    };
    const id = `g${this.nextReviewId++}`;
    const title = reviewTitle(root, id, spec, base);
    const bufnr = await this.ui.openReviewBuffer(title);
    const viewOpts: ViewOpts = {
      minSeenRun: ctx.minSeenRun ?? 5,
      hunkIndent: ctx.hunkIndent,
      hunkIndentDelayMs: ctx.hunkIndentDelayMs,
    };
    const session = new Session(sessionOpts);
    const view = this.ui.review(bufnr, session, viewOpts);
    const review: LiveReview = {
      id,
      bufnr,
      session,
      base,
      target: spec.target,
      title,
      scope: () => this.current?.view.controller.scope ?? "combined",
      frame: () => this.current?.view.controller.frame,
    };
    this.reviews.push(review);
    this.current = {
      key,
      bufnr,
      view,
      review,
      sessionOpts,
      viewOpts,
      pollMs: ctx.pollMs,
    };
    await this.startView(this.current);
  }

  /** Wire a slot's session and view up and paint the first model. */
  private async startView(slot: Current) {
    const { view, review } = slot;
    const session = view.session;
    await view.init();
    review.session = session;
    this.liveSession = session;
    session.subscribe(() =>
      this.deps.onModel({
        gutter: this.liveSession === session,
        overlay: true,
      }),
    );
    await session.refresh();
    session.startLive(slot.pollMs);
  }

  /**
   * `:e` in the review: a hard reset. Tear the session down and rebuild it from
   * the options it was opened with in the same (blanked) buffer, keeping its id
   * and cursor row, so a wedged render or stale extmarks recover in place.
   */
  private async reset(bufnr: number, row: number | undefined) {
    const slot = this.current;
    if (!slot || slot.bufnr !== bufnr) return;
    slot.view.session.stop();
    await slot.view.detach();
    await this.ui.blankBuffer(bufnr);
    const view = this.ui.review(
      bufnr,
      new Session(slot.sessionOpts),
      slot.viewOpts,
    );
    slot.view = view;
    await this.startView(slot);
    await view.controller.redraw();
    if (row !== undefined) await this.ui.setCursor(bufnr, row);
  }

  /**
   * `:Glean jump`: show the review at the current file buffer's line, opening
   * the default (dirty) review when there is none.
   */
  private async jump() {
    const { name, lnum } = await this.ui.cursorFile();
    const current = this.current;
    const src = current
      ? { kind: "current" as const, root: current.review.session.repoRoot }
      : { kind: "open" as const, ctx: await this.openContext() };
    const root = src.kind === "current" ? src.root : src.ctx.root;
    const path = await repoRelative(root, name);
    if (path === undefined)
      throw new TargetError("glean: not a file in the repo");
    if (current) await this.ui.showBuffer(current.bufnr);
    else if (src.kind === "open") {
      const ctx = src.ctx;
      await this.openReview(
        ctx,
        await openDirtySpec(ctx.git, ctx.defaultBase, undefined),
      );
    }
    const row = await this.current?.view.controller.gotoSource(path, lnum);
    if (row === undefined)
      await this.ui.notify(`glean: ${path} is not part of the review`, "warn");
  }

  // ---- log and PR list buffers ----

  /** The list buffer for (kind, root), created and shown when missing. */
  private async listBuffer(kind: "log" | "prs", root: string) {
    const k = `${kind}\0${root}`;
    const existing = this.listBuffers.get(k);
    if (existing !== undefined && (await this.ui.bufValid(existing))) {
      await this.ui.showBuffer(existing);
      return existing;
    }
    const buf = await this.ui.openListBuffer(kind, root);
    this.listBuffers.set(k, buf);
    return buf;
  }

  private async fetchLog(root: string, skip: number, want: number) {
    // One extra commit tells whether older history remains.
    const r = await this.git(root).logCommits({ skip, limit: want + 1 });
    if (r.kind !== "ok")
      throw new TargetError(`glean: git log failed: ${r.message}`);
    const hasMore = r.value.length > want;
    return { commits: hasMore ? r.value.slice(0, want) : r.value, hasMore };
  }

  private async openLog(root: string, pageSize: number, show = true) {
    const prevBuf = this.listBuffers.get(`log\0${root}`);
    const prev = prevBuf !== undefined ? this.lists.get(prevBuf) : undefined;
    // A reopen restores however much history was loaded before.
    const want = Math.max(
      pageSize,
      prev?.kind === "log" ? prev.commits.length : 0,
    );
    const { commits, hasMore } = await this.fetchLog(root, 0, want);
    const buf =
      show || prevBuf === undefined
        ? await this.listBuffer("log", root)
        : prevBuf;
    const frame = renderLog(root, commits, hasMore);
    this.lists.set(buf, { kind: "log", root, commits, hasMore, frame });
    await this.ui.paintList(buf, frame);
  }

  private async openPrs(root: string, show = true) {
    const res = await this.deps.gh(root)(PR_LIST_ARGS);
    if (res.kind !== "ok")
      throw new TargetError(`glean: \`gh pr list\` failed: ${res.stderr}`);
    const prs = parsePrList(res.stdout);
    const prevBuf = this.listBuffers.get(`prs\0${root}`);
    const prev = prevBuf !== undefined ? this.lists.get(prevBuf) : undefined;
    const buf =
      show || prevBuf === undefined
        ? await this.listBuffer("prs", root)
        : prevBuf;
    const page = clampPage(
      prev?.kind === "prs" ? prev.page : 1,
      prs.length,
      PR_PAGE_SIZE,
    );
    const frame = renderPrs(root, prs, page, PR_PAGE_SIZE);
    this.lists.set(buf, { kind: "prs", root, prs, page, frame });
    await this.ui.paintList(buf, frame);
  }

  async list(ev: ListEvent): Promise<void> {
    const st = this.lists.get(ev.buf);
    if (!st) return;
    if (ev.kind === "gone") {
      this.lists.delete(ev.buf);
      this.listBuffers.delete(`${st.kind}\0${st.root}`);
      return;
    }
    if (ev.kind === "reload") {
      if (st.kind === "log")
        await this.openLog(
          st.root,
          (await this.ui.config()).logPageSize,
          false,
        );
      else await this.openPrs(st.root, false);
      return;
    }
    if (st.kind === "log") {
      if (ev.kind === "page") {
        if (!st.hasMore || ev.delta <= 0) return;
        const pageSize = (await this.ui.config()).logPageSize;
        const more = await this.fetchLog(st.root, st.commits.length, pageSize);
        st.hasMore = more.hasMore;
        st.commits.push(...more.commits);
        st.frame = renderLog(st.root, st.commits, st.hasMore);
        await this.ui.paintList(ev.buf, st.frame);
        return;
      }
      const sel = logSelection(st.commits, st.frame.rowMap, ev.srow, ev.erow);
      if (sel.kind === "none") return;
      await this.openReview(await this.listContext(st.root), sel.spec);
      return;
    }
    if (ev.kind === "page") {
      const page = clampPage(st.page + ev.delta, st.prs.length, PR_PAGE_SIZE);
      if (page === st.page) return;
      st.page = page;
      st.frame = renderPrs(st.root, st.prs, page, PR_PAGE_SIZE);
      await this.ui.paintList(ev.buf, st.frame);
      await this.ui.setCursor(ev.buf, 1);
      return;
    }
    const idx = st.frame.rowMap.get(ev.srow);
    const pr = idx !== undefined ? st.prs[idx] : undefined;
    if (!pr) return;
    const ctx = await this.listContext(st.root);
    await this.openReview(
      ctx,
      await openPrSpec(ctx.git, String(pr.number), this.deps.gh(st.root)),
    );
  }
  private async listContext(root: string): Promise<OpenContext> {
    return { ...(await this.openContext()), root, git: this.git(root) };
  }
}
