/**
 * Projects a Session into a nomodifiable scratch buffer. Each frame is diffed
 * against the previous one (common prefix/suffix) and written in bounded
 * batches so nvim never handles one huge request; Lua only dispatches Actions.
 */

import { GenerationGuard, RefineCache, runRefine } from "../git/scheduler.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import {
  collapseTarget,
  nextUnseenHunk,
  planToggleSeen,
  planVisualMark,
  rowOfHunk,
  type SeenPlan,
} from "../render/actions.ts";
import { cursorAnchor, restoreAnchor } from "../render/anchor.ts";
import type { IntraBlock } from "../render/render.ts";
import { type Frame, render } from "../render/render.ts";
import type { Scope } from "../session/model.ts";
import type { Session } from "../session/session.ts";

export const MAX_BATCH_LINES = 500;
export const MAX_BATCH_CALLS = 1000;

/** Everything the Lua keymaps can send. Rows are 0-based. */
export type Action =
  | { kind: "toggle-seen"; row: number }
  | { kind: "visual-mark"; srow: number; erow: number }
  | { kind: "toggle-fold"; row: number }
  | { kind: "toggle-scope"; row: number }
  | { kind: "undo" }
  | { kind: "redo" };

export function parseAction(v: unknown): Action | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const num = (k: string) => (typeof o[k] === "number" ? o[k] : undefined);
  switch (o.kind) {
    case "toggle-seen":
    case "toggle-scope":
    case "toggle-fold": {
      const row = num("row");
      return row === undefined ? undefined : { kind: o.kind, row };
    }
    case "visual-mark": {
      const srow = num("srow");
      const erow = num("erow");
      return srow === undefined || erow === undefined
        ? undefined
        : { kind: "visual-mark", srow, erow };
    }
    case "undo":
    case "redo":
      return { kind: o.kind };
    default:
      return undefined;
  }
}

/** Minimal replacement turning `prev` into `next`. */
export function lineEdit(
  prev: readonly string[],
  next: readonly string[],
): { start: number; end: number; lines: string[] } | undefined {
  let s = 0;
  const max = Math.min(prev.length, next.length);
  while (s < max && prev[s] === next[s]) s++;
  let e = 0;
  while (e < max - s && prev[prev.length - 1 - e] === next[next.length - 1 - e])
    e++;
  if (s === prev.length && s === next.length) return undefined;
  return {
    start: s,
    end: prev.length - e,
    lines: next.slice(s, next.length - e),
  };
}

export type ViewOpts = { minSeenRun?: number; ignoreWhitespace?: boolean };
export class ReviewView {
  private shown: string[] = [];
  frame: Frame | undefined;
  scope: Scope = "combined";
  private ns = 0;
  private nsIntra = 0;
  private readonly intraGuard = new GenerationGuard();
  private readonly refineCache = new RefineCache();
  /** Resolves when the latest frame's intra-line refinement finishes or goes stale. */
  intraDone: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly nvim: Nvim,
    readonly bufnr: number,
    readonly session: Session,
    private readonly opts: ViewOpts = {},
  ) {
    session.onChange = () => {
      void this.redraw().catch((e: unknown) =>
        nvim.logger.error(e instanceof Error ? e : String(e)),
      );
    };
  }

  async init() {
    this.ns = await this.nvim.call("nvim_create_namespace", ["glean-review"]);
    this.nsIntra = await this.nvim.call("nvim_create_namespace", [
      "glean-review-intra",
    ]);
  }

  private build(): Frame | undefined {
    const snap = this.session.current;
    if (!snap) return undefined;
    return render({
      scope: this.scope,
      cls: snap.cls,
      collapse: this.session.collapse,
      isSticky: (p, t) => snap.store.isSticky(p, t),
      minSeenRun: this.opts.minSeenRun ?? 5,
      ignoreWhitespace: this.opts.ignoreWhitespace ?? false,
      comments: this.session.commentsHook(),
    });
  }

  private drawChain: Promise<unknown> = Promise.resolve();
  /** Serialized: `lineEdit` diffs against `shown`, so overlapping draws (a poll
   * refresh racing an action) would apply edits computed against a stale frame. */
  redraw(): Promise<void> {
    const next = this.drawChain.then(() => this.draw());
    this.drawChain = next.catch(() => undefined);
    return next;
  }
  private async draw() {
    const frame = this.build();
    if (!frame) return;
    const gen = this.intraGuard.bump();
    this.frame = frame;
    const edit = lineEdit(this.shown, frame.lines);
    const b = this.bufnr;
    await this.nvim.call("nvim_set_option_value", [
      "modifiable",
      true,
      { buf: b },
    ]);
    if (edit) {
      // Replace the old span with the first batch, then append the rest.
      let at = edit.start;
      let end = edit.end;
      let i = 0;
      do {
        const chunk = edit.lines.slice(i, i + MAX_BATCH_LINES);
        await this.nvim.call("nvim_buf_set_lines", [b, at, end, false, chunk]);
        at += chunk.length;
        end = at;
        i += MAX_BATCH_LINES;
      } while (i < edit.lines.length);
    }
    await this.nvim.call("nvim_set_option_value", [
      "modifiable",
      false,
      { buf: b },
    ]);
    this.shown = frame.lines;
    await this.nvim.call("nvim_buf_clear_namespace", [b, this.ns, 0, -1]);
    const calls: unknown[] = [];
    for (const h of frame.highlights) {
      calls.push(
        h.kind === "line"
          ? [
              "nvim_buf_set_extmark",
              [b, this.ns, h.row, 0, { line_hl_group: h.hl }],
            ]
          : [
              "nvim_buf_set_extmark",
              [
                b,
                this.ns,
                h.row,
                h.startCol,
                { end_col: h.endCol, hl_group: h.hl },
              ],
            ],
      );
    }
    for (let i = 0; i < calls.length; i += MAX_BATCH_CALLS)
      await this.nvim.call("nvim_call_atomic", [
        calls.slice(i, i + MAX_BATCH_CALLS),
      ]);
    if (!this.intraGuard.isCurrent(gen)) return;
    await this.nvim.call("nvim_buf_clear_namespace", [b, this.nsIntra, 0, -1]);
    this.intraDone = runRefine(
      this.intraGuard,
      gen,
      frame.intraBlocks.map((blk) => ({
        blk,
        dels: blk.dels.map((d) => d.text),
        adds: blk.adds.map((a) => a.text),
      })),
      ({ blk }, refined) => {
        const out: unknown[] = [];
        for (const r of refined) {
          const d = blk.dels[r.di];
          const a = blk.adds[r.ai];
          if (!d || !a) continue;
          this.intraCalls(out, d, r.aSegs, "GleanDelText", "GleanDelEmph");
          this.intraCalls(out, a, r.bSegs, "GleanAddText", "GleanAddEmph");
        }
        this.pending = this.pending.then(async () => {
          if (!this.intraGuard.isCurrent(gen)) return;
          for (let i = 0; i < out.length; i += MAX_BATCH_CALLS)
            await this.nvim.call("nvim_call_atomic", [
              out.slice(i, i + MAX_BATCH_CALLS),
            ]);
        });
      },
      this.refineCache,
    ).then(() => this.pending);
  }
  private pending: Promise<void> = Promise.resolve();
  /**
   * A refined pair drops its full-line background to a foreground-only colour
   * (a higher-priority line highlight) so the changed spans carry the diff
   * background.
   */
  private intraCalls(
    out: unknown[],
    line: IntraBlock["dels"][number],
    segs: readonly { startCol: number; endCol: number }[],
    textHl: string,
    emphHl: string,
  ) {
    const b = this.bufnr;
    const len = Buffer.byteLength(line.text);
    out.push([
      "nvim_buf_set_extmark",
      [b, this.nsIntra, line.row, 0, { line_hl_group: textHl, priority: 4100 }],
    ]);
    for (const s of segs) {
      const e = Math.min(s.endCol, len);
      if (e > s.startCol)
        out.push([
          "nvim_buf_set_extmark",
          [
            b,
            this.nsIntra,
            line.row,
            s.startCol,
            { end_col: e, hl_group: emphHl, priority: 4200 },
          ],
        ]);
    }
  }

  private async setCursor(row: number) {
    const win = await this.nvim.call("nvim_call_function", [
      "bufwinid",
      [this.bufnr],
    ]);
    if (typeof win === "number" && win > 0)
      await this.nvim.call("nvim_win_set_cursor", [win, [row + 1, 0]]);
  }
  /** After marking, land on the next unseen hunk below the cursor, as Lua does. */
  private async markAndAdvance(plan: SeenPlan, row: number) {
    const before = this.frame;
    const next =
      plan.op === "mark" && before ? nextUnseenHunk(before, row) : undefined;
    await this.session.perform({ kind: "seen", plan, cursor: row });
    await this.redraw();
    const frame = this.frame;
    if (!frame || frame.rows.length === 0) return;
    const dest = next === undefined ? undefined : rowOfHunk(frame, next);
    await this.setCursor(dest ?? Math.min(row, frame.rows.length - 1));
  }
  async dispatch(a: Action) {
    const snap = this.session.current;
    const frame = this.frame;
    if (!snap || !frame) return;
    switch (a.kind) {
      case "toggle-seen": {
        const t = frame.rows[a.row];
        const plan = t && planToggleSeen(snap.cls, this.scope, t);
        if (plan) await this.markAndAdvance(plan, a.row);
        return;
      }
      case "visual-mark": {
        const plan = planVisualMark(
          snap.cls,
          this.scope,
          frame.rows,
          a.srow,
          a.erow,
        );
        if (plan) await this.markAndAdvance(plan, a.srow);
        return;
      }
      case "toggle-fold": {
        const t = frame.rows[a.row];
        const c = t && collapseTarget(snap.cls, this.session.collapse, t);
        if (!c) return;
        await this.session.perform({
          kind: "collapse",
          key: c.key,
          value: !c.collapsed,
          prev: this.session.collapse.get(c.key),
          cursor: a.row,
        });
        await this.redraw();
        return;
      }
      case "toggle-scope": {
        const anchor = cursorAnchor(snap.cls, frame.rows[a.row]);
        this.scope = this.scope === "combined" ? "commits" : "combined";
        await this.redraw();
        const next = this.frame;
        const row = anchor && next && restoreAnchor(snap.cls, next, anchor);
        if (row !== undefined) await this.setCursor(row);
        return;
      }
      case "undo":
      case "redo": {
        const r = await (a.kind === "undo"
          ? this.session.undo()
          : this.session.redo());
        if (!r) return;
        await this.redraw();
        const n = this.frame?.rows.length ?? 0;
        if (r.cursor !== undefined && n > 0)
          await this.setCursor(Math.min(r.cursor, n - 1));
        return;
      }
    }
  }
}
