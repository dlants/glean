/**
 * In-memory recorders for the UI ports, so controller cores run in node tests.
 * They implement glean's own narrow interfaces, not a fake nvim.
 */
import type { BufNr, RepoPath, WorktreeLnum } from "../core/types.ts";
import type { UndoDepth } from "../gutter/bufUndo.ts";
import type { GutterSign, GutterUi } from "../gutter/fileGutter.ts";
import type { BufFacts, OverlayUi } from "../overlay/overlay.ts";
import type { BodyLine, QuickfixItem, Stamp } from "../overlay/project.ts";
import type { DiffContext } from "../render/nav.ts";
import type { Frame } from "../render/render.ts";
import { diskLine, type ResolvedJump } from "../view/jump.ts";
import type { NotifyLevel, ReviewUi } from "../view/review.ts";

export type Answer = string | number | undefined;

export function recordReviewUi() {
  const answers: Answer[] = [];
  const next = (): Answer => {
    if (answers.length === 0) throw new Error("recorder: no scripted answer");
    return answers.shift();
  };
  const rec = {
    frame: undefined as Frame | undefined,
    paints: 0,
    cursor: undefined as number | undefined,
    notes: [] as { msg: string; level: NotifyLevel }[],
    editors: [] as string[][],
    picks: [] as string[][],
    jumps: [] as { target: ResolvedJump; col: number }[],
    diffsplits: [] as { ctx: DiffContext; ignoreWhitespace: boolean }[],
    opened: [] as { path: RepoPath; lnum: WorktreeLnum }[],
    /** Queue the next editor text / pick index (`undefined`: dismissed). */
    answer(a: Answer) {
      answers.push(a);
    },
    /** The painted frame's text. */
    lines(): string[] {
      return rec.frame?.lines ?? [];
    },
  };
  const ui: ReviewUi = {
    async paint(frame) {
      rec.frame = frame;
      rec.paints++;
    },
    async setCursor(row) {
      rec.cursor = row;
    },
    async notify(msg, level) {
      rec.notes.push({ msg, level });
    },
    async editor(initial) {
      rec.editors.push(initial);
      const a = next();
      return typeof a === "string" ? a : undefined;
    },
    async pick(items) {
      rec.picks.push(items);
      const a = next();
      return typeof a === "number" ? a : undefined;
    },
    worktreeLine: diskLine,
    async openJump(target, col, isStale) {
      if (!isStale()) rec.jumps.push({ target, col });
    },
    async openDiffsplit(ctx, ignoreWhitespace, isStale) {
      if (!isStale()) rec.diffsplits.push({ ctx, ignoreWhitespace });
    },
    async openFileAt(path, lnum) {
      rec.opened.push({ path, lnum });
    },
  };
  return { ui, rec };
}

/** A file buffer the test edits directly (bump `seq` on each edit, as nvim would). */
export type RecBuffer = Omit<BufFacts, "buftype"> & {
  buftype?: string;
  lines: string[];
};
export function recordOverlayUi(buffers: Map<number, RecBuffer>, cwd: string) {
  const answers: Answer[] = [];
  const next = (): Answer => {
    if (answers.length === 0) throw new Error("recorder: no scripted answer");
    return answers.shift();
  };
  const rec = {
    stamps: new Map<number, Stamp[]>(),
    activated: [] as number[],
    parked: [] as { buf: number; lnum: number }[],
    floats: [] as BodyLine[][],
    quickfix: undefined as QuickfixItem[] | undefined,
    notes: [] as { msg: string; level: NotifyLevel }[],
    editors: [] as string[][],
    picks: [] as { items: string[]; title: string }[],
    errors: [] as unknown[],
    answer(a: Answer) {
      answers.push(a);
    },
  };
  const ui: OverlayUi = {
    async fileBuffers() {
      return [...buffers.keys()] as BufNr[];
    },
    async facts(buf) {
      const b = buffers.get(buf);
      return (
        b && {
          name: b.name,
          buftype: b.buftype ?? "",
          modified: b.modified,
          seq: b.seq,
        }
      );
    },
    async allLines(buf) {
      return buffers.get(buf)?.lines ?? [];
    },
    async range(buf, r) {
      return (buffers.get(buf)?.lines ?? []).slice(r.from - 1, r.to);
    },
    async cwd() {
      return cwd;
    },
    async stamp(buf, stamps) {
      rec.stamps.set(buf, stamps);
    },
    async activateUndo(buf) {
      rec.activated.push(buf);
    },
    async park(buf, lnum) {
      rec.parked.push({ buf, lnum });
    },
    async float(lines) {
      rec.floats.push(lines);
    },
    async quickfix(items) {
      rec.quickfix = items;
    },
    async notify(msg, level) {
      rec.notes.push({ msg, level });
    },
    async editor(initial) {
      rec.editors.push(initial);
      const a = next();
      return typeof a === "string" ? a : undefined;
    },
    async pick(items, title) {
      rec.picks.push({ items, title });
      const a = next();
      return typeof a === "number" ? a : undefined;
    },
    logError(err) {
      rec.errors.push(err);
    },
  };
  return { ui, rec };
}

export type GutterBuffer = {
  name: string;
  lines: string[];
  modified: boolean;
  seq: number;
  cursor?: WorktreeLnum;
  focus?: boolean;
};
export function recordGutterUi(buffers: Map<BufNr, GutterBuffer>) {
  const rec = {
    /** Current signs per buffer as "lnum:kind[+seen]" (stale: "lnum:stale"). */
    signs: new Map<BufNr, string>(),
    focus: new Map<BufNr, string>(),
    attached: new Set<BufNr>(),
    depth: new Map<BufNr, UndoDepth>(),
    parked: [] as { buf: BufNr; row: WorktreeLnum }[],
    notes: [] as { msg: string; level: NotifyLevel }[],
    errors: [] as unknown[],
  };
  const fmt = (signs: GutterSign[]) =>
    [...signs]
      .sort((a, b) => a.lnum - b.lnum)
      .map((s) => `${s.lnum}:${s.kind}${s.seen ? "+" : ""}`)
      .join(" ");
  const info = (buf: BufNr, b: GutterBuffer) => ({
    buf,
    name: b.name,
    modified: b.modified,
    lines: b.lines.length,
    cursor: b.cursor,
    focus: b.focus ?? true,
  });
  const ui: GutterUi = {
    async infos(bufs) {
      return [...buffers]
        .filter(([n]) => bufs === undefined || bufs.includes(n))
        .map(([buf, b]) => info(buf, b));
    },
    async seqInfo(buf) {
      const b = buffers.get(buf);
      return b && { ...info(buf, b), seq: b.seq };
    },
    async lines(buf) {
      return buffers.get(buf)?.lines ?? [];
    },
    async paint(paints) {
      for (const p of paints) {
        if (p.member === "attach") rec.attached.add(p.buf);
        if (p.member === "detach") rec.attached.delete(p.buf);
        const st = p.state;
        rec.signs.set(
          p.buf,
          st.kind === "stale"
            ? [...st.lnums]
                .sort((a, b) => a - b)
                .map((l) => `${l}:stale`)
                .join(" ")
            : st.kind === "live"
              ? fmt(st.signs)
              : "",
        );
        rec.focus.set(p.buf, st.kind === "live" ? fmt(st.focus) : "");
      }
    },
    async focus(buf, signs) {
      rec.focus.set(buf, fmt(signs));
    },
    async setUndoDepth(buf, depth) {
      rec.depth.set(buf, depth);
    },
    async park(buf, row) {
      rec.parked.push({ buf, row });
      const b = buffers.get(buf);
      if (b) b.cursor = Math.min(row, b.lines.length) as WorktreeLnum;
    },
    async notify(msg, level) {
      rec.notes.push({ msg, level });
    },
    logError(err) {
      rec.errors.push(err);
    },
  };
  return { ui, rec };
}
