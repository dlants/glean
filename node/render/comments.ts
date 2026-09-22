/**
 * Pure comment placement for the review buffer: resolve each stored record in
 * the canonical (exact-whitespace) file, then map it onto a display ordinal.
 */
import { locate } from "../core/comments.ts";
import type { DiffLine, FileEntry } from "../core/diff.ts";
import type { CommentRecord } from "../core/state.ts";

export type PlacedComment = {
  record: CommentRecord;
  /** Not found in the diff: shown at the display line nearest its lnum hint. */
  outdated: boolean;
};

export function flattenLines(file: FileEntry): DiffLine[] {
  return file.hunks.flatMap((h) => h.lines);
}

function sameCoordinates(a: DiffLine, b: DiffLine): boolean {
  return (
    a.kind === b.kind &&
    a.text === b.text &&
    a.newLnum === b.newLnum &&
    ("oldLnum" in a ? a.oldLnum : undefined) ===
      ("oldLnum" in b ? b.oldLnum : undefined)
  );
}

function nearestIndex(flat: readonly DiffLine[], lnum: number): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  flat.forEach((dl, i) => {
    const d = Math.abs(dl.newLnum - lnum);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  return best;
}

/**
 * Comments keyed by 0-based display line index within `display`. A canonical
 * match with no display counterpart is hidden by whitespace mode and omitted.
 */
export function resolveComments(
  display: FileEntry,
  canonical: FileEntry | undefined,
  records: readonly CommentRecord[],
): Map<number, PlacedComment[]> {
  const out = new Map<number, PlacedComment[]>();
  const exact = flattenLines(canonical ?? display);
  const shown = flattenLines(display);
  if (exact.length === 0 || shown.length === 0) return out;
  const texts = exact.map((dl) => dl.text);
  for (const record of records) {
    const loc = locate(record, texts, (i) => exact[i]?.newLnum);
    let idx: number;
    if (loc.kind === "found") {
      const want = exact[loc.index];
      const found = want
        ? shown.findIndex((dl) => sameCoordinates(dl, want))
        : -1;
      if (found < 0) continue;
      idx = found;
    } else {
      idx = nearestIndex(shown, record.lnum);
    }
    const list = out.get(idx) ?? [];
    list.push({ record, outdated: loc.kind === "outdated" });
    out.set(idx, list);
  }
  return out;
}
