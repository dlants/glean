/**
 * Jump-to-source and the split diff: resolve which version of a file to show
 * (git, async) and hand nvim the window work (`glean.node` helpers).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mapLnum } from "../core/diff.ts";
import type { RepoPath } from "../core/types.ts";
import type { Git } from "../git/git.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { DiffContext, JumpTarget, SourceRef } from "../render/nav.ts";
import { splitLines } from "../session/model.ts";

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
): Promise<void> {
  const abs = join(git.repoRoot, jt.path);
  let lnum = jt.lnum;
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
  if (live) {
    const ok = await nvim.call("nvim_exec_lua", [
      `return require("glean.node").open_file_at(...)`,
      [win, abs, lnum, col],
    ]);
    if (ok === true) return;
  }
  const rev = jt.ref.kind === "rev" ? jt.ref.rev : "HEAD";
  const name = `glean://${git.repoRoot}/.git//${await fullSha(git, rev)}/${jt.path}`;
  const existing = await nvim.call("nvim_call_function", ["bufnr", [name]]);
  const lines =
    existing === -1 ? await fileLines(git, rev, jt.path) : undefined;
  await nvim.call("nvim_exec_lua", [
    `return require("glean.node").open_scratch_at(...)`,
    [
      win,
      { name, lines: lines ?? null, path: jt.path, bufhidden: "hide" },
      lnum,
      col,
    ],
  ]);
}

async function scratchSpec(git: Git, ref: SourceRef, path: RepoPath) {
  const rev = ref.kind === "rev" ? ref.rev : "HEAD";
  const sha = await fullSha(git, rev);
  return {
    name: `glean://${sha.slice(0, 8)}:${path}`,
    lines: await fileLines(git, rev, path),
    path,
    bufhidden: "wipe",
  };
}

/** Previous version on the left, target on the right, both in diff mode. */
export async function openDiffsplit(
  nvim: Nvim,
  git: Git,
  win: number,
  ctx: DiffContext,
  ignoreWhitespace: boolean,
): Promise<void> {
  const abs = join(git.repoRoot, ctx.path);
  const right = (await isHead(git, ctx.post))
    ? { abs, fallback: await scratchSpec(git, ctx.post, ctx.path) }
    : await scratchSpec(git, ctx.post, ctx.path);
  const left = await scratchSpec(git, ctx.pre, ctx.path);
  await nvim.call("nvim_exec_lua", [
    `return require("glean.node").diffsplit(...)`,
    [
      win,
      right,
      ctx.postLnum ?? null,
      left,
      ctx.preLnum ?? null,
      ignoreWhitespace,
    ],
  ]);
}
