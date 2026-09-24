/**
 * The nvim adapter for a review: implements `ReviewUi` on the scratch buffer.
 * Each frame is diffed against the previous one (common prefix/suffix) and
 * written in bounded batches so nvim never handles one huge request; it also
 * owns the display-only decor (active hunk, indent, sticky float) and
 * suspend/resume. Every decision lives in `ReviewController`.
 */

import { join } from "node:path";
import type { BufNr, NsId, PostLnum, RepoPath, WinId } from "../core/types.ts";
import {
  type Generation,
  GenerationGuard,
  RefineCache,
  runRefine,
} from "../git/scheduler.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { type DiffContext, hunkRange } from "../render/nav.ts";
import type { Frame, IntraBlock } from "../render/render.ts";
import {
  type Ancestry,
  computeAncestry,
  computePinned,
} from "../render/sticky.ts";
import type { Scope } from "../session/model.ts";
import type { Session } from "../session/session.ts";
import {
  bufferLine,
  type IsStale,
  openDiffsplit,
  openJump,
  type ResolvedJump,
} from "./jump.ts";
import { Prompts } from "./prompts.ts";
import {
  type Action,
  type NotifyLevel,
  type Query,
  ReviewController,
  type ReviewUi,
  type ViewOpts,
} from "./review.ts";

export {
  type Action,
  parseAction,
  parseQuery,
  type Query,
  type ViewOpts,
} from "./review.ts";

export const MAX_BATCH_LINES = 500;
export const MAX_BATCH_CALLS = 1000;

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
export class ReviewView implements ReviewUi {
  readonly controller: ReviewController;
  private shown: string[] = [];
  /** The last painted frame. */
  private frame: Frame | undefined;
  private ns = 0;
  private nsIntra = 0;
  private readonly intraGuard = new GenerationGuard();
  private readonly refineCache = new RefineCache();
  /** Resolves when the latest frame's intra-line refinement finishes or goes stale. */
  intraDone: Promise<unknown> = Promise.resolve();
  private readonly prompts = new Prompts();
  readonly worktreeLine;

  constructor(
    private readonly nvim: Nvim,
    readonly bufnr: number,
    readonly session: Session,
    private readonly opts: ViewOpts = {},
  ) {
    this.worktreeLine = bufferLine(nvim);
    this.controller = new ReviewController(session, this, opts, (e) =>
      nvim.logger.error(e instanceof Error ? e : String(e)),
    );
  }
  get scope(): Scope {
    return this.controller.scope;
  }
  query(q: Query) {
    return this.controller.query(q);
  }
  redraw() {
    return this.controller.redraw();
  }
  gotoSource(path: RepoPath, lnum: PostLnum) {
    return this.controller.gotoSource(path, lnum);
  }

  suspended = false;
  suspend() {
    this.suspended = true;
    this.controller.live = false;
    this.intraGuard.bump();
  }
  async resume() {
    if (!this.suspended) return;
    this.suspended = false;
    this.controller.live = true;
    await this.redraw();
    await this.session.pokePoll();
  }
  async init() {
    this.ns = await this.nvim.call("nvim_create_namespace", ["glean-review"]);
    this.nsIntra = await this.nvim.call("nvim_create_namespace", [
      "glean-review-intra",
    ]);
    const ns = async (name: string): Promise<NsId> => {
      const id = await this.nvim.call("nvim_create_namespace", [name]);
      if (typeof id !== "number") throw new Error("nvim_create_namespace");
      return id as NsId;
    };
    this.nsCursor = await ns("glean-review-cursor");
    this.nsIndent = await ns("glean-review-cursor-indent");
    this.nsSticky = await ns("glean-review-sticky");
  }

  /** Called by the controller in frame order (its draw chain serializes it),
   * so `lineEdit` always diffs against what the buffer shows. */
  async paint(frame: Frame) {
    this.frame = frame;
    const gen = this.intraGuard.bump();
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

  /** The window showing the review (-1 when hidden). */
  private async win(): Promise<number> {
    const w = await this.nvim.call("nvim_call_function", [
      "bufwinid",
      [this.bufnr],
    ]);
    return typeof w === "number" ? w : -1;
  }
  async setCursor(row: number) {
    const win = await this.win();
    if (win > 0)
      await this.nvim.call("nvim_win_set_cursor", [win, [row + 1, 0]]);
  }
  async notify(msg: string, level: NotifyLevel) {
    const n = level === "error" ? 4 : level === "warn" ? 3 : 2;
    await this.nvim.call("nvim_notify", [msg, n, {}]);
  }
  /** The ephemeral split editor lives in Lua (`comment_editor`); its text comes back as `editor-submit`. */
  async editor(initial: string[]) {
    const { token, result } = this.prompts.editor();
    await this.nvim.call("nvim_exec_lua", [
      `return require("glean.node").comment_editor(...)`,
      [this.bufnr, await this.win(), initial, token],
    ]);
    return result;
  }
  async pick(items: string[]) {
    const { token, result } = this.prompts.pick();
    await this.nvim.call("nvim_exec_lua", [
      `return require("glean.node").pick_comment(...)`,
      [this.bufnr, items, token],
    ]);
    return result;
  }
  async openJump(target: ResolvedJump, col: number, isStale: IsStale) {
    await openJump(
      this.nvim,
      this.session.git,
      await this.win(),
      target,
      col,
      isStale,
    );
  }
  async openDiffsplit(
    ctx: DiffContext,
    ignoreWhitespace: boolean,
    isStale: IsStale,
  ) {
    await openDiffsplit(
      this.nvim,
      this.session.git,
      await this.win(),
      ctx,
      ignoreWhitespace,
      isStale,
    );
  }
  async openFileAt(path: RepoPath, lnum: number) {
    await this.nvim.call("nvim_exec_lua", [
      `return require("glean.node").open_file_at(...)`,
      [await this.win(), join(this.session.repoRoot, path), lnum, 0],
    ]);
  }
  private nsCursor = 0 as NsId;
  private nsIndent = 0 as NsId;
  private nsSticky = 0 as NsId;
  private stickyWin: WinId | undefined;
  private stickyBuf: BufNr | undefined;
  /** Per-frame lookups so cursor/scroll events never rescan the frame. */
  private readonly decorCache = new WeakMap<Frame, FrameDecor>();
  private decorOf(frame: Frame): FrameDecor {
    let d = this.decorCache.get(frame);
    if (!d) {
      d = frameDecor(frame);
      this.decorCache.set(frame, d);
    }
    return d;
  }
  /** Sends extmark calls in `MAX_BATCH_CALLS` chunks, stopping once `live()` fails. */
  private async sendChunked(calls: unknown[], live: () => boolean) {
    for (let i = 0; i < calls.length; i += MAX_BATCH_CALLS) {
      if (!live()) return;
      await this.nvim.call("nvim_call_atomic", [
        calls.slice(i, i + MAX_BATCH_CALLS),
      ]);
    }
  }
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
    const { signs } = this.decorOf(frame);
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
    const live = () => this.indentGuard.isCurrent(gen) && this.frame === frame;
    await this.sendChunked(calls, live);
    if (!live()) return;
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
    const live = () => this.indentGuard.isCurrent(gen) && this.frame === frame;
    if (!live()) return;
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
    await this.sendChunked(body, live);
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
    const pinned = computePinned(this.decorOf(frame).ancestry, info.top);
    if (pinned.length === 0) {
      await this.closeSticky();
      return;
    }
    if (this.stickyBuf === undefined || !(await this.bufValid(this.stickyBuf)))
      this.stickyBuf = handle<BufNr>(
        await this.nvim.call("nvim_create_buf", [false, true]),
        "nvim_create_buf",
      );
    const sbuf = this.stickyBuf;
    const { lineHl } = this.decorOf(frame);
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
      this.stickyWin = handle<WinId>(
        await this.nvim.call("nvim_open_win", [
          sbuf,
          false,
          { ...cfg, noautocmd: true },
        ]),
        "nvim_open_win",
      );
      await this.nvim.call("nvim_set_option_value", [
        "wrap",
        false,
        { win: this.stickyWin },
      ]);
    }
  }
  private async bufValid(b: BufNr): Promise<boolean> {
    return (await this.nvim.call("nvim_buf_is_valid", [b])) as boolean;
  }
  /** The sticky float's window, if open (for tests and teardown). */
  get stickyWindow(): WinId | undefined {
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
    this.hunkKey = undefined;
    await this.nvim.call("nvim_exec_lua", [
      `local b, a, c = ...; if vim.api.nvim_buf_is_valid(b) then vim.api.nvim_buf_clear_namespace(b, a, 0, -1); vim.api.nvim_buf_clear_namespace(b, c, 0, -1) end`,
      [this.bufnr, this.nsCursor, this.nsIndent],
    ]);
    await this.closeSticky();
  }
  async dispatch(a: Action) {
    switch (a.kind) {
      case "visibility":
        if (a.visible) await this.resume();
        else {
          this.suspend();
          await this.closeSticky();
        }
        return;
      case "sticky-close":
        await this.decorChain;
        await this.closeSticky();
        return;
      case "cursor":
        await this.decorate();
        return;
      // Outside any chain: the controller task awaiting this prompt resumes.
      case "editor-submit":
      case "pick":
        this.prompts.submit(a);
        return;
      default:
        await this.controller.dispatch(a);
    }
  }
}

type FrameDecor = {
  signs: Map<number, "+" | "-">;
  lineHl: Map<number, string>;
  ancestry: Ancestry[];
};
function frameDecor(frame: Frame): FrameDecor {
  const signs = new Map<number, "+" | "-">();
  const lineHl = new Map<number, string>();
  for (const h of frame.highlights) {
    if (h.kind !== "line") continue;
    if (h.sign === "+" || h.sign === "-") signs.set(h.row, h.sign);
    if (!lineHl.has(h.row)) lineHl.set(h.row, h.hl);
  }
  return { signs, lineHl, ancestry: computeAncestry(frame.rows) };
}
function handle<T extends BufNr | WinId>(v: unknown, what: string): T {
  if (typeof v !== "number") throw new Error(`${what}: unexpected result`);
  return v as T;
}
