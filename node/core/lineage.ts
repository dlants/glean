/**
 * Compose an ordered sequence of commit patches into per-line ownership for
 * the combined (base..target) view. Pure: the input is a first-parent
 * `git log -p -U0 -M` walk parsed by `diff.ts`.
 *
 * Each path is an ordered list of segments covering consecutive lines of the
 * file as it stands after the patches applied so far. The list ends with an
 * open-ended base segment, so the file's length is never needed and the
 * structure stays O(hunks) rather than O(lines).
 */
import type { FileEntry, Hunk } from "./diff.ts";
import type { Layer, PostLnum, PreLnum, RepoPath } from "./types.ts";

export type Origin =
  | { kind: "base"; base: number }
  | { kind: "commit"; sha: Layer; lnum: number };
/** `"open"` means "and the rest of the file". */
export type SegLen = number | "open";
export type Segment = Origin & { n: SegLen };

export type Attribution<L extends number> = { sha: Layer; lnum: L };
export type PathState = {
  segs: Segment[];
  /** base lnum → who removed it, and its number in that commit's pre-image. */
  delAttr: Map<number, Attribution<PreLnum>>;
};
export type States = Map<RepoPath, PathState>;
export type Patch = { sha: Layer; files: readonly FileEntry[] };

function originAt(s: Origin, off: number): Origin {
  return s.kind === "base"
    ? { kind: "base", base: s.base + off }
    : { kind: "commit", sha: s.sha, lnum: s.lnum + off };
}

function slice(s: Origin, off: number, n: SegLen): Segment {
  return { ...originAt(s, off), n };
}

const lenOf = (n: SegLen) => (n === "open" ? Infinity : n);

export function baseState(): Segment[] {
  return [{ kind: "base", base: 1, n: "open" }];
}

/**
 * Cut `removeN` lines at position `at` (1-based) out of `segments` and
 * substitute `seg`. Returns the new list and the displaced origins, in order.
 */
export function splice(
  segments: readonly Segment[],
  at: number,
  removeN: number,
  seg: Segment | undefined,
): { segs: Segment[]; displaced: Origin[] } {
  const res: Segment[] = [];
  const displaced: Origin[] = [];
  const cutEnd = at + removeN;
  let inserted = false;
  const push = (s: Segment) => {
    if (s.n === "open" || s.n > 0) res.push(s);
  };
  const insertSeg = () => {
    if (inserted) return;
    inserted = true;
    if (seg && lenOf(seg.n) > 0) res.push(seg);
  };

  let pos = 1;
  for (const s of segments) {
    const n = lenOf(s.n);
    const sEnd = pos + n;
    const headN = Math.min(n, Math.max(0, at - pos));
    if (headN > 0) push(slice(s, 0, headN));
    if (at <= sEnd) insertSeg();
    const midEnd = Math.min(sEnd, cutEnd);
    for (let k = Math.max(pos, at); k < midEnd; k++) {
      displaced.push(originAt(s, k - pos));
    }
    const tailStart = Math.max(pos, cutEnd);
    if (tailStart < sEnd) {
      push(
        slice(s, tailStart - pos, s.n === "open" ? "open" : sEnd - tailStart),
      );
    }
    if (s.n === "open") break;
    pos = sEnd;
  }
  insertSeg();
  return { segs: res, displaced };
}

/** Testing helper: origins of lines 1..n. */
export function expand(segments: readonly Segment[], n: number): Origin[] {
  const out: Origin[] = [];
  for (const s of segments) {
    const count = s.n === "open" ? n - out.length : s.n;
    for (let i = 0; i < count; i++) {
      if (out.length >= n) return out;
      out.push(originAt(s, i));
    }
  }
  return out;
}

type Block = { at: number; dels: number; adds: number; lnum: number };

/** A hunk's contiguous change blocks (one under -U0; context is tolerated). */
function blocksOf(hunk: Hunk): Block[] {
  const out: Block[] = [];
  // For a pure insertion git reports oldStart as the line the text goes
  // *after*, so the zero-width insert lands one later.
  let nextOld = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;
  let cur: Block | undefined;
  const flush = () => {
    if (cur) out.push(cur);
    cur = undefined;
  };
  for (const dl of hunk.lines) {
    if (dl.kind === "context") {
      flush();
      nextOld = dl.oldLnum + 1;
    } else if (dl.kind === "del") {
      if (cur && cur.adds > 0) flush();
      cur ??= { at: dl.oldLnum, dels: 0, adds: 0, lnum: 0 };
      cur.dels++;
      nextOld = dl.oldLnum + 1;
    } else {
      cur ??= { at: nextOld, dels: 0, adds: 0, lnum: 0 };
      if (cur.adds === 0) cur.lnum = dl.newLnum;
      cur.adds++;
    }
  }
  flush();
  return out;
}

/**
 * Apply one commit's FileEntry to one path's state. Hunk positions are in the
 * commit's pre-image, so a running offset maps them into the running image.
 */
export function apply(
  state: PathState,
  sha: Layer,
  file: FileEntry,
): PathState {
  let offset = 0;
  for (const hunk of file.hunks) {
    for (const b of blocksOf(hunk)) {
      const seg: Segment | undefined =
        b.adds > 0
          ? { kind: "commit", sha, lnum: b.lnum, n: b.adds }
          : undefined;
      const { segs, displaced } = splice(
        state.segs,
        b.at + offset,
        b.dels,
        seg,
      );
      state.segs = segs;
      displaced.forEach((origin, i) => {
        if (origin.kind === "base") {
          state.delAttr.set(origin.base, { sha, lnum: (b.at + i) as PreLnum });
        }
      });
      offset += b.adds - b.dels;
    }
  }
  return state;
}

/** Apply oldest-first `patches` on top of `states`, mutating and returning it. */
export function extend(states: States, patches: readonly Patch[]): States {
  for (const patch of patches) {
    for (const file of patch.files) {
      if (file.oldPath !== file.path && file.oldPath !== "/dev/null") {
        const prev = states.get(file.oldPath);
        if (prev) {
          states.set(file.path, prev);
          states.delete(file.oldPath);
        }
      }
      let st = states.get(file.path);
      if (!st) {
        st = {
          segs: file.kind === "add" ? [] : baseState(),
          delAttr: new Map(),
        };
        states.set(file.path, st);
      }
      apply(st, patch.sha, file);
      if (file.kind === "delete") {
        // A re-add starts from nothing: no origin survives the delete.
        states.set(file.path, { segs: [], delAttr: st.delAttr });
      }
    }
  }
  return states;
}

export function clone(states: States): States {
  const out: States = new Map();
  for (const [path, st] of states) {
    out.set(path, {
      segs: st.segs.map((s) => ({ ...s })),
      delAttr: new Map(st.delAttr),
    });
  }
  return out;
}

export type PathLineage = {
  /** Target-image line → the commit that wrote it, in its post-image. */
  prov: Map<number, Attribution<PostLnum>>;
  /**
   * Target-image line → the base-image line it was inherited from. A lazy
   * O(segments) lookup: the open tail must never be materialized.
   */
  base: (lnum: number) => number | undefined;
  delAttr: Map<number, Attribution<PreLnum>>;
};

function baseView(segs: readonly Segment[]): PathLineage["base"] {
  const ranges: { pos: number; n: SegLen; base: number }[] = [];
  let pos = 1;
  for (const s of segs) {
    if (s.kind === "base") ranges.push({ pos, n: s.n, base: s.base });
    if (s.n === "open") break;
    pos += s.n;
  }
  return (lnum) => {
    for (const r of ranges) {
      if (lnum >= r.pos && lnum < r.pos + lenOf(r.n))
        return r.base + lnum - r.pos;
    }
    return undefined;
  };
}

export function finish(states: States): Map<RepoPath, PathLineage> {
  const out = new Map<RepoPath, PathLineage>();
  for (const [path, st] of states) {
    const prov = new Map<number, Attribution<PostLnum>>();
    let pos = 1;
    for (const s of st.segs) {
      if (s.n === "open") break;
      if (s.kind === "commit") {
        for (let i = 0; i < s.n; i++) {
          prov.set(pos + i, { sha: s.sha, lnum: (s.lnum + i) as PostLnum });
        }
      }
      pos += s.n;
    }
    out.set(path, { prov, base: baseView(st.segs), delAttr: st.delAttr });
  }
  return out;
}

export function compose(patches: readonly Patch[]): Map<RepoPath, PathLineage> {
  return finish(extend(new Map(), patches));
}
