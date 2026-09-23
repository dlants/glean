export type Brand<T, B extends string> = T & { readonly __brand: B };

export type Sha = Brand<string, "Sha">;
/** 0-based row in a glean-owned buffer. */
export type BufRow = Brand<number, "BufRow">;
/** nvim handles; only produced by typed RPC wrappers. */
export type BufNr = Brand<number, "BufNr">;
export type WinId = Brand<number, "WinId">;
export type NsId = Brand<number, "NsId">;
export type RepoPath = Brand<string, "RepoPath">;
/** Line in the tip commit H. */
export type HeadLnum = Brand<number, "HeadLnum">;
export type WorktreeLnum = Brand<number, "WorktreeLnum">;
/** Line in a commit's post-image. */
export type PostLnum = Brand<number, "PostLnum">;
/** Line in a commit's pre-image. */
export type PreLnum = Brand<number, "PreLnum">;

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
