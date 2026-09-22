import type { DiffLine, Hunk } from "../core/diff.ts";
import { lineHash } from "../core/state.ts";
import type { RepoPath } from "../core/types.ts";

/** A contiguous run of seen changed lines inside a hunk (indices are 0-based into `hunk.lines`). */
export type MarkerRun = {
  lo: number;
  hi: number;
  /** Post-image line bounds; undefined for a run made only of lines without one. */
  lnumLo: number | undefined;
  lnumHi: number | undefined;
  texts: readonly string[];
};

/** A del has no post-image line of its own for marker-bounds purposes. */
function postLnum(dl: DiffLine): number | undefined {
  return dl.kind === "add" ? dl.newLnum : undefined;
}

export function hunkMarkerRuns(
  hunk: Pick<Hunk, "lines">,
  isSeen: (dl: DiffLine, index: number) => boolean,
): MarkerRun[] {
  const runs: MarkerRun[] = [];
  let cur:
    | {
        lo: number;
        hi: number;
        lnumLo: number | undefined;
        lnumHi: number | undefined;
        texts: string[];
      }
    | undefined;
  hunk.lines.forEach((dl, i) => {
    if (dl.kind !== "context" && isSeen(dl, i)) {
      const lnum = postLnum(dl);
      if (cur === undefined) {
        cur = { lo: i, hi: i, lnumLo: lnum, lnumHi: lnum, texts: [dl.text] };
      } else {
        cur.hi = i;
        cur.lnumHi = lnum ?? cur.lnumHi;
        cur.lnumLo = cur.lnumLo ?? lnum;
        cur.texts.push(dl.text);
      }
    } else if (cur !== undefined) {
      runs.push(cur);
      cur = undefined;
    }
  });
  if (cur !== undefined) runs.push(cur);
  return runs;
}

/**
 * Display-only demotion of short seen runs (combined scope): a run shorter than
 * `threshold` keeps only its sticky lines; `threshold <= 1` disables demotion.
 * Returns the set of `hunk.lines` indices that still render as seen.
 */
export function displaySeenSet(
  runs: readonly MarkerRun[],
  threshold: number,
  isSticky: (index: number) => boolean,
): Set<number> {
  const out = new Set<number>();
  for (const run of runs) {
    const keepAll = threshold <= 1 || run.texts.length >= threshold;
    for (let i = run.lo; i <= run.hi; i++) {
      if (keepAll || isSticky(i)) out.add(i);
    }
  }
  return out;
}

declare const markerKeyBrand: unique symbol;
export type MarkerKey = string & { readonly [markerKeyBrand]: true };

/** Content-addressed collapse key, stable across line-number shifts; scope-prefixed. */
export function markerKey(
  scope: "combined" | "commits",
  path: RepoPath,
  texts: readonly string[],
): MarkerKey {
  const prefix = scope === "combined" ? "cmk:" : "mk:";
  return `${prefix}${path}\0${lineHash(texts.join("\n"))}` as MarkerKey;
}
