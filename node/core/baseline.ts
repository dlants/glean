/**
 * Pure algebra of the reviewed baseline R for one uncommitted file.
 * See plans/2026-08-28-reviewed-baseline.md.
 *
 * H (head) is the file at the review's tip commit, R (reviewed) what the
 * reviewer signed off on, W (worktree) the file now. This decides only the
 * *added* lines of diff(H, W): an add at work-tree line N is seen iff it is not
 * an add of diff(R, W). Deletions are stored explicitly as head line numbers
 * by the caller, so R only ever grows toward W and diff(H, R) is add-only.
 */
import { alignLines, type LineOp } from "./linediff.ts";
import type { WorktreeLnum } from "./types.ts";

export { alignLines as align, type LineOp };

export function mapForward(
  ops: readonly LineOp[],
  aLnum: number,
): number | undefined {
  for (const op of ops) {
    if (op.kind !== "add" && op.aLnum === aLnum) {
      return op.kind === "context" ? op.bLnum : undefined;
    }
  }
  return undefined;
}

export function mapBack(
  ops: readonly LineOp[],
  bLnum: number,
): number | undefined {
  for (const op of ops) {
    if (op.kind !== "del" && op.bLnum === bLnum) {
      return op.kind === "context" ? op.aLnum : undefined;
    }
  }
  return undefined;
}

/** Work-tree lines of W that are adds of diff(R, W), i.e. *not* seen. */
export function unseenAdds(
  reviewed: readonly string[],
  worktree: readonly string[],
): Set<WorktreeLnum> {
  const out = new Set<WorktreeLnum>();
  for (const op of alignLines(reviewed, worktree)) {
    if (op.kind === "add") out.add(op.bLnum as WorktreeLnum);
  }
  return out;
}

/** R after marking work-tree lines `sel` seen: grow R toward W over exactly those. */
export function markAdds(
  reviewed: readonly string[],
  worktree: readonly string[],
  sel: Iterable<WorktreeLnum>,
): string[] {
  const chosen = new Set<number>(sel);
  const out: string[] = [];
  for (const op of alignLines(reviewed, worktree)) {
    // A line of R absent from W stays in R either way.
    if (op.kind !== "add" || chosen.has(op.bLnum)) out.push(op.text);
  }
  return out;
}

/** R after unmarking work-tree lines `sel`: drop them unless they are head lines. */
export function unmarkAdds(
  head: readonly string[],
  reviewed: readonly string[],
  worktree: readonly string[],
  sel: Iterable<WorktreeLnum>,
): string[] {
  const u = alignLines(reviewed, worktree);
  const dropR = new Set<number>();
  for (const n of sel) {
    const r = mapBack(u, n);
    if (r !== undefined) dropR.add(r);
  }
  const out: string[] = [];
  for (const op of alignLines(head, reviewed)) {
    if (op.kind !== "add" || !dropR.has(op.bLnum)) out.push(op.text);
  }
  return out;
}
