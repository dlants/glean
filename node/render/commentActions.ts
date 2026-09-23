/**
 * Pure planners for the review-buffer comment editor (port of
 * `Session:comment_target` / `visual_comment_target` / `comment_under` /
 * `delete_comment_at` / `delete_comments_visual_range`).
 */
import type { DiffLine, FileEntry } from "../core/diff.ts";
import type {
  CommentEntry,
  CommentOrigin,
  CommentRecord,
  Store,
} from "../core/state.ts";
import { type RepoPath, type Sha, WORKTREE } from "../core/types.ts";
import type { Classifier, Scope } from "../session/model.ts";
import { resolveFile } from "./actions.ts";
import type { PlacedComment } from "./comments.ts";
import type { FileRef, RowTarget } from "./render.ts";

export type CommentTarget = {
  path: RepoPath;
  lnum: number;
  content: CommentEntry[];
  origin: CommentOrigin;
};

type LineRow = Extract<RowTarget, { kind: "line" | "marker-line" }>;
const lineRow = (t: RowTarget | undefined): LineRow | undefined =>
  t && (t.kind === "line" || t.kind === "marker-line") ? t : undefined;

function entryOf(dl: DiffLine): CommentEntry {
  return dl.kind === "del"
    ? { kind: "del", text: dl.text, oldLnum: dl.oldLnum }
    : { kind: dl.kind, text: dl.text };
}
/** First non-del post-image line, else the slot the deleted text sat before. */
function lnumOf(dls: readonly DiffLine[]): number {
  return (dls.find((d) => d.kind !== "del") ?? dls[0])?.newLnum ?? 1;
}
function sameLine(a: DiffLine, b: DiffLine): boolean {
  return (
    a.kind === b.kind &&
    a.text === b.text &&
    a.newLnum === b.newLnum &&
    ("oldLnum" in a ? a.oldLnum : undefined) ===
      ("oldLnum" in b ? b.oldLnum : undefined)
  );
}
/**
 * The exact-whitespace file a display file resolves in. Combined scope uses the
 * canonical files; commit scope has no per-commit exact files in node, so the
 * displayed commit file (real git coordinates) stands in for them.
 */
function canonicalOf(
  cls: Classifier,
  ref: FileRef,
  file: FileEntry,
): FileEntry | undefined {
  return ref.scope === "combined"
    ? cls.model.canonicalFiles.find((f) => f.path === file.path)
    : file;
}
function ordinal(
  file: FileEntry | undefined,
  dl: DiffLine,
): number | undefined {
  if (!file) return undefined;
  let i = 0;
  for (const h of file.hunks)
    for (const l of h.lines) {
      if (sameLine(l, dl)) return i;
      i++;
    }
  return undefined;
}
function lineAt(cls: Classifier, t: LineRow) {
  const r = resolveFile(cls, t.file);
  const dl = r?.file.hunks[t.hunk]?.lines[t.li];
  return r && dl ? { file: r.file, sha: r.sha, dl } : undefined;
}

/** Provenance of a selection: which commit (and whether dirty) it was read from. */
export function commentOrigin(
  cls: Classifier,
  scope: Scope,
  ref: FileRef,
  path: RepoPath,
  worktree: boolean,
): CommentOrigin {
  const wt: CommentOrigin = { sha: WORKTREE as string as Sha, dirty: true };
  if (scope === "commits") {
    const commit =
      ref.scope === "commits" ? cls.model.commits[ref.commit] : undefined;
    if (!commit || commit.sha === WORKTREE) return wt;
    return { sha: commit.sha, dirty: false };
  }
  let sha: Sha | undefined;
  for (const c of cls.model.commits)
    if (c.sha !== WORKTREE && c.files.some((f) => f.path === path)) sha = c.sha;
  if (!sha) return wt;
  return {
    sha,
    dirty: worktree && cls.model.files.some((f) => f.path === path),
  };
}

/**
 * The authoring target for rows `srow..erow`: the contiguous run of literal
 * diff lines in one file (capture stops at the first canonical-ordinal gap).
 */
export function commentTarget(
  cls: Classifier,
  scope: Scope,
  rows: readonly RowTarget[],
  srow: number,
  erow: number,
  worktree: boolean,
): CommentTarget | undefined {
  let first: { ref: FileRef; path: RepoPath } | undefined;
  let prev = -1;
  const dls: DiffLine[] = [];
  for (let row = srow; row <= erow; row++) {
    const t = lineRow(rows[row]);
    if (!t) continue;
    const l = lineAt(cls, t);
    if (!l) continue;
    const ord = ordinal(canonicalOf(cls, t.file, l.file), l.dl);
    if (ord === undefined) break;
    if (!first) {
      first = { ref: t.file, path: l.file.path };
    } else if (l.file.path !== first.path || ord !== prev + 1) break;
    dls.push(l.dl);
    prev = ord;
  }
  if (!first) return undefined;
  return {
    path: first.path,
    lnum: lnumOf(dls),
    content: dls.map(entryOf),
    origin: commentOrigin(cls, scope, first.ref, first.path, worktree),
  };
}

/** The stored record a comment row (inline or summary) renders, if any. */
export function commentUnder(
  cls: Classifier,
  store: Store,
  t: RowTarget | undefined,
): { path: RepoPath; record: CommentRecord } | undefined {
  if (!t || (t.kind !== "comment" && t.kind !== "summary-comment"))
    return undefined;
  const path =
    t.kind === "comment" ? resolveFile(cls, t.file)?.file.path : t.path;
  const record =
    path && store.commentsFor(path).find((r) => r.id === t.commentId);
  return path && record ? { path, record } : undefined;
}

/** `dc`: the comments anchored at a line row, via the render's comment placement. */
export function commentsAtLine(
  cls: Classifier,
  t: RowTarget | undefined,
  placed: (
    ref: FileRef,
    file: FileEntry,
  ) => ReadonlyMap<number, readonly PlacedComment[]>,
): { path: RepoPath; records: CommentRecord[] } | undefined {
  const lr = lineRow(t);
  const r = lr && resolveFile(cls, lr.file);
  if (!lr || !r) return undefined;
  let idx = lr.li;
  for (let h = 0; h < lr.hunk; h++) idx += r.file.hunks[h]?.lines.length ?? 0;
  const list = placed(lr.file, r.file).get(idx) ?? [];
  return { path: r.file.path, records: list.map((p) => p.record) };
}

/** Visual `d`: each distinct summary comment in the range, once. */
export function summaryCommentsIn(
  store: Store,
  rows: readonly RowTarget[],
  srow: number,
  erow: number,
): { path: RepoPath; record: CommentRecord }[] {
  const lo = Math.min(srow, erow);
  const hi = Math.max(srow, erow);
  const out: { path: RepoPath; record: CommentRecord }[] = [];
  const seen = new Set<string>();
  for (const t of rows.slice(lo, hi + 1)) {
    if (t.kind !== "summary-comment") continue;
    const key = `${t.path}\0${t.commentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const record = store.commentsFor(t.path).find((r) => r.id === t.commentId);
    if (record) out.push({ path: t.path, record });
  }
  return out;
}
