/**
 * Sticky headers (pure): for each row, the enclosing commit/file/seen-section/
 * hunk header rows, and which of them to pin above a given topline. Ports the
 * Lua `compute_ancestry`/`compute_pinned`.
 */
import type { BufRow } from "../core/types.ts";
import type { RowTarget } from "./render.ts";
/** A seen-section or hunk header only exists under a file header. */
export type FileAncestry = { row: BufRow; sec?: BufRow; hunk?: BufRow };
export type Ancestry = { commit?: BufRow; file?: FileAncestry };
/** A shallower header clears the deeper levels below it. */
export function computeAncestry(rows: readonly RowTarget[]): Ancestry[] {
  const out: Ancestry[] = [];
  let cur: Ancestry = {};
  rows.forEach((t, i) => {
    const row = i as BufRow;
    const f = cur.file;
    if (t.kind === "commit-header") cur = { commit: row };
    else if (t.kind === "file-header")
      cur =
        cur.commit === undefined
          ? { file: { row } }
          : { commit: cur.commit, file: { row } };
    else if (t.kind === "seen-section" && f)
      cur = { ...cur, file: { row: f.row, sec: row } };
    else if (t.kind === "hunk-header" && f)
      cur = { ...cur, file: { ...f, hunk: row } };
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
): BufRow[] {
  const a = ancestry[w0];
  if (!a) return [];
  const pinned: BufRow[] = w0 > 0 ? [0 as BufRow] : [];
  for (const row of [a.commit, a.file?.row, a.file?.sec, a.file?.hunk])
    if (row !== undefined && row < w0) pinned.push(row);
  return pinned;
}
