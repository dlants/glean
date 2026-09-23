/**
 * Projects a Session into a nomodifiable scratch buffer. Each frame is diffed
 * against the previous one (common prefix/suffix) and written in bounded
 * batches so nvim never handles one huge request; Lua only dispatches Actions.
 */

import { join } from "node:path";
import type { Layer, LineId, PostLnum, RepoPath } from "../core/types.ts";
import { GenerationGuard, RefineCache, runRefine } from "../git/scheduler.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import {
  collapseTarget,
  nextUnseenHunk,
  planToggleSeen,
  planVisualMark,
  resolveFile,
  rowOfHunk,
  type SeenPlan,
} from "../render/actions.ts";
import { cursorAnchor, restoreAnchor } from "../render/anchor.ts";
import type { SummaryGroup } from "../render/comments.ts";
import {
  diffContext,
  fileHeaderRow,
  hunkRange,
  jumpTarget,
  type NavUnit,
  navRow,
  sourceLineRow,
} from "../render/nav.ts";
import type { IntraBlock } from "../render/render.ts";
import {
  type CollapseKey,
  type Frame,
  keys,
  render,
} from "../render/render.ts";
import type { Scope } from "../session/model.ts";
import type { Session } from "../session/session.ts";
import { openDiffsplit, openJump } from "./jump.ts";

/** Collapse keys hiding `path`'s lines in `scope`, so navigation can reach them. */
function revealKeys(
  scope: Scope,
  path: RepoPath,
  sha: Layer | undefined,
): CollapseKey[] {
  const parts = path.split("/");
  const prefixes = parts
    .slice(1)
    .map((_, i) => parts.slice(0, i + 1).join("/"));
  if (scope === "combined")
    return [keys.cfile(path), keys.cseen(path), ...prefixes.map(keys.cdir)];
  if (sha === undefined) return [];
  return [
    keys.commit(sha),
    keys.file(sha, path),
    keys.seen(sha, path),
    ...prefixes.map((p) => keys.dir(sha, p)),
  ];
}

function ownerSha(id: LineId | undefined): Layer | undefined {
  if (id?.kind === "committed-add") return id.sha;
  if (id?.kind === "committed-del") return id.removerSha;
  return undefined;
}

export const MAX_BATCH_LINES = 500;
export const MAX_BATCH_CALLS = 1000;

/** Everything the Lua keymaps can send. Rows are 0-based. */
export type Action =
  | { kind: "toggle-seen"; row: number }
  | { kind: "visual-mark"; srow: number; erow: number }
  | { kind: "toggle-fold"; row: number }
  | { kind: "toggle-scope"; row: number }
  | { kind: "jump"; row: number; col: number }
  | { kind: "diffsplit"; row: number }
  | { kind: "delete-comments"; srow: number; erow: number }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "visibility"; visible: boolean }
  /** The review buffer was wiped; handled by the registry, not the view. */
  | { kind: "gone" };

export function parseAction(v: unknown): Action | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const num = (k: string) => (typeof o[k] === "number" ? o[k] : undefined);
  switch (o.kind) {
    case "toggle-seen":
    case "toggle-scope":
    case "toggle-fold":
    case "diffsplit": {
      const row = num("row");
      return row === undefined ? undefined : { kind: o.kind, row };
    }
    case "visual-mark":
    case "delete-comments": {
      const srow = num("srow");
      const erow = num("erow");
      return srow === undefined || erow === undefined
        ? undefined
        : { kind: o.kind, srow, erow };
    }
    case "jump": {
      const row = num("row");
      const col = num("col");
      return row === undefined || col === undefined
        ? undefined
        : { kind: "jump", row, col };
    }
    case "visibility":
      return typeof o.visible === "boolean"
        ? { kind: "visibility", visible: o.visible }
        : undefined;
    case "undo":
    case "redo":
    case "gone":
      return { kind: o.kind };
    default:
      return undefined;
  }
}

export type Query =
  | { kind: "hunk-range"; row: number }
  | { kind: "nav"; row: number; unit: NavUnit; forward: boolean };
export function parseQuery(v: unknown): Query | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.row !== "number") return undefined;
  if (o.kind === "hunk-range") return { kind: "hunk-range", row: o.row };
  if (
    o.kind === "nav" &&
    (o.unit === "hunk" || o.unit === "file") &&
    typeof o.forward === "boolean"
  )
    return { kind: "nav", row: o.row, unit: o.unit, forward: o.forward };
  return undefined;
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

/** Per-row identity for diffing frames: the text plus that row's highlights. */
export function frameRowKeys(frame: Frame): string[] {
  const hl = frame.lines.map(() => "");
  for (const h of frame.highlights)
    hl[h.row] +=
      h.kind === "line" ? `|l:${h.hl}` : `|s:${h.hl}:${h.startCol}:${h.endCol}`;
  return frame.lines.map((l, i) => `${l}\u0000${hl[i]}`);
}

export type ViewOpts = { minSeenRun?: number; ignoreWhitespace?: boolean };
export class ReviewView {
  private shown: string[] = [];
  frame: Frame | undefined;
  scope: Scope = "combined";
  private ns = 0;
  private nsIntra = 0;
  private readonly intraGuard = new GenerationGuard();
  /** Latest `<CR>`/`D`/`:Glean jump`; an older one never moves windows or the cursor. */
  private readonly jumpGuard = new GenerationGuard();
  private staleCheck() {
    const gen = this.jumpGuard.bump();
    return () => !this.jumpGuard.isCurrent(gen);
  }
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
      // Hidden: the model keeps refreshing (gutter/file-buffer paths read it),
      // only the buffer paint waits for `resume`.
      if (this.suspended) return;
      void this.redraw().catch((e: unknown) =>
        nvim.logger.error(e instanceof Error ? e : String(e)),
      );
    };
  }

  suspended = false;
  suspend() {
    this.suspended = true;
    this.intraGuard.bump();
  }
  async resume() {
    if (!this.suspended) return;
    this.suspended = false;
    await this.redraw();
    await this.session.pokePoll();
  }
  async init() {
    this.ns = await this.nvim.call("nvim_create_namespace", ["glean-review"]);
    this.nsIntra = await this.nvim.call("nvim_create_namespace", [
      "glean-review-intra",
    ]);
  }

  private build(summary: readonly SummaryGroup[]): Frame | undefined {
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
      summary,
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
    const summary = await this.session.commentSummary();
    this.summary = summary;
    const frame = this.build(summary);
    if (!frame) return;
    const gen = this.intraGuard.bump();
    this.frame = frame;
    // Diff on text plus that row's highlights: extmarks outside the edited
    // span ride along with their unchanged lines, so only the span is repainted.
    const rowKeys = frameRowKeys(frame);
    const edit = lineEdit(this.shown, rowKeys);
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
      const lines = frame.lines.slice(
        edit.start,
        edit.start + edit.lines.length,
      );
      do {
        const chunk = lines.slice(i, i + MAX_BATCH_LINES);
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
    this.shown = rowKeys;
    const calls: unknown[] = [];
    const lo = edit?.start ?? 0;
    const hi = edit ? edit.start + edit.lines.length : 0;
    if (edit)
      await this.nvim.call("nvim_buf_clear_namespace", [b, this.ns, lo, hi]);
    for (const h of frame.highlights) {
      if (h.row < lo || h.row >= hi) continue;
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

  private summary: readonly SummaryGroup[] = [];
  /** The window showing the review (-1 when hidden). */
  private async win(): Promise<number> {
    const w = await this.nvim.call("nvim_call_function", [
      "bufwinid",
      [this.bufnr],
    ]);
    return typeof w === "number" ? w : -1;
  }
  /**
   * Synchronous lookups the keymaps need before returning (`gleanQuery`).
   * Must stay free of awaits (git, redraw): nvim is blocked until it replies.
   */
  query(q: Query): [number, number] | undefined {
    const frame = this.frame;
    if (!frame) return undefined;
    if (q.kind === "hunk-range") {
      const r = hunkRange(frame, q.row);
      return r && [r.lo, r.hi];
    }
    const row = navRow(frame, q.row, q.unit, q.forward);
    if (row === undefined) return undefined;
    return [row, q.unit === "hunk" ? (hunkRange(frame, row)?.hi ?? row) : row];
  }
  /** Expand every collapse hiding `path`'s lines (file, seen section, dirs, markers). */
  private async revealPath(path: RepoPath) {
    const snap = this.session.current;
    if (!snap) return;
    const shas =
      this.scope === "combined"
        ? [undefined]
        : snap.model.commits
            .filter((c) => c.files.some((f) => f.path === path))
            .map((c) => c.sha);
    this.session.expand(shas.flatMap((s) => revealKeys(this.scope, path, s)));
    await this.redraw();
    const markers = (this.frame?.rows ?? []).flatMap((t) =>
      t.kind === "marker" &&
      resolveFile(snap.cls, t.file)?.file.path === path &&
      this.session.collapse.get(keys.marker(t.key)) !== false
        ? [keys.marker(t.key)]
        : [],
    );
    if (markers.length === 0) return;
    this.session.expand(markers);
    await this.redraw();
  }
  /**
   * `:Glean jump`: park on the row showing `path`:`lnum`, expanding whatever
   * hides it. Undefined when the file is not part of the review.
   */
  async gotoSource(
    path: RepoPath,
    lnum: PostLnum,
  ): Promise<number | undefined> {
    const snap = this.session.current;
    if (!snap) return undefined;
    const inReview =
      snap.model.files.some((f) => f.path === path) ||
      snap.model.commits.some((c) => c.files.some((f) => f.path === path));
    if (!inReview) return undefined;
    const isStale = this.staleCheck();
    await this.revealPath(path);
    if (isStale()) return undefined;
    const cls = this.session.current?.cls ?? snap.cls;
    const row = this.frame && sourceLineRow(cls, this.frame, path, lnum);
    if (row !== undefined) await this.setCursor(row);
    return row;
  }
  /** `<CR>`: summary rows navigate within the review, diff rows open the source. */
  private async jump(row: number, col: number) {
    const isStale = this.staleCheck();
    const snap = this.session.current;
    const frame = this.frame;
    if (!snap || !frame) return;
    const t = frame.rows[row];
    if (t?.kind === "summary-file") {
      const r = fileHeaderRow(snap.cls, frame, t.path);
      if (r !== undefined) await this.setCursor(r);
      return;
    }
    if (t?.kind === "summary-comment") {
      const entry = this.summary
        .find((g) => g.path === t.path)
        ?.entries.find((e) => e.record.id === t.commentId);
      // An off-diff comment has no review row: open the file at its line.
      if (entry?.state === "file" && entry.fileLnum !== undefined) {
        const win = await this.win();
        if (isStale()) return;
        await this.nvim.call("nvim_exec_lua", [
          `return require("glean.node").open_file_at(...)`,
          [win, join(this.session.repoRoot, t.path), entry.fileLnum, 0],
        ]);
        return;
      }
      await this.revealComment(t.path, t.commentId, isStale);
      return;
    }
    const jt = jumpTarget(snap.cls, t, this.session.range);
    if (jt)
      await openJump(
        this.nvim,
        this.session.git,
        await this.win(),
        jt,
        col,
        isStale,
      );
  }
  private async revealComment(
    path: RepoPath,
    commentId: number,
    isStale: () => boolean,
  ) {
    const find = () => {
      const cls = this.session.current?.cls;
      const rows = this.frame?.rows ?? [];
      return rows.findIndex(
        (r) =>
          r.kind === "comment" &&
          r.commentId === commentId &&
          cls !== undefined &&
          resolveFile(cls, r.file)?.file.path === path,
      );
    };
    let row = find();
    if (row < 0) {
      await this.revealPath(path);
      row = find();
    }
    if (row < 0) {
      const cls = this.session.current?.cls;
      const header = cls && this.frame && fileHeaderRow(cls, this.frame, path);
      if (header !== undefined) row = header;
    }
    if (row >= 0 && !isStale()) await this.setCursor(row);
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
    if (a.kind === "visibility") {
      if (a.visible) await this.resume();
      else this.suspend();
      return;
    }
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
        if (anchor?.kind === "line")
          this.session.expand(
            revealKeys(
              this.scope,
              anchor.path,
              anchor.sha ?? ownerSha(anchor.id),
            ),
          );
        await this.redraw();
        const next = this.frame;
        const cls = this.session.current?.cls ?? snap.cls;
        const row = anchor && next && restoreAnchor(cls, next, anchor);
        if (row !== undefined) await this.setCursor(row);
        return;
      }
      case "jump":
        await this.jump(a.row, a.col);
        return;
      case "diffsplit": {
        const isStale = this.staleCheck();
        const ctx = diffContext(
          snap.cls,
          frame.rows[a.row],
          this.session.range,
        );
        if (!ctx) return;
        await openDiffsplit(
          this.nvim,
          this.session.git,
          await this.win(),
          ctx,
          this.opts.ignoreWhitespace ?? false,
          isStale,
        );
        return;
      }
      case "delete-comments": {
        const lo = Math.min(a.srow, a.erow);
        const hi = Math.max(a.srow, a.erow);
        for (const t of frame.rows.slice(lo, hi + 1)) {
          if (t.kind !== "summary-comment") continue;
          const before = snap.store
            .commentsFor(t.path)
            .find((r) => r.id === t.commentId);
          if (before)
            await this.session.perform({
              kind: "comment",
              path: t.path,
              change: { op: "delete", before },
              cursor: lo,
            });
        }
        await this.redraw();
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
