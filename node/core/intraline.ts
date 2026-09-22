/**
 * Pure intra-line (word-level) diff helpers: tokenizer, affine-gap token
 * alignment, and order-preserving del/add line pairing.
 *
 * All work here is superlinear, so every entry point is capped (see the caps
 * below): a pathological block degrades to fewer highlights, never to an
 * unbounded computation.
 */

/** Byte-offset token (`col` 0-based, UTF-8 bytes, as nvim extmarks expect). */
export type Token = { text: string; col: number; len: number };
/** Byte range of changed tokens, `endCol` exclusive. */
export type Segment = { startCol: number; endCol: number };
export type Alignment = { aSegs: Segment[]; bSegs: Segment[] };

const WORD = /[A-Za-z0-9_]/;

/**
 * A maximal run of [A-Za-z0-9_] is one token; every other code point is its own
 * token.
 */
export function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  let col = 0;
  let i = 0;
  while (i < s.length) {
    if (WORD.test(s[i]!)) {
      const start = i;
      while (i < s.length && WORD.test(s[i]!)) i++;
      const text = s.slice(start, i);
      tokens.push({ text, col, len: text.length });
      col += text.length;
    } else {
      const cp = s.codePointAt(i)!;
      const text = String.fromCodePoint(cp);
      const len = Buffer.byteLength(text);
      tokens.push({ text, col, len });
      col += len;
      i += text.length;
    }
  }
  return tokens;
}

// GAP_OPEN > GAP_EXTEND keeps highlight segments blocky. Unequal tokens never
// align on the diagonal, so a substitution is a gap on each side.
const GAP_OPEN = 3;
const GAP_EXTEND = 1;
/** Alignments costing more than this × the longer token count are abandoned. */
const COST_FACTOR = 2;
/** Token-product cap for one `align`: bigger pairs are treated as unalignable. */
export const MAX_TOKEN_PRODUCT = 40_000;
/** Scored-cell cap for one `pairLines`: bigger blocks use a banded greedy pass. */
export const MAX_PAIR_CELLS = 40_000;
const PAIR_THRESHOLD = 0.5;
const GOOD_ENOUGH = 0.8;

function mergeSegments(tokens: readonly Token[], changed: number[]): Segment[] {
  const segs: Segment[] = [];
  let i = 0;
  while (i < changed.length) {
    let j = i;
    while (j + 1 < changed.length && changed[j + 1] === changed[j]! + 1) j++;
    const first = tokens[changed[i]!]!;
    const last = tokens[changed[j]!]!;
    segs.push({ startCol: first.col, endCol: last.col + last.len });
    i = j + 1;
  }
  return segs;
}

/**
 * Align two lines' token sequences (Gotoh affine-gap DP). Undefined when the
 * lines are too different or too large to align.
 */
export function align(a: string, b: string): Alignment | undefined {
  return alignTokens(tokenize(a), tokenize(b));
}

function alignTokens(
  ta: readonly Token[],
  tb: readonly Token[],
): Alignment | undefined {
  const m = ta.length;
  const n = tb.length;
  if (m * n > MAX_TOKEN_PRODUCT) return undefined;
  const maxCost = Math.max(m, n) * COST_FACTOR;
  const W = n + 1;
  const size = (m + 1) * W;
  const Mm = new Float64Array(size).fill(Infinity);
  const Ga = new Float64Array(size).fill(Infinity);
  const Gb = new Float64Array(size).fill(Infinity);
  Mm[0] = 0;
  for (let j = 1; j <= n; j++) Ga[j] = GAP_OPEN + (j - 1) * GAP_EXTEND;
  for (let i = 1; i <= m; i++) Gb[i * W] = GAP_OPEN + (i - 1) * GAP_EXTEND;

  for (let i = 1; i <= m; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= n; j++) {
      const c = i * W + j;
      const d = c - W - 1;
      Mm[c] =
        ta[i - 1]!.text === tb[j - 1]!.text
          ? Math.min(Mm[d]!, Ga[d]!, Gb[d]!)
          : Infinity;
      Ga[c] = Math.min(
        Math.min(Mm[c - 1]!, Gb[c - 1]!) + GAP_OPEN,
        Ga[c - 1]! + GAP_EXTEND,
      );
      Gb[c] = Math.min(
        Math.min(Mm[c - W]!, Ga[c - W]!) + GAP_OPEN,
        Gb[c - W]! + GAP_EXTEND,
      );
      rowMin = Math.min(rowMin, Mm[c]!, Ga[c]!, Gb[c]!);
    }
    if (n > 0 && rowMin > maxCost) return undefined;
  }

  const end = m * W + n;
  const final = Math.min(Mm[end]!, Ga[end]!, Gb[end]!);
  if (final === Infinity || final > maxCost) return undefined;

  const aChanged: number[] = [];
  const bChanged: number[] = [];
  let i = m;
  let j = n;
  let state: "M" | "Ga" | "Gb" =
    Mm[end]! <= Ga[end]! && Mm[end]! <= Gb[end]!
      ? "M"
      : Ga[end]! <= Gb[end]!
        ? "Ga"
        : "Gb";
  while (i > 0 || j > 0) {
    const c = i * W + j;
    if (state === "M") {
      const prev = Mm[c]!;
      i--;
      j--;
      const p = i * W + j;
      state = Mm[p] === prev ? "M" : Ga[p] === prev ? "Ga" : "Gb";
    } else if (state === "Ga") {
      bChanged.push(j - 1);
      state =
        Ga[c - 1]! + GAP_EXTEND === Ga[c]
          ? "Ga"
          : Mm[c - 1]! + GAP_OPEN === Ga[c]
            ? "M"
            : "Gb";
      j--;
    } else {
      aChanged.push(i - 1);
      state =
        Gb[c - W]! + GAP_EXTEND === Gb[c]
          ? "Gb"
          : Mm[c - W]! + GAP_OPEN === Gb[c]
            ? "M"
            : "Ga";
      i--;
    }
  }
  return {
    aSegs: mergeSegments(ta, aChanged.reverse()),
    bSegs: mergeSegments(tb, bChanged.reverse()),
  };
}

type Prepared = { tokens: Token[]; bytes: number; bag: Map<string, number> };

function prepare(text: string): Prepared {
  const tokens = tokenize(text);
  const bag = new Map<string, number>();
  for (const t of tokens) bag.set(t.text, (bag.get(t.text) ?? 0) + 1);
  return { tokens, bytes: Buffer.byteLength(text), bag };
}

/** Bytes of `a`'s tokens that can't match anything in `b` (multiset). */
function unmatchedBytes(a: Prepared, b: Prepared): number {
  const left = new Map<string, number>();
  let bytes = 0;
  for (const t of a.tokens) {
    const used = left.get(t.text) ?? 0;
    if (used < (b.bag.get(t.text) ?? 0)) left.set(t.text, used + 1);
    else bytes += t.len;
  }
  return bytes;
}

/**
 * Shared per-block limit on DP cells, so a block's total alignment work is
 * bounded regardless of how many pairs get scored.
 */
export const MAX_BLOCK_ALIGN_CELLS = 4_000_000;
type Budget = { cells: number };

/**
 * Fraction of bytes left unchanged by the alignment, in [0, 1]; undefined when
 * the lines can't pair (or the budget is spent).
 */
function similarity(
  a: Prepared,
  b: Prepared,
  budget: Budget,
): number | undefined {
  const total = a.bytes + b.bytes;
  if (total === 0) return 1;
  // Both bounds are exact upper bounds on the similarity: at least |la - lb|
  // bytes change, and so does every token with no counterpart on the other side.
  if ((2 * Math.min(a.bytes, b.bytes)) / total <= PAIR_THRESHOLD)
    return undefined;
  const floor = unmatchedBytes(a, b) + unmatchedBytes(b, a);
  if (1 - floor / total <= PAIR_THRESHOLD) return undefined;
  const cells = a.tokens.length * b.tokens.length;
  if (cells > budget.cells) return undefined;
  budget.cells -= cells;
  const r = alignTokens(a.tokens, b.tokens);
  if (!r) return undefined;
  let changed = 0;
  for (const s of r.aSegs) changed += s.endCol - s.startCol;
  for (const s of r.bSegs) changed += s.endCol - s.startCol;
  return 1 - changed / total;
}

/** 0-based indices into the del / add lists. */
export type LinePair = { di: number; ai: number };
export type Pairing = {
  pairs: LinePair[];
  delUnpaired: number[];
  addUnpaired: number[];
};

function finishPairing(m: number, n: number, pairs: LinePair[]): Pairing {
  const dels = new Set(pairs.map((p) => p.di));
  const adds = new Set(pairs.map((p) => p.ai));
  const range = (k: number) => Array.from({ length: k }, (_, x) => x);
  return {
    pairs,
    delUnpaired: range(m).filter((x) => !dels.has(x)),
    addUnpaired: range(n).filter((x) => !adds.has(x)),
  };
}

/**
 * Past MAX_PAIR_CELLS, each del only looks at a bounded window of adds after
 * the previous pair and takes the best one clearing the threshold, stopping at
 * the first GOOD_ENOUGH match. Still order-preserving, O(m · window).
 */
function pairBanded(
  dels: readonly Prepared[],
  adds: readonly Prepared[],
  budget: Budget,
): Pairing {
  const window = Math.max(1, Math.floor(MAX_PAIR_CELLS / dels.length));
  const pairs: LinePair[] = [];
  let next = 0;
  for (let di = 0; di < dels.length && next < adds.length; di++) {
    let best: { ai: number; sim: number } | undefined;
    const stop = Math.min(adds.length, next + window);
    for (let ai = next; ai < stop; ai++) {
      const s = similarity(dels[di]!, adds[ai]!, budget);
      if (s !== undefined && s > PAIR_THRESHOLD && (!best || s > best.sim)) {
        best = { ai, sim: s };
        if (s >= GOOD_ENOUGH) break;
      }
    }
    if (best) {
      pairs.push({ di, ai: best.ai });
      next = best.ai + 1;
    }
  }
  return finishPairing(dels.length, adds.length, pairs);
}

/**
 * Couple deleted lines with added lines by similarity, order-preserving
 * (Needleman-Wunsch over whole lines maximizing Σ(sim − threshold)).
 */
export function pairLines(
  dels: readonly string[],
  adds: readonly string[],
): Pairing {
  const m = dels.length;
  const n = adds.length;
  const budget: Budget = { cells: MAX_BLOCK_ALIGN_CELLS };
  const pd = dels.map(prepare);
  const pa = adds.map(prepare);
  if (m * n > MAX_PAIR_CELLS) return pairBanded(pd, pa, budget);
  const W = n + 1;
  const sim: (number | undefined)[] = new Array(m * n);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++)
      sim[i * n + j] = similarity(pd[i]!, pa[j]!, budget);
  }
  const dp = new Float64Array((m + 1) * W);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      let best = Math.max(dp[(i - 1) * W + j]!, dp[i * W + j - 1]!);
      const s = sim[(i - 1) * n + j - 1];
      if (s !== undefined) {
        const diag = dp[(i - 1) * W + j - 1]! + (s - PAIR_THRESHOLD);
        if (diag > best) best = diag;
      }
      dp[i * W + j] = best;
    }
  }
  const pairs: LinePair[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    const s = sim[(i - 1) * n + j - 1];
    if (
      s !== undefined &&
      s - PAIR_THRESHOLD >= 0 &&
      dp[i * W + j] === dp[(i - 1) * W + j - 1]! + (s - PAIR_THRESHOLD)
    ) {
      pairs.push({ di: i - 1, ai: j - 1 });
      i--;
      j--;
    } else if (dp[(i - 1) * W + j]! >= dp[i * W + j - 1]!) {
      i--;
    } else {
      j--;
    }
  }
  return finishPairing(m, n, pairs.reverse());
}

export type RowText<Row> = { row: Row; text: string };
export type PairWork<Row> = {
  delRow: Row;
  addRow: Row;
  delText: string;
  addText: string;
};

/** `pairLines` over row-tagged lines; unpaired surplus yields no item. */
export function buildPairs<Row>(
  dels: readonly RowText<Row>[],
  adds: readonly RowText<Row>[],
): PairWork<Row>[] {
  const { pairs } = pairLines(
    dels.map((d) => d.text),
    adds.map((a) => a.text),
  );
  return pairs.map(({ di, ai }) => {
    const d = dels[di]!;
    const a = adds[ai]!;
    return { delRow: d.row, addRow: a.row, delText: d.text, addText: a.text };
  });
}

export type Refinement = LinePair & Alignment;

/** Row-free, content-addressable pairing + per-pair segments for one block. */
export function refine(
  dels: readonly string[],
  adds: readonly string[],
): Refinement[] {
  const out: Refinement[] = [];
  for (const p of pairLines(dels, adds).pairs) {
    const r = align(dels[p.di]!, adds[p.ai]!);
    if (r) out.push({ ...p, ...r });
  }
  return out;
}
