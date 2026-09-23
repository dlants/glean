/**
 * Jump-to-source and the split diff: resolve which version of a file to show
 * (git, async) and hand nvim the window work (`glean.node` helpers).
 */
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { mapLnum } from "../core/diff.ts";
import type { RepoPath } from "../core/types.ts";
import type { Git } from "../git/git.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { DiffContext, JumpTarget, SourceRef } from "../render/nav.ts";
import { splitLines } from "../session/model.ts";
import { MAX_BATCH_LINES } from "./view.ts";

/** True when `ref` resolves to the checked-out HEAD, so the work-tree file is it. */
async function isHead(git: Git, ref: SourceRef): Promise<boolean> {
  if (ref.kind === "worktree") return true;
  const [head, r] = await Promise.all([
    git.revParse("HEAD"),
    git.revParse(ref.rev),
  ]);
  return head.kind === "ok" && r.kind === "ok" && head.value === r.value;
}

/** Where a committed post-image line sits in the work tree now, if it survived. */
async function liveLnum(
  git: Git,
  sha: string,
  path: RepoPath,
  lnum: number,
): Promise<number | undefined> {
  const d = await git.diffToWorktree(sha, { path });
  if (d.kind !== "ok") return undefined;
  const file = d.value[0];
  if (!file) return lnum;
  if (file.kind === "delete") return undefined;
  return mapLnum(file.hunks, lnum);
}

/** Line `lnum` of the work-tree file, preferring a loaded buffer's unsaved text. */
async function worktreeLine(
  nvim: Nvim,
  abs: string,
  lnum: number,
): Promise<string | undefined> {
  const fromBuf = await nvim.call("nvim_exec_lua", [
    `local abs, lnum = ...
local b = vim.fn.bufnr(abs)
if b ~= -1 and vim.api.nvim_buf_is_loaded(b) then
  return { vim.api.nvim_buf_get_lines(b, lnum - 1, lnum, false)[1] or vim.NIL }
end
return vim.NIL`,
    [abs, lnum],
  ]);
  if (Array.isArray(fromBuf))
    return typeof fromBuf[0] === "string" ? fromBuf[0] : undefined;
  try {
    return splitLines(await readFile(abs, "utf8"))[lnum - 1];
  } catch {
    return undefined;
  }
}

async function fileLines(git: Git, rev: string, path: RepoPath) {
  const r = await git.showMany(rev, [path]);
  const b = r.kind === "ok" ? r.value.get(path) : undefined;
  return b?.kind === "found" ? splitLines(b.text) : [];
}
async function fullSha(git: Git, rev: string) {
  const r = await git.revParse(rev);
  return r.kind === "ok" ? r.value : rev;
}

/** Drops the final window work when a newer jump/split/refresh superseded this one. */
export type IsStale = () => boolean;

type ScratchSpec = {
  name: string;
  path: RepoPath;
  bufhidden: "hide" | "wipe";
  /** Reuse an existing buffer with this name instead of reloading it. */
  reuse: boolean;
};
/**
 * A read-only scratch buffer holding `rev:path`. Nvim creates it empty; node
 * streams the content in bounded batches so no single request is file-sized.
 */
async function scratchBuf(
  nvim: Nvim,
  git: Git,
  rev: string,
  spec: ScratchSpec,
): Promise<number> {
  const made = (await nvim.call("nvim_exec_lua", [
    `return require("glean.node").scratch_buf(...)`,
    [spec],
  ])) as { buf: number; created: boolean };
  if (!made.created) return made.buf;
  const lines = await fileLines(git, rev, spec.path);
  await nvim.call("nvim_set_option_value", [
    "modifiable",
    true,
    { buf: made.buf },
  ]);
  for (let i = 0; i < lines.length; i += MAX_BATCH_LINES) {
    const start = i === 0 ? 0 : i;
    const end = i === 0 ? -1 : i;
    await nvim.call("nvim_buf_set_lines", [
      made.buf,
      start,
      end,
      false,
      lines.slice(i, i + MAX_BATCH_LINES),
    ]);
  }
  await nvim.call("nvim_set_option_value", [
    "modifiable",
    false,
    { buf: made.buf },
  ]);
  return made.buf;
}

/**
 * Open the source line in `win`: the live file when the ref is the work tree or
 * HEAD, or when a committed line survives verbatim in the work tree; otherwise
 * a read-only `git show` buffer named by the full sha (reused on reopen).
 */
export async function openJump(
  nvim: Nvim,
  git: Git,
  win: number,
  jt: JumpTarget,
  col: number,
  isStale: IsStale,
): Promise<void> {
  const abs = join(git.repoRoot, jt.path);
  let lnum: number = jt.lnum;
  let live = jt.kind === "post" && (await isHead(git, jt.ref));
  if (!live && jt.kind === "post" && jt.ref.kind === "rev") {
    const sha = await git.revParse(jt.ref.rev);
    const mapped =
      sha.kind === "ok"
        ? await liveLnum(git, sha.value, jt.path, jt.lnum)
        : undefined;
    if (
      mapped !== undefined &&
      (await worktreeLine(nvim, abs, mapped)) === jt.text
    ) {
      lnum = mapped;
      live = true;
    }
  }
  if (isStale()) return;
  if (live) {
    const ok = await nvim.call("nvim_exec_lua", [
      `return require("glean.node").open_file_at(...)`,
      [win, abs, lnum, col],
    ]);
    if (ok === true) return;
  }
  const rev = jt.ref.kind === "rev" ? jt.ref.rev : "HEAD";
  const name = `glean://${git.repoRoot}/.git//${await fullSha(git, rev)}/${jt.path}`;
  const buf = await scratchBuf(nvim, git, rev, {
    name,
    path: jt.path,
    bufhidden: "hide",
    reuse: true,
  });
  if (isStale()) return;
  await nvim.call("nvim_exec_lua", [
    `return require("glean.node").open_scratch_at(...)`,
    [win, buf, lnum, col],
  ]);
}

async function splitBuf(nvim: Nvim, git: Git, ref: SourceRef, path: RepoPath) {
  const rev = ref.kind === "rev" ? ref.rev : "HEAD";
  const sha = await fullSha(git, rev);
  return scratchBuf(nvim, git, rev, {
    name: `glean://${sha.slice(0, 8)}:${path}`,
    path,
    bufhidden: "wipe",
    reuse: false,
  });
}
async function readable(abs: string) {
  try {
    await access(abs, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Previous version on the left, target on the right, both in diff mode. */
export async function openDiffsplit(
  nvim: Nvim,
  git: Git,
  win: number,
  ctx: DiffContext,
  ignoreWhitespace: boolean,
  isStale: IsStale,
): Promise<void> {
  const abs = join(git.repoRoot, ctx.path);
  const liveRight = (await isHead(git, ctx.post)) && (await readable(abs));
  if (isStale()) return;
  const right = liveRight
    ? { abs }
    : { buf: await splitBuf(nvim, git, ctx.post, ctx.path) };
  const left = await splitBuf(nvim, git, ctx.pre, ctx.path);
  const l = ctx.lnums;
  // Unused scratches are `bufhidden=wipe` but never shown; wipe them when stale.
  if (isStale()) {
    for (const b of [left, "buf" in right ? right.buf : undefined])
      if (b !== undefined)
        await nvim.call("nvim_buf_delete", [b, { force: true }]);
    return;
  }
  // nvim boundary: absent line numbers travel as nil.
  await nvim.call("nvim_exec_lua", [
    `return require("glean.node").diffsplit(...)`,
    [
      win,
      right,
      l.kind === "del" ? null : l.postLnum,
      left,
      l.kind === "add" ? null : l.preLnum,
      ignoreWhitespace,
    ],
  ]);
}
