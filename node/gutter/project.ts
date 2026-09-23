/**
 * The review's state projected into the gutter of an ordinary file buffer.
 * Pure: a file's hunks plus a seen predicate become a post-image
 * `lnum -> mark` map. Nothing tracks positions; the whole map is recomputed
 * from the model on every event that can move it.
 */
import type { DiffLine, Hunk } from "../core/diff.ts";
import { pairLines } from "../core/intraline.ts";
import type { WorktreeLnum } from "../core/types.ts";

/** Coordinates within the file's hunk list (0-based), never line numbers. */
export type GutterSource = { hunk: number; li: number };

/**
 * `context` rows are connective tissue between changes inside a hunk: they
 * carry no sources and are always seen. `del` is a row that only carries
 * deletions.
 */
export type GutterKind = "add" | "change" | "del" | "context";
export type GutterMark = {
  kind: GutterKind;
  /** A deletion sits just below this row / above row 1. */
  delBelow: boolean;
  delAbove: boolean;
  seen: boolean;
  sources: GutterSource[];
};
/** 1-based post-image line -> mark. */
export type GutterMarks = Map<WorktreeLnum, GutterMark>;
/** The gutter projects a work-tree diff, so its post-image is the work tree. */
const wt = (n: number) => n as WorktreeLnum;
type FoldUpdate =
  | { kind: "add" | "change" }
  | { kind: "del-below" }
  | { kind: "del-above" };

type Entry = { dl: DiffLine; seen: boolean; src: GutterSource };

function fold(
  marks: GutterMarks,
  lnum: WorktreeLnum,
  entries: readonly Entry[],
  update: FoldUpdate,
) {
  let m = marks.get(lnum);
  if (!m) {
    m = {
      kind: "del",
      delBelow: false,
      delAbove: false,
      seen: true,
      sources: [],
    };
    marks.set(lnum, m);
  }
  for (const e of entries) {
    m.seen = m.seen && e.seen;
    m.sources.push(e.src);
  }
  if (update.kind === "del-below") m.delBelow = true;
  else if (update.kind === "del-above") m.delAbove = true;
  else m.kind = update.kind;
}

// An unpaired deletion attaches to the row above its slot, or row 1 (as
// `delAbove`) when removed from the top of the file.
function markDeletion(marks: GutterMarks, e: Entry) {
  const above = e.dl.newLnum - 1;
  if (above >= 1) fold(marks, wt(above), [e], { kind: "del-below" });
  else fold(marks, wt(1), [e], { kind: "del-above" });
}

// Coupling is `pairLines`, the same pairing the review buffer uses for
// intra-line emphasis, so "this looks like an edit" means one thing.
function projectBlock(
  marks: GutterMarks,
  dels: readonly Entry[],
  adds: readonly Entry[],
) {
  const paired = pairLines(
    dels.map((d) => d.dl.text),
    adds.map((a) => a.dl.text),
  );
  for (const p of paired.pairs) {
    const a = adds[p.ai];
    const d = dels[p.di];
    if (a && d) fold(marks, wt(a.dl.newLnum), [a, d], { kind: "change" });
  }
  for (const ai of paired.addUnpaired) {
    const a = adds[ai];
    if (a) fold(marks, wt(a.dl.newLnum), [a], { kind: "add" });
  }
  // Within a block that also adds lines, a deletion belongs to the edited
  // region and ticks its last post-image row.
  const last = adds.at(-1)?.dl.newLnum;
  const anchor = last === undefined ? undefined : wt(last);
  for (const di of paired.delUnpaired) {
    const d = dels[di];
    if (!d) continue;
    if (anchor !== undefined) fold(marks, anchor, [d], { kind: "del-below" });
    else markDeletion(marks, d);
  }
}

export function project(
  hunks: readonly Hunk[],
  isSeen: (dl: DiffLine, hunk: number, li: number) => boolean,
): GutterMarks {
  const marks: GutterMarks = new Map();
  hunks.forEach((hunk, hi) => {
    const lines = hunk.lines;
    let i = 0;
    while (i < lines.length) {
      if (lines[i]?.kind === "context") {
        i++;
        continue;
      }
      const dels: Entry[] = [];
      const adds: Entry[] = [];
      for (let cur = lines[i]; cur && cur.kind !== "context"; cur = lines[i]) {
        const e = {
          dl: cur,
          seen: isSeen(cur, hi, i),
          src: { hunk: hi, li: i },
        };
        (cur.kind === "del" ? dels : adds).push(e);
        i++;
      }
      projectBlock(marks, dels, adds);
    }
    const changed = lines.flatMap((dl, li) =>
      dl.kind === "context" ? [] : [li],
    );
    const lo = changed[0];
    const hi2 = changed.at(-1);
    if (lo === undefined || hi2 === undefined) return;
    for (let li = lo; li <= hi2; li++) {
      const dl = lines[li];
      if (dl?.kind === "context" && !marks.has(wt(dl.newLnum)))
        marks.set(wt(dl.newLnum), {
          kind: "context",
          delBelow: false,
          delAbove: false,
          seen: true,
          sources: [],
        });
    }
  });
  return marks;
}

type NavMark = Pick<GutterMark, "seen" | "sources">;

/**
 * The first row of each hunk, ascending. With `unseenOnly`, fully seen hunks
 * are dropped, falling back to every hunk when none is left unseen.
 */
export function hunkStarts(
  marks: ReadonlyMap<WorktreeLnum, NavMark>,
  unseenOnly = false,
): WorktreeLnum[] {
  const first = new Map<number, WorktreeLnum>();
  const unseen = new Set<number>();
  for (const [lnum, m] of marks) {
    for (const s of m.sources) {
      const f = first.get(s.hunk);
      if (f === undefined || lnum < f) first.set(s.hunk, lnum);
      if (!m.seen) unseen.add(s.hunk);
    }
  }
  const collect = (filter: boolean) =>
    [
      ...new Set(
        [...first].filter(([h]) => !filter || unseen.has(h)).map(([, l]) => l),
      ),
    ].sort((a, b) => a - b);
  const rows = collect(unseenOnly);
  return unseenOnly && rows.length === 0 ? collect(false) : rows;
}

/** The inclusive row range `gmc` acts on from `cur`: its hunks' rows. */
export function hunkRange(
  marks: ReadonlyMap<WorktreeLnum, NavMark>,
  cur: WorktreeLnum,
): { lo: WorktreeLnum; hi: WorktreeLnum } | undefined {
  const m = marks.get(cur);
  if (!m) return undefined;
  const want = new Set(m.sources.map((s) => s.hunk));
  let range: { lo: WorktreeLnum; hi: WorktreeLnum } | undefined;
  for (const [lnum, other] of marks) {
    if (!other.sources.some((s) => want.has(s.hunk))) continue;
    range = range
      ? {
          lo: lnum < range.lo ? lnum : range.lo,
          hi: lnum > range.hi ? lnum : range.hi,
        }
      : { lo: lnum, hi: lnum };
  }
  return range;
}

/** The row `]c` (dir 1) / `[c` (dir -1) lands on, wrapping. */
export function nextHunkRow(
  rows: readonly WorktreeLnum[],
  cur: WorktreeLnum,
  dir: 1 | -1,
): WorktreeLnum | undefined {
  if (dir > 0) return rows.find((r) => r > cur) ?? rows[0];
  return rows.findLast((r) => r < cur) ?? rows.at(-1);
}
