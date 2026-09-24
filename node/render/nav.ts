/**
 * Pure planners for navigation and jump-to-source (ports of `nav_to`,
 * `hunk_range`, `jump_target`, `diff_context`, `row_post_lnum` and the row
 * selection of `goto_source_line`). The view applies them to nvim.
 */
import type { DiffLine } from "../core/diff.ts";
import {
  type PostLnum,
  type PreLnum,
  type RepoPath,
  WORKTREE,
  type WorktreeLnum,
} from "../core/types.ts";
import type { Classifier, Target } from "../session/model.ts";
import { resolveFile } from "./actions.ts";
import type { FileRef, Frame, RowTarget } from "./render.ts";

export type NavUnit = "hunk" | "file";

/** Nearest visible hunk header / file header strictly past `cur`. */
export function navRow(
  frame: Frame,
  cur: number,
  unit: NavUnit,
  forward: boolean,
): number | undefined {
  const want = unit === "hunk" ? "hunk-header" : "file-header";
  const step = forward ? 1 : -1;
  for (let r = cur + step; r >= 0 && r < frame.rows.length; r += step)
    if (frame.rows[r]?.kind === want) return r;
  return undefined;
}

type HunkRow = Extract<RowTarget, { file: FileRef; hunk: number }>;
function hunkOf(t: RowTarget | undefined): HunkRow | undefined {
  return t && "hunk" in t ? t : undefined;
}
function sameHunk(a: HunkRow, b: HunkRow): boolean {
  const fa = a.file;
  const fb = b.file;
  return (
    a.hunk === b.hunk &&
    fa.file === fb.file &&
    fa.scope === fb.scope &&
    (fa.scope === "combined" ||
      (fb.scope === "commits" && fa.commit === fb.commit))
  );
}
/** First and last row of the hunk under `row` (header, lines, markers, comments). */
export function hunkRange(
  frame: Frame,
  row: number,
): { lo: number; hi: number } | undefined {
  const t = hunkOf(frame.rows[row]);
  if (!t) return undefined;
  let lo = row;
  let hi = row;
  frame.rows.forEach((o, r) => {
    const h = hunkOf(o);
    if (!h || !sameHunk(h, t)) return;
    lo = Math.min(lo, r);
    hi = Math.max(hi, r);
  });
  return { lo, hi };
}

/** A version of a file to show: the live work tree or a git rev. */
export type SourceRef = { kind: "worktree" } | { kind: "rev"; rev: string };
export type ReviewRange = { base: string; target: Target };

type LineRow = Extract<RowTarget, { kind: "line" | "marker-line" }>;
function lineRowOf(t: RowTarget | undefined): LineRow | undefined {
  return t && (t.kind === "line" || t.kind === "marker-line") ? t : undefined;
}
const postOf = (dl: DiffLine) => dl.newLnum as PostLnum;
function diffLineOf(
  cls: Classifier,
  row: RowTarget | undefined,
  range: ReviewRange,
):
  | { dl: DiffLine; path: RepoPath; post: SourceRef; pre: SourceRef }
  | undefined {
  const t = lineRowOf(row);
  if (!t) return undefined;
  const r = resolveFile(cls, t.file);
  const dl = r?.file.hunks[t.hunk]?.lines[t.li];
  if (!r || !dl) return undefined;
  let post: SourceRef;
  let pre: SourceRef;
  if (t.file.scope === "combined") {
    post =
      range.target.kind === "worktree"
        ? { kind: "worktree" }
        : { kind: "rev", rev: range.target.ref };
    pre = { kind: "rev", rev: range.base };
  } else if (r.sha === WORKTREE) {
    post = { kind: "worktree" };
    pre = { kind: "rev", rev: "HEAD" };
  } else {
    post = { kind: "rev", rev: r.sha ?? "HEAD" };
    pre = { kind: "rev", rev: `${r.sha}^` };
  }
  return { dl, path: r.file.path, post, pre };
}

export type JumpTarget =
  | {
      kind: "post";
      ref: SourceRef;
      path: RepoPath;
      lnum: PostLnum;
      text: string;
    }
  | { kind: "del"; ref: SourceRef; path: RepoPath; lnum: PreLnum };
/** The source line a diff row points at: a deletion reads its pre-image. */
export function jumpTarget(
  cls: Classifier,
  t: RowTarget | undefined,
  range: ReviewRange,
): JumpTarget | undefined {
  const d = diffLineOf(cls, t, range);
  if (!d) return undefined;
  if (d.dl.kind === "del")
    return {
      kind: "del",
      ref: d.pre,
      path: d.path,
      lnum: d.dl.oldLnum as PreLnum,
    };
  return {
    kind: "post",
    ref: d.post,
    path: d.path,
    lnum: postOf(d.dl),
    text: d.dl.text,
  };
}

/** Which side(s) of the split the row's line exists on, by diff line kind. */
export type DiffLnums =
  | { kind: "add"; postLnum: PostLnum }
  | { kind: "del"; preLnum: PreLnum }
  | { kind: "context"; postLnum: PostLnum; preLnum: PreLnum };
export type DiffContext = {
  path: RepoPath;
  post: SourceRef;
  pre: SourceRef;
  lnums: DiffLnums;
};
/** The two versions bounding the hunk under a row, for the split diff. */
export function diffContext(
  cls: Classifier,
  t: RowTarget | undefined,
  range: ReviewRange,
): DiffContext | undefined {
  const d = diffLineOf(cls, t, range);
  if (!d) return undefined;
  const dl = d.dl;
  const lnums: DiffLnums =
    dl.kind === "add"
      ? { kind: "add", postLnum: postOf(dl) }
      : dl.kind === "del"
        ? { kind: "del", preLnum: dl.oldLnum as PreLnum }
        : {
            kind: "context",
            postLnum: postOf(dl),
            preLnum: dl.oldLnum as PreLnum,
          };
  return { path: d.path, post: d.post, pre: d.pre, lnums };
}

/**
 * The post-image line a row stands for. A deletion takes the following
 * surviving line's number (its `newLnum` slot), so it is only picked when the
 * requested line is exactly there.
 */
export function rowPostLnum(
  cls: Classifier,
  t: RowTarget | undefined,
): { path: RepoPath; lnum: PostLnum } | undefined {
  const l = lineRowOf(t);
  if (!l) return undefined;
  const r = resolveFile(cls, l.file);
  const dl = r?.file.hunks[l.hunk]?.lines[l.li];
  return r && dl ? { path: r.file.path, lnum: postOf(dl) } : undefined;
}

export function fileHeaderRow(
  cls: Classifier,
  frame: Frame,
  path: RepoPath,
): number | undefined {
  const r = frame.rows.findIndex(
    (t) =>
      t.kind === "file-header" && resolveFile(cls, t.file)?.file.path === path,
  );
  return r < 0 ? undefined : r;
}

/** The row showing post-image `lnum` of `path`, else the nearest one, else the file header. */
export function sourceLineRow(
  cls: Classifier,
  frame: Frame,
  path: RepoPath,
  /** A file-buffer line; matched to the nearest post-image line by number. */
  lnum: WorktreeLnum,
): number | undefined {
  let best: number | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  frame.rows.forEach((t, r) => {
    const p = rowPostLnum(cls, t);
    if (!p || p.path !== path) return;
    const score = Math.abs(p.lnum - lnum);
    if (score < bestScore) {
      best = r;
      bestScore = score;
    }
  });
  return best ?? fileHeaderRow(cls, frame, path);
}
