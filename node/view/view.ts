/**
 * Projects a Session into a nomodifiable scratch buffer. Each frame is diffed
 * against the previous one (common prefix/suffix) and written in bounded
 * batches so nvim never handles one huge request; Lua only dispatches Actions.
 */

import { join } from "node:path";
import type { Layer, LineId, PostLnum, RepoPath } from "../core/types.ts";
import {
  type Generation,
  GenerationGuard,
  RefineCache,
  runRefine,
} from "../git/scheduler.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import {
  collapseTarget,
  nextUnseenHunk,
  planToggleSeen,
  planUnmarkAll,
  planUnmarkHunk,
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
import { computeAncestry, computePinned } from "../render/sticky.ts";
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
  | { kind: "unmark-hunk"; row: number }
  | { kind: "unmark-all" }
  | { kind: "toggle-whitespace"; row: number }
  /** Cursor moved / scrolled / window layout changed: repaint the cursor decor. */
  | { kind: "cursor" }
  | { kind: "sticky-close" }
  | { kind: "visibility"; visible: boolean }
  /** Registry-level (not the view): the buffer was wiped, or `:e` hard reset. */
  | { kind: "gone" }
  | { kind: "reset"; row: number | undefined };

export function parseAction(v: unknown): Action | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const num = (k: string) => (typeof o[k] === "number" ? o[k] : undefined);
  switch (o.kind) {
    case "toggle-seen":
    case "toggle-scope":
    case "toggle-fold":
    case "unmark-hunk":
    case "toggle-whitespace":
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
    case "reset":
      return { kind: "reset", row: num("row") };
    case "visibility":
      return typeof o.visible === "boolean"
        ? { kind: "visibility", visible: o.visible }
        : undefined;
    case "undo":
    case "redo":
    case "unmark-all":
    case "cursor":
    case "sticky-close":
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

export type ViewOpts = {
  minSeenRun?: number;
  hunkIndent?: number;
  hunkIndentDelayMs?: number;
};
/** Where the review is displayed, as read by `glean.node.cursor_info`. */
type CursorInfo = {
  win: number;
  row: number;
  top: number;
  width: number;
  textoff: number;
};
function parseCursorInfo(v: unknown): CursorInfo | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === "number" ? o[k] : undefined);
  const win = n("win");
  const row = n("row");
  const top = n("top");
  const width = n("width");
  const textoff = n("textoff");
  if (
    win === undefined ||
    row === undefined ||
    top === undefined ||
    width === undefined ||
    textoff === undefined
  )
    return undefined;
  return { win, row, top, width, textoff };
}
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
    const ns = (name: string) =>
      this.nvim.call("nvim_create_namespace", [name]) as Promise<number>;
    this.nsCursor = await ns("glean-review-cursor");
    this.nsIndent = await ns("glean-review-cursor-indent");
    this.nsSticky = await ns("glean-review-sticky");
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
      ignoreWhitespace: this.session.ignoreWhitespace,
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
    void this.decorate().catch(() => undefined);
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
  private nsCursor = 0;
  private nsIndent = 0;
  private nsSticky = 0;
  private stickyWin: number | undefined;
  private stickyBuf: number | undefined;
  /** Last painted float state; an unchanged topline/width/frame skips the work. */
  private stickyKey: { top: number; width: number; frame: Frame } | undefined;
  private hunkKey: { lo: number; hi: number; frame: Frame } | undefined;
  private readonly indentGuard = new GenerationGuard();
  private decorChain: Promise<unknown> = Promise.resolve();
  /** Serialized so a burst of CursorMoved never interleaves float/sign writes. */
  private decorate(): Promise<void> {
    const next = this.decorChain.then(() => this.paintDecor());
    this.decorChain = next.catch(() => undefined);
    return next;
  }
  private async paintDecor() {
    if (this.suspended) return;
    const info = parseCursorInfo(
      await this.nvim.call("nvim_exec_lua", [
        `return require("glean.node").cursor_info(...)`,
        [this.bufnr],
      ]),
    );
    const frame = this.frame;
    if (!info || !frame) {
      await this.closeSticky();
      return;
    }
    await this.paintHunk(frame, info.row);
    await this.paintSticky(frame, info);
  }
  /**
   * The active hunk: a gutter bar (or the row's +/- in its diff colour) on
   * every row, and after `hunkIndentDelayMs` its body shifted right by
   * `hunkIndent` columns of inline virtual text (display-only).
   */
  private async paintHunk(frame: Frame, row: number) {
    const r = hunkRange(frame, row);
    const k = this.hunkKey;
    if (r && k && k.lo === r.lo && k.hi === r.hi && k.frame === frame) return;
    if (!r && !k) return;
    this.hunkKey = r && { lo: r.lo, hi: r.hi, frame };
    const gen = this.indentGuard.bump();
    const b = this.bufnr;
    await this.nvim.call("nvim_buf_clear_namespace", [b, this.nsCursor, 0, -1]);
    await this.nvim.call("nvim_buf_clear_namespace", [b, this.nsIndent, 0, -1]);
    if (!r) return;
    const signs = new Map<number, "+" | "-">();
    for (const h of frame.highlights)
      if (
        h.kind === "line" &&
        (h.sign === "+" || h.sign === "-") &&
        h.row >= r.lo &&
        h.row <= r.hi
      )
        signs.set(h.row, h.sign);
    const calls: unknown[] = [];
    for (let row = r.lo; row <= r.hi; row++) {
      const s = signs.get(row);
      calls.push([
        "nvim_buf_set_extmark",
        [
          b,
          this.nsCursor,
          row,
          0,
          {
            sign_text: s ?? "▌",
            sign_hl_group:
              s === "+"
                ? "GleanAddText"
                : s === "-"
                  ? "GleanDelText"
                  : "GleanCurrentHunk",
            priority: 100,
          },
        ],
      ]);
    }
    await this.nvim.call("nvim_call_atomic", [calls]);
    const indent = Math.max(0, this.opts.hunkIndent ?? 2);
    if (indent === 0) return;
    const delay = Math.max(0, this.opts.hunkIndentDelayMs ?? 50);
    const apply = () => {
      this.indentDone = this.decorChain.then(() =>
        this.paintIndent(frame, r, indent, gen),
      );
    };
    if (delay === 0) apply();
    else setTimeout(apply, delay);
  }
  /** Resolves once the latest scheduled hunk indent landed (or was dropped). */
  indentDone: Promise<unknown> = Promise.resolve();
  private async paintIndent(
    frame: Frame,
    r: { lo: number; hi: number },
    indent: number,
    gen: Generation,
  ) {
    if (!this.indentGuard.isCurrent(gen) || this.frame !== frame) return;
    const b = this.bufnr;
    const body: unknown[] = [];
    for (let row = r.lo; row <= r.hi; row++) {
      if (frame.rows[row]?.kind === "hunk-header") continue;
      body.push([
        "nvim_buf_set_extmark",
        [
          b,
          this.nsIndent,
          row,
          0,
          {
            virt_text: [[" ".repeat(indent), "Normal"]],
            virt_text_pos: "inline",
            priority: 4200,
          },
        ],
      ]);
    }
    await this.nvim.call("nvim_call_atomic", [body]);
  }
  /**
   * Pin the enclosing headers of the topline in a non-focusable float over the
   * review window, as treesitter-context does. One float and one buffer are
   * reused; later updates only reposition.
   */
  private async paintSticky(frame: Frame, info: CursorInfo) {
    const k = this.stickyKey;
    if (
      k &&
      k.top === info.top &&
      k.width === info.width &&
      k.frame === frame &&
      this.stickyWin !== undefined
    )
      return;
    this.stickyKey = { top: info.top, width: info.width, frame };
    const pinned = computePinned(computeAncestry(frame.rows), info.top);
    if (pinned.length === 0) {
      await this.closeSticky();
      return;
    }
    if (this.stickyBuf === undefined || !(await this.bufValid(this.stickyBuf)))
      this.stickyBuf = (await this.nvim.call("nvim_create_buf", [
        false,
        true,
      ])) as number;
    const sbuf = this.stickyBuf;
    const lineHl = new Map<number, string>();
    for (const h of frame.highlights)
      if (h.kind === "line" && !lineHl.has(h.row)) lineHl.set(h.row, h.hl);
    const calls: unknown[] = [
      [
        "nvim_buf_set_lines",
        [sbuf, 0, -1, false, pinned.map((r) => frame.lines[r] ?? "")],
      ],
      ["nvim_buf_clear_namespace", [sbuf, this.nsSticky, 0, -1]],
    ];
    pinned.forEach((row, i) => {
      const hl = lineHl.get(row);
      if (hl)
        calls.push([
          "nvim_buf_set_extmark",
          [
            sbuf,
            this.nsSticky,
            i,
            0,
            { end_row: i + 1, end_col: 0, hl_group: hl, hl_eol: true },
          ],
        ]);
    });
    await this.nvim.call("nvim_call_atomic", [calls]);
    const cfg = {
      relative: "win",
      win: info.win,
      anchor: "NW",
      row: 0,
      col: info.textoff,
      width: Math.max(1, info.width - info.textoff),
      height: pinned.length,
      focusable: false,
      style: "minimal",
      zindex: 50,
    };
    const cur = this.stickyWin;
    const valid =
      cur !== undefined &&
      ((await this.nvim.call("nvim_win_is_valid", [cur])) as boolean);
    if (valid) await this.nvim.call("nvim_win_set_config", [cur, cfg]);
    else {
      this.stickyWin = (await this.nvim.call("nvim_open_win", [
        sbuf,
        false,
        { ...cfg, noautocmd: true },
      ])) as number;
      await this.nvim.call("nvim_set_option_value", [
        "wrap",
        false,
        { win: this.stickyWin },
      ]);
    }
  }
  private async bufValid(b: number): Promise<boolean> {
    return (await this.nvim.call("nvim_buf_is_valid", [b])) as boolean;
  }
  /** The sticky float's window, if open (for tests and teardown). */
  get stickyWindow(): number | undefined {
    return this.stickyWin;
  }
  async closeSticky() {
    this.stickyKey = undefined;
    const w = this.stickyWin;
    this.stickyWin = undefined;
    if (w !== undefined)
      await this.nvim.call("nvim_exec_lua", [
        `pcall(vim.api.nvim_win_close, ..., true)`,
        [w],
      ]);
  }
  /** Tear down every window-scoped artifact (reset, close). */
  async detach() {
    this.suspend();
    this.indentGuard.bump();
    await this.closeSticky();
  }
  /**
   * `W`: flip the whitespace projection and put the cursor back on the same
   * semantic line (rows are not comparable across projections).
   */
  private async toggleWhitespace(row: number) {
    const snap = this.session.current;
    const anchor = snap && cursorAnchor(snap.cls, this.frame?.rows[row]);
    const r = await this.session.setIgnoreWhitespace(
      !this.session.ignoreWhitespace,
    );
    if (r.kind !== "applied") return;
    await this.redraw();
    const next = this.frame;
    const cls = this.session.current?.cls;
    const dest = anchor && next && cls && restoreAnchor(cls, next, anchor);
    if (dest !== undefined) await this.setCursor(dest);
  }
  async dispatch(a: Action) {
    if (a.kind === "visibility") {
      if (a.visible) await this.resume();
      else {
        this.suspend();
        await this.closeSticky();
      }
      return;
    }
    if (a.kind === "sticky-close") {
      await this.decorChain;
      await this.closeSticky();
      return;
    }
    if (a.kind === "cursor") {
      await this.decorate();
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
      case "unmark-hunk": {
        const t = frame.rows[a.row];
        const plan = t && planUnmarkHunk(snap.cls, this.scope, t);
        if (!plan) return;
        await this.session.perform({ kind: "seen", plan, cursor: a.row });
        await this.redraw();
        return;
      }
      case "unmark-all": {
        const plan = planUnmarkAll(snap.cls, this.scope);
        if (!plan) return;
        await this.session.perform({ kind: "seen", plan });
        await this.redraw();
        return;
      }
      case "toggle-whitespace":
        await this.toggleWhitespace(a.row);
        return;
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
          this.session.ignoreWhitespace,
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
