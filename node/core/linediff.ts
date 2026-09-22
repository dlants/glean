/**
 * Myers O((N+M)·D) line diff over in-memory line lists. Replaces `vim.diff`.
 */

export type LineOp =
  | { kind: "context"; text: string; aLnum: number; bLnum: number }
  | { kind: "del"; text: string; aLnum: number }
  | { kind: "add"; text: string; bLnum: number };

/**
 * Every line of both sides appears exactly once, in order, 1-based line numbers.
 * Within a change region all dels precede all adds.
 */
export function alignLines(
  a: readonly string[],
  b: readonly string[],
): LineOp[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  const keep = middleMatches(
    a.slice(pre, a.length - suf),
    b.slice(pre, b.length - suf),
  );
  // Matched pairs (0-based over the full lists), in order.
  const matches: [number, number][] = [];
  for (let k = 0; k < pre; k++) matches.push([k, k]);
  for (const [x, y] of keep) matches.push([x + pre, y + pre]);
  for (let k = suf; k > 0; k--) matches.push([a.length - k, b.length - k]);
  matches.push([a.length, b.length]);

  const ops: LineOp[] = [];
  let ai = 0;
  let bi = 0;
  for (const [x, y] of matches) {
    for (; ai < x; ai++) ops.push({ kind: "del", text: a[ai]!, aLnum: ai + 1 });
    for (; bi < y; bi++) ops.push({ kind: "add", text: b[bi]!, bLnum: bi + 1 });
    if (x < a.length) {
      ops.push({ kind: "context", text: a[x]!, aLnum: x + 1, bLnum: y + 1 });
      ai = x + 1;
      bi = y + 1;
    }
  }
  return ops;
}

/**
 * Edit distance above which the middle is reported as one del block followed
 * by one add block. Bounds time to O((N+M)·MAX_EDIT_DISTANCE) and trace memory
 * to O(MAX_EDIT_DISTANCE²), so wholesale-rewritten files can't stall the loop.
 */
export const MAX_EDIT_DISTANCE = 2000;
const MAX_EDIT_CELLS = 20_000_000;

/** Matched index pairs of a shortest edit script between `a` and `b`. */
function middleMatches(
  a: readonly string[],
  b: readonly string[],
): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const limit = Math.min(
    max,
    MAX_EDIT_DISTANCE,
    Math.floor(MAX_EDIT_CELLS / max),
  );
  // trace[d] holds V[-d..d] before round d (index k + d).
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= limit && !found; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) return [];
  // Backtrack.
  const out: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && vd[d + k - 1]! < vd[d + k + 1]!) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : vd[d + prevK]!;
    const prevY = prevX - prevK;
    const startX = d === 0 ? 0 : prevK === k + 1 ? prevX : prevX + 1;
    const startY = startX - k;
    while (x > startX && y > startY) {
      x--;
      y--;
      out.push([x, y]);
    }
    x = prevX;
    y = prevY;
    if (d === 0) break;
  }
  return out.reverse();
}
