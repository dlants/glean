import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { Api, ApiError, type LiveReview } from "./api/api.ts";
import { COMMENTS_ID, Store } from "./core/state.ts";
import { type PostLnum, type RepoPath, toRepoPath } from "./core/types.ts";
import { Git, type LogCommit, type Outcome, spawnRunner } from "./git/git.ts";
import { FileGutter, parseGutterEvent } from "./gutter/fileGutter.ts";
import { NvimGutterUi } from "./gutter/nvimGutterUi.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import { NvimOverlayUi } from "./overlay/nvimOverlayUi.ts";
import { Overlay, parseOverlayEvent } from "./overlay/overlay.ts";
import { Session, type SessionOpts } from "./session/session.ts";
import {
  clampPage,
  isPrArg,
  type ListFrame,
  LOG_PAGE_SIZE,
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
  spawnGhRunner,
  TargetError,
} from "./targets.ts";
import {
  parseAction,
  parseQuery,
  ReviewView,
  type ViewOpts,
} from "./view/view.ts";

export const GLEAN_COMMAND = "gleanCommand";
export const GLEAN_ACTION = "gleanAction";
export const GLEAN_GUTTER = "gleanGutter";
export const GLEAN_API = "gleanApi";
export const GLEAN_LIST = "gleanList";
export const GLEAN_QUERY = "gleanQuery";
export const GLEAN_OVERLAY = "gleanOverlay";
const views = new Map<number, ReviewView>();
/** There is one review at a time (as in the Lua version): opening another
 * range discards it; reopening the same `reviewKey` reuses buffer and id. */
type Current = {
  key: string;
  bufnr: number;
  view: ReviewView;
  review: LiveReview;
  sessionOpts: SessionOpts;
  viewOpts: ViewOpts;
};
let current: Current | undefined;
const reviews: LiveReview[] = [];
let nextReviewId = 1;
/** The live review the file-buffer gutter follows. */
let liveSession: Session | undefined;
let gutter: FileGutter | undefined;
let overlay: Overlay | undefined;
/** A store write from repo mode (api, overlay): live reviews of the repo
 * re-read it, and file buffers re-stamp their comments. */
function afterRepoWrite(root: string) {
  void Promise.all(
    reviews
      .filter((r) => r.session.repoRoot === root)
      .map((r) => r.session.refresh()),
  ).catch(() => undefined);
}

type Command =
  | { kind: "ping" }
  | { kind: "dirty"; base: string | undefined }
  | { kind: "range"; base: string; target: string }
  | { kind: "pr"; pr: string | undefined }
  | { kind: "branch"; branch: string | undefined }
  | { kind: "log" }
  | { kind: "prs" }
  | { kind: "toggle-gutter" }
  | { kind: "jump" }
  | { kind: "unknown"; args: readonly string[] };

/** The `:Glean` forms of the Lua `M.setup` dispatch. `open [base]` is kept as
 * an alias of `:Glean [base]`. */
export function parseCommand(args: unknown): Command {
  if (
    !Array.isArray(args) ||
    !args.every((a): a is string => typeof a === "string")
  ) {
    return { kind: "unknown", args: [] };
  }
  const [a0, a1] = args;
  switch (a0) {
    case undefined:
      return { kind: "dirty", base: undefined };
    case "ping":
    case "log":
    case "prs":
    case "toggle-gutter":
    case "jump":
      return { kind: a0 };
    case "open":
      return { kind: "dirty", base: a1 };
    case "pr":
      return { kind: "pr", pr: a1 };
    case "branch":
      return { kind: "branch", branch: a1 };
    case "comment":
    case "comments":
      return { kind: "unknown", args };
  }
  if (args.length === 1)
    return isPrArg(a0) ? { kind: "pr", pr: a0 } : { kind: "dirty", base: a0 };
  if (a1 !== undefined) return { kind: "range", base: a0, target: a1 };
  return { kind: "unknown", args };
}

async function handleCommand(nvim: Nvim, command: Command): Promise<void> {
  switch (command.kind) {
    case "ping":
      await nvim.call("nvim_exec_lua", [
        `vim.g.glean_pong = (vim.g.glean_pong or 0) + 1
vim.notify("glean: pong")`,
        [],
      ]);
      return;
    case "dirty": {
      const ctx = await openContext(nvim);
      await openReview(
        nvim,
        ctx,
        await openDirtySpec(ctx.git, ctx.defaultBase, command.base),
      );
      return;
    }
    case "range": {
      const ctx = await openContext(nvim);
      await openReview(nvim, ctx, {
        base: revBase(command.base),
        target: { kind: "ref", ref: command.target },
      });
      return;
    }
    case "pr": {
      const ctx = await openContext(nvim);
      await openReview(
        nvim,
        ctx,
        await openPrSpec(ctx.git, command.pr, ghRunner(ctx.root)),
      );
      return;
    }
    case "branch": {
      if (!command.branch)
        throw new TargetError("glean: branch requires a name");
      const ctx = await openContext(nvim);
      await openReview(
        nvim,
        ctx,
        await openBranchSpec(ctx.git, command.branch, ctx.defaultBase),
      );
      return;
    }
    case "log":
      await openLog(nvim, (await openContext(nvim)).root);
      return;
    case "prs":
      await openPrs(nvim, (await openContext(nvim)).root);
      return;
    case "jump":
      await jumpToReview(nvim);
      return;
    case "toggle-gutter": {
      if (!gutter) return;
      await gutter.setEnabled(!gutter.enabled);
      await nvim.call("nvim_notify", [
        `glean: gutter ${gutter.enabled ? "on" : "off"}`,
        2,
        {},
      ]);
      return;
    }
    case "unknown":
      await nvim.call("nvim_notify", [
        `glean: unknown command ${JSON.stringify(command.args)}`,
        3,
        {},
      ]);
      return;
  }
}

type OpenConfig = {
  root: string;
  dataDir: string;
  stateOverride: string | undefined;
  minSeenRun: number | undefined;
  ignoreWs: boolean;
};
/** Validates the config tuple from nvim; vim.NIL arrives as null. */
export function parseOpenConfig(v: unknown): OpenConfig {
  if (!Array.isArray(v) || v.length !== 5) throw new Error("glean: bad config");
  const [root, dataDir, state, msr, ws] = v as unknown[];
  if (typeof root !== "string" || typeof dataDir !== "string")
    throw new Error("glean: bad config paths");
  return {
    root,
    dataDir,
    stateOverride: typeof state === "string" ? state : undefined,
    minSeenRun: typeof msr === "number" ? msr : undefined,
    ignoreWs: ws === true,
  };
}
type StoreLocation = { stateDir: string; wtShard: string };
/** Same location the Lua implementation used, so existing stores keep loading:
 * `<data>/glean/<sha256(git common dir)[:16]>`, worktree shard `WORKTREE/<branch>`. */
async function storeLocation(
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
/** Resolved `rev-parse --show-toplevel` per probe path, so repeat repo-mode calls skip git. */
const repoRoots = new Map<string, string>();
/** Repo mode: the store of the repo containing `path` (default: nvim's cwd).
 * The store is re-read each call: live sessions write the same shards. */
async function repoContext(nvim: Nvim, path: string | undefined) {
  const {
    root: cwd,
    dataDir,
    stateOverride,
  } = parseOpenConfig(await nvim.call("nvim_exec_lua", [OPEN_CONFIG_LUA, []]));
  const probePath = path ?? cwd;
  let root = repoRoots.get(probePath);
  if (root === undefined) {
    const probe = new Git({ repoRoot: probePath, runner: spawnRunner() });
    const top = await probe.run(["rev-parse", "--show-toplevel"]);
    if (top.kind !== "ok")
      throw new ApiError(`glean: ${probePath} is not inside a git repository`);
    root = top.value.trim();
    repoRoots.set(probePath, root);
  }
  const git = new Git({ repoRoot: root, runner: spawnRunner() });
  const loc = await storeLocation(git, dataDir, stateOverride);
  const store = new Store(loc.stateDir, loc.wtShard);
  await store.load([]);
  return {
    root,
    git,
    store,
  };
}

const OPEN_CONFIG_LUA = `return { vim.fn.getcwd(), vim.fn.stdpath("data"), vim.g.glean_state_dir or vim.NIL, vim.g.glean_min_seen_run or vim.NIL, vim.g.glean_ignore_whitespace == true }`;

type OpenContext = OpenConfig & {
  git: Git;
  defaultBase: string;
  hunkIndent: number;
  hunkIndentDelayMs: number;
};
/** Like the Lua `resolve_repo_root`: the repo of cwd when the current buffer
 * lives under it (or is not a file), else the repo of the buffer's dir. */
async function openContext(nvim: Nvim): Promise<OpenContext> {
  const cfg = parseOpenConfig(
    await nvim.call("nvim_exec_lua", [OPEN_CONFIG_LUA, []]),
  );
  const [bufName, defaultBase, hunkIndent, hunkIndentDelay] = (await nvim.call(
    "nvim_exec_lua",
    [
      `local c = require("glean").config
return { vim.api.nvim_buf_get_name(0), c.default_base, c.hunk_indent, c.hunk_indent_delay_ms }`,
      [],
    ],
  )) as [string, unknown, unknown, unknown];
  const cwd = cfg.root;
  const bufDir =
    bufName === "" || /^\w+:\/\//.test(bufName) ? cwd : dirname(bufName);
  const discover = async (dir: string) => {
    const r = await new Git({ repoRoot: dir, runner: spawnRunner() }).run([
      "rev-parse",
      "--show-toplevel",
    ]);
    return r.kind === "ok" ? r.value.trim() : undefined;
  };
  const underCwd = bufDir === cwd || bufDir.startsWith(`${cwd}/`);
  const root =
    (underCwd ? await discover(cwd) : undefined) ??
    (await discover(bufDir)) ??
    cwd;
  return {
    ...cfg,
    root,
    git: new Git({ repoRoot: root, runner: spawnRunner() }),
    defaultBase: typeof defaultBase === "string" ? defaultBase : "main",
    hunkIndent: typeof hunkIndent === "number" ? hunkIndent : 2,
    hunkIndentDelayMs:
      typeof hunkIndentDelay === "number" ? hunkIndentDelay : 50,
  };
}

const ghRunner = (root: string) => spawnGhRunner(root);

async function notifyError(nvim: Nvim, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  await nvim.call("nvim_notify", [msg, 4, {}]);
}

/** Tear down the one review: stop its background work and wipe its buffer. */
async function closeCurrent(nvim: Nvim, opts: { keepBuf: boolean }) {
  const slot = current;
  if (!slot) return;
  current = undefined;
  reviews.length = 0;
  slot.view.session.stop();
  await slot.view.detach();
  views.delete(slot.bufnr);
  if (liveSession === slot.view.session) liveSession = undefined;
  await gutter?.refreshAll();
  if (!opts.keepBuf)
    await nvim.call("nvim_exec_lua", [
      `pcall(vim.api.nvim_buf_delete, ..., { force = true })`,
      [slot.bufnr],
    ]);
}

async function openReview(
  nvim: Nvim,
  ctx: OpenContext,
  spec: OpenSpec,
): Promise<void> {
  const { root, git } = ctx;
  const key = reviewKey(root, spec);
  if (current?.key === key) {
    const valid = (await nvim.call("nvim_buf_is_valid", [
      current.bufnr,
    ])) as boolean;
    if (valid) {
      const title = reviewTitle(
        root,
        current.review.id,
        spec,
        current.review.base,
      );
      current.review.title = title;
      await nvim.call("nvim_exec_lua", [
        `local buf, title = ...
pcall(vim.api.nvim_buf_set_name, buf, title)
require("glean.node").show_buffer(buf)`,
        [current.bufnr, title],
      ]);
      return;
    }
  }
  await closeCurrent(nvim, { keepBuf: false });
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
  const id = `g${nextReviewId++}`;
  const title = reviewTitle(root, id, spec, base);
  const bufnr = (await nvim.call("nvim_exec_lua", [
    `return require("glean.node").open_review_buffer(...)`,
    [title],
  ])) as number;
  const viewOpts: ViewOpts = {
    minSeenRun: ctx.minSeenRun ?? 5,
    hunkIndent: ctx.hunkIndent,
    hunkIndentDelayMs: ctx.hunkIndentDelayMs,
  };
  const session = new Session(sessionOpts);
  const view = new ReviewView(nvim, bufnr, session, viewOpts);
  const review: LiveReview = {
    id,
    bufnr,
    session,
    base,
    target: spec.target,
    title,
    scope: () => current?.view.scope ?? "combined",
    frame: () => current?.view.controller.frame,
  };
  reviews.push(review);
  current = { key, bufnr, view, review, sessionOpts, viewOpts };
  await startView(nvim, current);
}

/** Wire a slot's session and view up and paint the first model. */
async function startView(nvim: Nvim, slot: Current) {
  const { view, review } = slot;
  const session = view.session;
  await view.init();
  views.set(slot.bufnr, view);
  review.session = session;
  liveSession = session;
  session.subscribe(() => {
    if (liveSession === session) void gutter?.refreshAll();
    void overlay?.refreshAll();
  });
  await session.refresh();
  session.startLive(await pollIntervalMs(nvim));
}

/**
 * `:e` in the review: a hard reset. Tear the session down and rebuild it from
 * the options it was opened with in the same (blanked) buffer, keeping its id
 * and cursor row, so a wedged render or stale extmarks recover in place.
 */
async function resetCurrent(
  nvim: Nvim,
  bufnr: number,
  row: number | undefined,
) {
  const slot = current;
  if (!slot || slot.bufnr !== bufnr) return;
  slot.view.session.stop();
  await slot.view.detach();
  await nvim.call("nvim_exec_lua", [
    `local buf = ...
for _, ns in pairs(vim.api.nvim_get_namespaces()) do
  vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
end
vim.bo[buf].modifiable = true
vim.api.nvim_buf_set_lines(buf, 0, -1, false, {})
vim.bo[buf].modifiable = false`,
    [bufnr],
  ]);
  const view = new ReviewView(
    nvim,
    bufnr,
    new Session(slot.sessionOpts),
    slot.viewOpts,
  );
  slot.view = view;
  await startView(nvim, slot);
  await view.redraw();
  if (row !== undefined)
    await nvim.call("nvim_exec_lua", [
      `local buf, row = ...
local win = vim.fn.bufwinid(buf)
if win ~= -1 then
  pcall(vim.api.nvim_win_set_cursor, win, { math.min(row + 1, vim.api.nvim_buf_line_count(buf)), 0 })
end`,
      [bufnr, row],
    ]);
}

/**
 * `:Glean jump`: show the review at the current file buffer's line, opening
 * the default (dirty) review when there is none.
 */
async function jumpToReview(nvim: Nvim) {
  const [name, lnum] = (await nvim.call("nvim_exec_lua", [
    `return { vim.api.nvim_buf_get_name(0), vim.api.nvim_win_get_cursor(0)[1] }`,
    [],
  ])) as [string, number];
  let root: string;
  if (current) root = current.review.session.repoRoot;
  else {
    const ctx = await openContext(nvim);
    root = ctx.root;
  }
  const path = await repoRelative(root, name);
  if (path === undefined)
    throw new TargetError("glean: not a file in the repo");
  if (current) {
    await nvim.call("nvim_exec_lua", [
      `require("glean.node").show_buffer(...)`,
      [current.bufnr],
    ]);
  } else {
    const ctx = await openContext(nvim);
    await openReview(
      nvim,
      ctx,
      await openDirtySpec(ctx.git, ctx.defaultBase, undefined),
    );
  }
  const row = await current?.view.gotoSource(path, lnum as PostLnum);
  if (row === undefined)
    await nvim.call("nvim_notify", [
      `glean: ${path} is not part of the review`,
      3,
      {},
    ]);
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

// ---- log and PR list buffers ----

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
const lists = new Map<number, LogState | PrsState>();
/** The list buffer per (kind, repo root): reopening reuses it. */
const listBuffers = new Map<string, number>();

async function paintList(nvim: Nvim, buf: number, frame: ListFrame) {
  await nvim.call("nvim_exec_lua", [
    `local buf, lines, hls = ...
local ns = vim.api.nvim_create_namespace("glean_list")
vim.bo[buf].modifiable = true
vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
vim.bo[buf].modifiable = false
vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
for i, h in ipairs(hls) do
  local group = (i == 1) and "GleanModeHeader" or "GleanCommitHeader"
  if h[2] < 0 then
    vim.api.nvim_buf_set_extmark(buf, ns, h[1], 0, { end_row = h[1] + 1, hl_group = group, hl_eol = true })
  else
    vim.api.nvim_buf_set_extmark(buf, ns, h[1], 0, { end_col = h[2], hl_group = group })
  end
end`,
    [
      buf,
      frame.lines,
      frame.highlights.map((h) => [h.row, h.endCol === "eol" ? -1 : h.endCol]),
    ],
  ]);
}

/** The list buffer for (kind, root), created and shown when missing. */
async function listBuffer(nvim: Nvim, kind: "log" | "prs", root: string) {
  const k = `${kind}\0${root}`;
  const existing = listBuffers.get(k);
  if (
    existing !== undefined &&
    ((await nvim.call("nvim_buf_is_valid", [existing])) as boolean)
  ) {
    await nvim.call("nvim_exec_lua", [
      `require("glean.node").show_buffer(...)`,
      [existing],
    ]);
    return existing;
  }
  const buf = (await nvim.call("nvim_exec_lua", [
    `return require("glean.node").open_list_buffer(...)`,
    [kind, `Glean:${basename(root)} ${kind}`],
  ])) as number;
  listBuffers.set(k, buf);
  return buf;
}

async function fetchLog(root: string, want: number) {
  const git = new Git({ repoRoot: root, runner: spawnRunner() });
  // One extra commit tells whether older history remains.
  const r = await git.logCommits({ limit: want + 1 });
  if (r.kind !== "ok")
    throw new TargetError(`glean: git log failed: ${r.message}`);
  const hasMore = r.value.length > want;
  return { commits: hasMore ? r.value.slice(0, want) : r.value, hasMore };
}

/** `vim.g.glean_poll_ms` exists so tests need not wait out the live poll. */
async function pollIntervalMs(nvim: Nvim): Promise<number> {
  const v = await nvim.call("nvim_exec_lua", [
    "return vim.g.glean_poll_ms",
    [],
  ]);
  return typeof v === "number" && v > 0 ? v : 1000;
}
/** `vim.g.glean_log_page_size` exists so tests can page a small fixture. */
async function logPageSize(nvim: Nvim): Promise<number> {
  const v = await nvim.call("nvim_exec_lua", [
    "return vim.g.glean_log_page_size",
    [],
  ]);
  return typeof v === "number" && v > 0 ? v : LOG_PAGE_SIZE;
}
async function openLog(nvim: Nvim, root: string, show = true) {
  const k = `log\0${root}`;
  const prevBuf = listBuffers.get(k);
  const prev = prevBuf !== undefined ? lists.get(prevBuf) : undefined;
  const pageSize = await logPageSize(nvim);
  // A reopen restores however much history was loaded before.
  const want = Math.max(
    pageSize,
    prev?.kind === "log" ? prev.commits.length : 0,
  );
  const { commits, hasMore } = await fetchLog(root, want);
  const buf =
    show || prevBuf === undefined
      ? await listBuffer(nvim, "log", root)
      : prevBuf;
  const frame = renderLog(root, commits, hasMore);
  lists.set(buf, { kind: "log", root, commits, hasMore, frame });
  await paintList(nvim, buf, frame);
}

async function openPrs(nvim: Nvim, root: string, show = true) {
  const res = await ghRunner(root)(PR_LIST_ARGS);
  if (res.kind !== "ok")
    throw new TargetError(`glean: \`gh pr list\` failed: ${res.stderr}`);
  const prs = parsePrList(res.stdout);
  const k = `prs\0${root}`;
  const prevBuf = listBuffers.get(k);
  const prev = prevBuf !== undefined ? lists.get(prevBuf) : undefined;
  const buf =
    show || prevBuf === undefined
      ? await listBuffer(nvim, "prs", root)
      : prevBuf;
  const page = clampPage(
    prev?.kind === "prs" ? prev.page : 1,
    prs.length,
    PR_PAGE_SIZE,
  );
  const frame = renderPrs(root, prs, page, PR_PAGE_SIZE);
  lists.set(buf, { kind: "prs", root, prs, page, frame });
  await paintList(nvim, buf, frame);
}

type ListEvent =
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

async function handleList(nvim: Nvim, ev: ListEvent) {
  const st = lists.get(ev.buf);
  if (!st) return;
  if (ev.kind === "gone") {
    lists.delete(ev.buf);
    listBuffers.delete(`${st.kind}\0${st.root}`);
    return;
  }
  if (ev.kind === "reload") {
    if (st.kind === "log") await openLog(nvim, st.root, false);
    else await openPrs(nvim, st.root, false);
    return;
  }
  if (st.kind === "log") {
    if (ev.kind === "page") {
      if (!st.hasMore || ev.delta <= 0) return;
      const git = new Git({ repoRoot: st.root, runner: spawnRunner() });
      const pageSize = await logPageSize(nvim);
      const r = await git.logCommits({
        skip: st.commits.length,
        limit: pageSize + 1,
      });
      if (r.kind !== "ok")
        throw new TargetError(`glean: git log failed: ${r.message}`);
      st.hasMore = r.value.length > pageSize;
      st.commits.push(...r.value.slice(0, pageSize));
      st.frame = renderLog(st.root, st.commits, st.hasMore);
      await paintList(nvim, ev.buf, st.frame);
      return;
    }
    const sel = logSelection(st.commits, st.frame.rowMap, ev.srow, ev.erow);
    if (sel.kind === "none") return;
    const ctx = { ...(await openContext(nvim)), root: st.root };
    ctx.git = new Git({ repoRoot: st.root, runner: spawnRunner() });
    await openReview(nvim, ctx, sel.spec);
    return;
  }
  if (ev.kind === "page") {
    const page = clampPage(st.page + ev.delta, st.prs.length, PR_PAGE_SIZE);
    if (page === st.page) return;
    st.page = page;
    st.frame = renderPrs(st.root, st.prs, page, PR_PAGE_SIZE);
    await paintList(nvim, ev.buf, st.frame);
    await nvim.call("nvim_exec_lua", [
      `local buf = ...
for _, win in ipairs(vim.fn.win_findbuf(buf)) do
  pcall(vim.api.nvim_win_set_cursor, win, { math.min(2, vim.api.nvim_buf_line_count(buf)), 0 })
end`,
      [ev.buf],
    ]);
    return;
  }
  const idx = st.frame.rowMap.get(ev.srow);
  const pr = idx !== undefined ? st.prs[idx] : undefined;
  if (!pr) return;
  const ctx = { ...(await openContext(nvim)), root: st.root };
  ctx.git = new Git({ repoRoot: st.root, runner: spawnRunner() });
  await openReview(
    nvim,
    ctx,
    await openPrSpec(ctx.git, String(pr.number), ghRunner(st.root)),
  );
}

/** User-facing failures become error notifications; anything else is logged. */
async function reported(nvim: Nvim, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof TargetError) await notifyError(nvim, err);
    else nvim.logger.error(err instanceof Error ? err : String(err));
  }
}

export async function startGlean(nvim: Nvim): Promise<void> {
  // Handlers go in before the bridge so no notification can arrive unhandled.
  nvim.onNotification(GLEAN_COMMAND, async (args: unknown[]) => {
    await reported(nvim, () => handleCommand(nvim, parseCommand(args[0])));
  });
  nvim.onNotification(GLEAN_LIST, async (args: unknown[]) => {
    const ev = parseListEvent(args[0]);
    if (ev) await reported(nvim, () => handleList(nvim, ev));
  });
  const gutterUi = new NvimGutterUi(nvim);
  await gutterUi.init();
  const g = new FileGutter(gutterUi, () => liveSession);
  gutter = g;
  nvim.onNotification(GLEAN_GUTTER, async (args: unknown[]) => {
    const ev = parseGutterEvent(args[0]);
    if (ev) await g.handle(ev);
  });
  const overlayUi = new NvimOverlayUi(nvim);
  await overlayUi.init();
  const o = new Overlay(overlayUi, {
    repoContext: (dir) => repoContext(nvim, dir),
    repoRelative,
    pushUndo: (buf, seq, a) => g.push(buf, seq, a),
    afterWrite: afterRepoWrite,
  });
  overlay = o;
  nvim.onNotification(GLEAN_OVERLAY, async (args: unknown[]) => {
    const ev = parseOverlayEvent(args[0]);
    if (!ev) return;
    if (ev.kind === "editor-submit" || ev.kind === "pick") overlayUi.submit(ev);
    else await o.handle(ev);
  });
  nvim.onNotification(GLEAN_ACTION, async (args: unknown[]) => {
    try {
      const bufnr = args[0];
      const action = parseAction(args[1]);
      if (typeof bufnr !== "number" || !action) return;
      if (action.kind === "reset") {
        await resetCurrent(nvim, bufnr, action.row);
        return;
      }
      if (action.kind === "gone") {
        if (current?.bufnr === bufnr)
          await closeCurrent(nvim, { keepBuf: true });
        return;
      }
      await views.get(bufnr)?.dispatch(action);
    } catch (err) {
      nvim.logger.error(err instanceof Error ? err : String(err));
    }
  });
  nvim.onRequest(GLEAN_QUERY, async (args: unknown[]) => {
    const q = parseQuery(args[1]);
    const view = typeof args[0] === "number" ? views.get(args[0]) : undefined;
    return (q && view?.query(q)) ?? null;
  });
  const api = new Api({
    reviews: () => reviews,
    repoContext: (path) => repoContext(nvim, path),
    afterRepoWrite: (root) => {
      afterRepoWrite(root);
      void o.refreshAll();
    },
  });
  // Errors travel back as the rpcrequest error, so the Lua caller sees them raised.
  nvim.onRequest(GLEAN_API, async (args: unknown[]) => {
    const out = await api.call(args[0], args[1]);
    return out === undefined ? null : out;
  });
  await nvim.call("nvim_exec_lua", [
    `require("glean.node").bridge(...)`,
    [nvim.channelId],
  ]);
}
