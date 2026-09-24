/**
 * In-memory recorders for the UI ports, so controller cores run in node tests.
 * They implement glean's own narrow interfaces, not a fake nvim.
 */
import type { BufNr, RepoPath, WorktreeLnum } from "../core/types.ts";
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
