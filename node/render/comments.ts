/**
 * Pure comment placement for the review buffer: resolve each stored record in
 * the canonical (exact-whitespace) file, then map it onto a display ordinal.
 */
import { fileProjection, locate } from "../core/comments.ts";
import type { DiffLine, FileEntry } from "../core/diff.ts";
import type { CommentRecord } from "../core/state.ts";
import type { RepoPath } from "../core/types.ts";

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

export type SummaryState = "diff" | "file" | "outdated";
export type SummaryEntry = {
  path: RepoPath;
  record: CommentRecord;
  state: SummaryState;
  /** Anchored in the diff but filtered out of the display by whitespace mode. */
  hidden: boolean;
  /** Post-image (or pre-image for dels) line of the diff anchor. */
  displayLnum: number | undefined;
  /** Work-tree line, for comments that miss the diff but match the file. */
  fileLnum: number | undefined;
};
export type SummaryGroup = { path: RepoPath; entries: SummaryEntry[] };
export type CommentPair = {
  path: RepoPath;
  canonical: FileEntry | undefined;
  display: FileEntry | undefined;
};

const recordKey = (r: CommentRecord) =>
  `${r.lnum}\0${r.content.map((e) => e.text).join("\n")}\0${r.text}`;
const rank = (e: SummaryEntry) =>
  e.state === "outdated" ? 0 : e.state === "file" ? 1 : e.hidden ? 2 : 3;

/**
 * Port of `collect_comments`: every comment record of every path, classified
 * as anchored in the diff, in the work-tree file only, or outdated. Duplicate
 * records (same authored fields) keep the best-anchored copy.
 */
export function collectComments(
  pairs: readonly CommentPair[],
  recordsFor: (path: RepoPath) => readonly CommentRecord[],
  worktreeLines: (path: RepoPath) => readonly string[] | undefined,
  ignoreWhitespace: boolean,
): SummaryGroup[] {
  const groups: SummaryGroup[] = [];
  for (const pair of pairs) {
    const best = new Map<string, SummaryEntry>();
    const flat = pair.canonical ? flattenLines(pair.canonical) : [];
    const shown = pair.display ? flattenLines(pair.display) : [];
    const texts = flat.map((dl) => dl.text);
    for (const record of recordsFor(pair.path)) {
      const loc = locate(record, texts, (i) => flat[i]?.newLnum);
      const anchor = loc.kind === "found" ? flat[loc.index] : undefined;
      let fileLnum: number | undefined;
      if (loc.kind === "outdated" && fileProjection(record).length > 0) {
        const wt = worktreeLines(pair.path);
        if (wt) {
          const f = locate(record, wt, undefined, "file");
          if (f.kind === "found") fileLnum = f.lnum;
        }
      }
      const entry: SummaryEntry = {
        path: pair.path,
        record,
        state: anchor ? "diff" : fileLnum !== undefined ? "file" : "outdated",
        hidden:
          anchor !== undefined &&
          ignoreWhitespace &&
          !shown.some((dl) => sameCoordinates(dl, anchor)),
        displayLnum:
          anchor === undefined
            ? undefined
            : anchor.kind === "del"
              ? anchor.oldLnum
              : anchor.newLnum,
        fileLnum,
      };
      const key = recordKey(record);
      const prev = best.get(key);
      if (!prev || rank(entry) > rank(prev)) best.set(key, entry);
    }
    if (best.size === 0) continue;
    const entries = [...best.values()].sort(
      (a, b) =>
        (a.displayLnum ?? a.fileLnum ?? a.record.lnum) -
        (b.displayLnum ?? b.fileLnum ?? b.record.lnum),
    );
    groups.push({ path: pair.path, entries });
  }
  return groups.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}
