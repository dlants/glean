export type Brand<T, B extends string> = T & { readonly __brand: B };

export type Sha = Brand<string, "Sha">;
declare const rowBase: unique symbol;
declare const colBase: unique symbol;
/** 0-based line index: buffer rows, nvim_buf_* line args, extmark rows, array indices into a file's lines. */
export type Row = number & { readonly [rowBase]: 0 };
/** 1-based line number: cursor rows, git hunk/line numbers, user-facing lnums. */
export type Lnum = number & { readonly [rowBase]: 1 };
/** 0-based utf-8 byte column (nvim extmark/cursor col). Exclusive when used as an end. */
export type ByteCol = number & { readonly [colBase]: "byte0" };
/** 0-based utf-16 index into a JS string. */
export type StrIdx = number & { readonly [colBase]: "utf16" };
/** 1-based utf-8 byte column (vim `col()`/`getpos()`). */
export type ByteCol1 = number & { readonly [colBase]: "byte1" };
export function toRow(l: Lnum): Row {
  return (l - 1) as Row;
}
export function toLnum(r: Row): Lnum {
  return (r + 1) as Lnum;
}
/** Brands an array index or count-derived 0-based row. */
export function rowAt(i: number): Row {
  return i as Row;
}
/** Brands a parsed 1-based line number (hunk header, RPC). */
export function lnumAt(n: number): Lnum {
  return n as Lnum;
}
const utf8 = new TextEncoder();
export function byteLen(s: string): ByteCol {
  return utf8.encode(s).length as ByteCol;
}
export function addBytes(a: ByteCol, b: ByteCol): ByteCol {
  return (a + b) as ByteCol;
}
export function lineAt<T>(lines: readonly T[], l: Lnum): T | undefined {
  return lines[l - 1];
}
/** nvim handles; only produced by typed RPC wrappers. */
export type BufNr = Brand<number, "BufNr">;
export type WinId = Brand<number, "WinId">;
export type NsId = Brand<number, "NsId">;
export type RepoPath = Brand<string, "RepoPath">;
/** Line in the tip commit H. */
export type HeadLnum = Lnum & Brand<number, "HeadLnum">;
export type WorktreeLnum = Lnum & Brand<number, "WorktreeLnum">;
/** Line in a commit's post-image. */
export type PostLnum = Lnum & Brand<number, "PostLnum">;
/** Line in a commit's pre-image. */
export type PreLnum = Lnum & Brand<number, "PreLnum">;

/** The pseudo-commit naming the uncommitted work-tree layer. */
export const WORKTREE = "WORKTREE";
export type Layer = Sha | typeof WORKTREE;
/** Validates a full hex object id (e.g. from `git rev-parse`). */
export function toSha(s: string): Sha | undefined {
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(s) ? (s as Sha) : undefined;
}

/** sha256 hex of a line's or a file's content. */
export type ContentHash = Brand<string, "ContentHash">;

/**
 * Stable identity of one changed diff line. Worktree adds are named by their
 * work-tree line, worktree dels by their tip-commit (H) line.
 */
export type LineId =
  | { kind: "committed-add"; sha: Sha; path: RepoPath; lnum: PostLnum }
  | { kind: "committed-del"; removerSha: Sha; path: RepoPath; lnum: PreLnum }
  | { kind: "worktree-add"; path: RepoPath; lnum: WorktreeLnum }
  | { kind: "worktree-del"; path: RepoPath; lnum: HeadLnum };

/** Validates a repo-relative path: non-empty, not absolute, no `..` segment. */
export function toRepoPath(p: string): RepoPath | undefined {
  return p === "" || p.startsWith("/") || p.split("/").includes("..")
    ? undefined
    : (p as RepoPath);
}
export const ROW0 = 0 as Row;
export const COL0 = 0 as ByteCol;
