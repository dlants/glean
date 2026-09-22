/** Sets of inclusive integer line ranges, kept merged, sorted and non-adjacent. */

export type Range<L extends number> = readonly [L, L];
export type RangeSet<L extends number> = readonly Range<L>[];

export function merge<L extends number>(ranges: RangeSet<L>): Range<L>[] {
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

export function add<L extends number>(
  ranges: RangeSet<L>,
  r: Range<L>,
): Range<L>[] {
  return merge([...ranges, r]);
}

export function remove<L extends number>(
  ranges: RangeSet<L>,
  [rs, re]: Range<L>,
): Range<L>[] {
  const out: Range<L>[] = [];
  for (const [s, e] of merge(ranges)) {
    if (re < s || rs > e) {
      out.push([s, e]);
      continue;
    }
    if (s < rs) out.push([s, (rs - 1) as L]);
    if (e > re) out.push([(re + 1) as L, e]);
  }
  return out;
}

export function covers<L extends number>(
  ranges: RangeSet<L>,
  lnum: L,
): boolean {
  return ranges.some(([s, e]) => lnum >= s && lnum <= e);
}

export function rangeCovered<L extends number>(
  ranges: RangeSet<L>,
  [s, e]: Range<L>,
): boolean {
  return merge(ranges).some(([a, b]) => a <= s && e <= b);
}
