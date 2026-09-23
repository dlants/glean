/**
 * Sticky headers (pure): for each row, the enclosing commit/file/seen-section/
 * hunk header rows, and which of them to pin above a given topline. Ports the
 * Lua `compute_ancestry`/`compute_pinned`.
 */
import type { RowTarget } from "./render.ts";

export type Ancestry = {
  commit?: number;
  file?: number;
  sec?: number;
  hunk?: number;
};

/** A shallower header clears the deeper levels below it. */
export function computeAncestry(rows: readonly RowTarget[]): Ancestry[] {
  const out: Ancestry[] = [];
  let cur: Ancestry = {};
  rows.forEach((t, row) => {
    if (t.kind === "commit-header") cur = { commit: row };
    else if (t.kind === "seen-section") {
      const { hunk: _, ...rest } = cur;
      cur = { ...rest, sec: row };
    } else if (t.kind === "file-header")
      cur =
        cur.commit === undefined
          ? { file: row }
          : { commit: cur.commit, file: row };
    else if (t.kind === "hunk-header") cur = { ...cur, hunk: row };
    out.push(cur);
  });
  return out;
}

/**
 * Once the top row scrolls away it is always pinned, followed by the enclosing
 * headers strictly above `w0`. Empty means no float.
 */
export function computePinned(
  ancestry: readonly Ancestry[],
  w0: number,
): number[] {
  const a = ancestry[w0];
  if (!a) return [];
  const pinned = w0 > 0 ? [0] : [];
  for (const row of [a.commit, a.file, a.sec, a.hunk])
    if (row !== undefined && row < w0) pinned.push(row);
  return pinned;
}
