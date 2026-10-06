/** The nvim adapter for the comment overlay's `OverlayUi` port. */
import {
  type BufNr,
  COL0,
  endRow,
  nextRow,
  ROW0,
  type Row,
  rowAt,
  toRow,
  type WorktreeLnum,
} from "../core/types.ts";
import { type AtomicCall, atomic } from "../nvim/atomic.ts";
import type { HLGroup } from "../nvim/extmarks.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { Prompts } from "../view/prompts.ts";
import type { NotifyLevel } from "../view/review.ts";
import { MAX_BATCH_CALLS } from "../view/view.ts";
import type { BufFacts, OverlayUi } from "./overlay.ts";

export class NvimOverlayUi implements OverlayUi {
  private ns = 0;
  constructor(
    private readonly nvim: Nvim,
    private readonly prompts: Prompts,
  ) {}

  async init() {
    this.ns = await this.nvim.call("nvim_create_namespace", ["glean_overlay"]);
  }

  logError(err: unknown) {
    this.nvim.logger.error(err instanceof Error ? err : String(err));
  }

  async fileBuffers() {
    return (await this.nvim.call("nvim_exec_lua", [
      `local out = {}
for _, b in ipairs(vim.api.nvim_list_bufs()) do
  if vim.api.nvim_buf_is_loaded(b) and vim.bo[b].buftype == "" and vim.api.nvim_buf_get_name(b) ~= "" then
    out[#out + 1] = b
  end
end
return out`,
      [],
    ])) as BufNr[];
  }

  async facts(buf: BufNr): Promise<BufFacts | undefined> {
    const r = (await this.nvim.call("nvim_exec_lua", [
      `local b = ...
if not vim.api.nvim_buf_is_loaded(b) then return vim.NIL end
return { vim.api.nvim_buf_get_name(b), vim.bo[b].buftype, vim.bo[b].modified,
  vim.api.nvim_buf_call(b, function() return vim.fn.undotree().seq_last end) }`,
      [buf],
    ])) as unknown;
    if (!Array.isArray(r)) return undefined;
    const [name, buftype, modified, seq] = r as unknown[];
    return typeof name === "string" &&
      typeof buftype === "string" &&
      typeof modified === "boolean" &&
      typeof seq === "number"
      ? { name, buftype, modified, seq }
      : undefined;
  }

  allLines(buf: BufNr) {
    return this.getLines(buf, ROW0, -1);
  }
  range(buf: BufNr, r: { from: WorktreeLnum; to: WorktreeLnum }) {
    return this.getLines(buf, toRow(r.from), endRow(r.to));
  }
  private async getLines(buf: BufNr, lo: Row, hi: Row | -1) {
    const l = await this.nvim.call("nvim_buf_get_lines", [buf, lo, hi, false]);
    return Array.isArray(l)
      ? l.filter((t): t is string => typeof t === "string")
      : [];
  }

  async cwd() {
    return (await this.nvim.call("nvim_exec_lua", [
      `return vim.fn.getcwd()`,
      [],
    ])) as string;
  }

  async stamp(buf: BufNr, stamps: Parameters<OverlayUi["stamp"]>[1]) {
    const calls: AtomicCall[] = [
      atomic("nvim_buf_clear_namespace", [buf, this.ns, ROW0, -1]),
    ];
    for (const s of stamps)
      calls.push(
        atomic("nvim_buf_set_extmark", [buf, this.ns, s.row, COL0, s.opts]),
      );
    for (let i = 0; i < calls.length; i += MAX_BATCH_CALLS)
      await this.nvim.call("nvim_call_atomic", [
        calls.slice(i, i + MAX_BATCH_CALLS),
      ]);
  }

  async activateUndo(buf: BufNr) {
    await this.nvim.call("nvim_exec_lua", [
      `require("glean.gutter").activate_undo(..., "overlay")`,
      [buf],
    ]);
  }

  async park(buf: BufNr, lnum: WorktreeLnum) {
    await this.nvim.call("nvim_exec_lua", [
      `local buf, lnum1 = ...
if vim.api.nvim_get_current_buf() ~= buf then return end
vim.api.nvim_win_set_cursor(0, { math.min(lnum1, vim.api.nvim_buf_line_count(buf)), 0 })`,
      [buf, lnum],
    ]);
  }

  async float(lines: Parameters<OverlayUi["float"]>[0]) {
    await this.nvim.call("nvim_exec_lua", [
      `return require("glean.overlay").float(...)`,
      [lines.map((l) => l.text), floatMarks(lines)],
    ]);
  }

  async quickfix(items: Parameters<OverlayUi["quickfix"]>[0]) {
    await this.nvim.call("nvim_exec_lua", [
      `vim.fn.setqflist({}, " ", { title = "glean comments", items = ... })
vim.cmd("copen")`,
      [items],
    ]);
  }

  async notify(msg: string, level: NotifyLevel) {
    const n = level === "error" ? 4 : level === "warn" ? 3 : 2;
    await this.nvim.call("nvim_notify", [msg, n, {}]);
  }

  async editor(initial: string[]) {
    const { token, result } = this.prompts.editor();
    await this.nvim.call("nvim_exec_lua", [
      `return require("glean.comments").comment_editor(0, ...)`,
      [initial, token],
    ]);
    return result;
  }

  async pick(items: string[], title: string) {
    const { token, result } = this.prompts.pick();
    await this.nvim.call("nvim_exec_lua", [
      `return require("glean.comments").pick_comment(...)`,
      [items, token, title],
    ]);
    return result;
  }
}
/** `[row0, end_row0, hl_group]` per highlighted float line, so the Lua side does no index arithmetic. */
function floatMarks(
  lines: Parameters<OverlayUi["float"]>[0],
): [Row, Row, HLGroup][] {
  const out: [Row, Row, HLGroup][] = [];
  lines.forEach((l, i) => {
    if (l.hl) out.push([rowAt(i), nextRow(rowAt(i)), l.hl]);
  });
  return out;
}
