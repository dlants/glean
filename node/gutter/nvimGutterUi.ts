/** The nvim adapter for the file-buffer gutter's `GutterUi` port. */
import type { BufNr, WorktreeLnum } from "../core/types.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { NotifyLevel } from "../view/review.ts";
import { MAX_BATCH_CALLS } from "../view/view.ts";
import type { UndoDepth } from "./bufUndo.ts";
import {
  type BufInfo,
  type GutterPaint,
  type GutterSign,
  type GutterUi,
  parseInfos,
  type SeqInfo,
} from "./fileGutter.ts";
import type { GutterKind } from "./project.ts";

// Shape is the kind, colour the seen status. The focused hunk (what `gmc`
// acts on) is drawn heavier in the same colour. A modified buffer holds the
// column open with a placeholder so its text does not reflow mid-edit.
const GLYPH: Record<GutterKind, string> = {
  add: "▎",
  change: "▎",
  del: "▁",
  context: "▏",
};
const FOCUS_GLYPH: Record<GutterKind, string> = {
  add: "█",
  change: "█",
  del: "▄",
  context: "▎",
};
const GROUP: Record<GutterKind, string> = {
  add: "GleanGutterAdd",
  change: "GleanGutterChange",
  del: "GleanGutterDelete",
  context: "GleanGutterContext",
};
const STALE_GLYPH = "╎";
// Above the base sign's default priority: with a one-wide sign column only
// the top sign on a row is drawn.
const FOCUS_PRIORITY = 4097;
const LEVEL: Record<NotifyLevel, number> = { info: 2, warn: 3, error: 4 };

export class NvimGutterUi implements GutterUi {
  private ns = 0;
  private nsFocus = 0;
  constructor(private readonly nvim: Nvim) {}
  async init() {
    this.ns = await this.nvim.call("nvim_create_namespace", ["glean_gutter"]);
    this.nsFocus = await this.nvim.call("nvim_create_namespace", [
      "glean_gutter_focus",
    ]);
  }
  logError(err: unknown) {
    this.nvim.logger.error(err instanceof Error ? err : String(err));
  }
  infos(bufs: BufNr[] | undefined): Promise<BufInfo[]> {
    return this.fetch(bufs, false);
  }
  async seqInfo(buf: BufNr): Promise<SeqInfo | undefined> {
    const [info] = await this.fetch([buf], true);
    return info?.seq === undefined ? undefined : { ...info, seq: info.seq };
  }
  private async fetch(bufs: BufNr[] | undefined, withSeq: boolean) {
    // Lua reads an absent list as "every buffer"; msgpack needs nil here.
    const args = bufs === undefined ? [null, withSeq] : [bufs, withSeq];
    return parseInfos(
      await this.nvim.call("nvim_exec_lua", [
        `return require("glean.node_gutter").info(...)`,
        args,
      ]),
    );
  }
  async lines(buf: BufNr): Promise<string[]> {
    const l = (await this.nvim.call("nvim_buf_get_lines", [
      buf,
      0,
      -1,
      false,
    ])) as unknown;
    return Array.isArray(l) ? l.filter((x) => typeof x === "string") : [];
  }
  async paint(paints: GutterPaint[]) {
    const calls: unknown[] = [];
    for (const p of paints) {
      if (p.member)
        calls.push([
          "nvim_exec_lua",
          [`require("glean.node_gutter").${p.member}(...)`, [p.buf]],
        ]);
      calls.push(["nvim_buf_clear_namespace", [p.buf, this.ns, 0, -1]]);
      const st = p.state;
      const mark = (lnum: WorktreeLnum, opts: object) =>
        calls.push([
          "nvim_buf_set_extmark",
          [p.buf, this.ns, lnum - 1, 0, opts],
        ]);
      if (st.kind === "stale")
        for (const lnum of st.lnums)
          mark(lnum, {
            sign_text: STALE_GLYPH,
            sign_hl_group: "GleanGutterStale",
          });
      if (st.kind === "live")
        for (const s of st.signs)
          mark(s.lnum, { sign_text: GLYPH[s.kind], sign_hl_group: group(s) });
      calls.push(...this.focusCalls(p.buf, st.kind === "live" ? st.focus : []));
    }
    await this.atomic(calls);
  }
  focus(buf: BufNr, signs: GutterSign[]) {
    return this.atomic(this.focusCalls(buf, signs));
  }
  private focusCalls(buf: BufNr, signs: GutterSign[]): unknown[] {
    return [
      ["nvim_buf_clear_namespace", [buf, this.nsFocus, 0, -1]],
      ...signs.map((s) => [
        "nvim_buf_set_extmark",
        [
          buf,
          this.nsFocus,
          s.lnum - 1,
          0,
          {
            sign_text: FOCUS_GLYPH[s.kind],
            sign_hl_group: group(s),
            priority: FOCUS_PRIORITY,
          },
        ],
      ]),
    ];
  }
  private async atomic(calls: unknown[]) {
    for (let i = 0; i < calls.length; i += MAX_BATCH_CALLS)
      await this.nvim.call("nvim_call_atomic", [
        calls.slice(i, i + MAX_BATCH_CALLS),
      ]);
  }
  async setUndoDepth(buf: BufNr, depth: UndoDepth) {
    await this.nvim.call("nvim_buf_set_var", [buf, "glean_undo", depth]);
  }
  async park(buf: BufNr, row: WorktreeLnum) {
    await this.nvim.call("nvim_exec_lua", [
      `local buf, row = ...
if vim.api.nvim_get_current_buf() ~= buf then return end
vim.cmd("normal! m'")
vim.api.nvim_win_set_cursor(0, { math.min(row, vim.api.nvim_buf_line_count(buf)), 0 })`,
      [buf, row],
    ]);
  }
  async notify(msg: string, level: NotifyLevel) {
    await this.nvim.call("nvim_notify", [msg, LEVEL[level], {}]);
  }
}

function group(s: GutterSign) {
  return GROUP[s.kind] + (s.seen ? "Seen" : "");
}
