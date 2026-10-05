import type { Lnum } from "./types.ts";
/** Sets of inclusive integer line ranges, kept merged, sorted and non-adjacent. */

export type Range<L extends Lnum> = readonly [L, L];
export type RangeSet<L extends Lnum> = readonly Range<L>[];

export function merge<L extends Lnum>(ranges: RangeSet<L>): Range<L>[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [L, L][] = [];
  for (const [s, e] of sorted) {
    const last = out.at(-1);
    if (last && s <= last[1] + 1) {
      if (e > last[1]) last[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

export function add<L extends Lnum>(
  ranges: RangeSet<L>,
  r: Range<L>,
): Range<L>[] {
  return merge([...ranges, r]);
}

export function remove<L extends Lnum>(
  ranges: RangeSet<L>,
  [rs, re]: Range<L>,
): Range<L>[] {
  const out: Range<L>[] = [];
  for (const [s, e] of merge(ranges)) {
    if (re < s || rs > e) {
      out.push([s, e]);
      continue;
    }
    if (s < rs) out.push([s, shiftLnum(rs, -1)]);
    if (e > re) out.push([shiftLnum(re, 1), e]);
  }
  return out;
}

export function covers<L extends Lnum>(ranges: RangeSet<L>, lnum: L): boolean {
  return ranges.some(([s, e]) => lnum >= s && lnum <= e);
}

export function rangeCovered<L extends Lnum>(
  ranges: RangeSet<L>,
  [s, e]: Range<L>,
): boolean {
  return merge(ranges).some(([a, b]) => a <= s && e <= b);
}

/** Shifts within one line space; ranges never mix spaces. */
function shiftLnum<L extends Lnum>(l: L, delta: number): L {
  return (l + delta) as L;
}
