/**
 * Comment records resolved against a diff (every entry) or a plain file
 * (non-deleted entries only). Pure.
 */
import { type CommentRecord, resolve } from "./state.ts";

export type Projection = "diff" | "file";

export function diffProjection(
  record: Pick<CommentRecord, "content">,
): string[] {
  return record.content.map((e) => e.text);
}

export function fileProjection(
  record: Pick<CommentRecord, "content">,
): string[] {
  return record.content.filter((e) => e.kind !== "del").map((e) => e.text);
}

export type Located =
  | { kind: "found"; index: number; lnum: number }
  /** `fallback` is the index whose lnum is nearest the record's hint, if any. */
  | { kind: "outdated"; lnum: number; fallback: number | undefined };

/**
 * Resolve `record` in `lines` (0-based). `lnumOf` maps an index to a post-image
 * line number (default: a file buffer, where index i is line i + 1).
 */
export function locate(
  record: Pick<CommentRecord, "content" | "lnum">,
  lines: readonly string[],
  lnumOf: (i: number) => number | undefined = (i) => i + 1,
  projection: Projection = "diff",
): Located {
  const needles =
    projection === "file" ? fileProjection(record) : diffProjection(record);
  const start = resolve(needles, lines, lnumOf, record.lnum);
  if (start !== undefined) {
    return { kind: "found", index: start, lnum: lnumOf(start) ?? record.lnum };
  }
  let best: { i: number; lnum: number; dist: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lnumOf(i);
    if (l === undefined) continue;
    const dist = Math.abs(l - record.lnum);
    if (!best || dist < best.dist) best = { i, lnum: l, dist };
  }
  return {
    kind: "outdated",
    lnum: best?.lnum ?? record.lnum,
    fallback: best?.i,
  };
}
