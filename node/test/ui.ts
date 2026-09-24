/**
 * In-memory recorders for the UI ports, so controller cores run in node tests.
 * They implement glean's own narrow interfaces, not a fake nvim.
 */
import type { RepoPath, WorktreeLnum } from "../core/types.ts";
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
