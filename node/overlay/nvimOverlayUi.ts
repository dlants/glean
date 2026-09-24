/** The nvim adapter for the comment overlay's `OverlayUi` port. */
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { type PromptResult, Prompts } from "../view/prompts.ts";
import type { NotifyLevel } from "../view/review.ts";
import { MAX_BATCH_CALLS } from "../view/view.ts";
import type { BufFacts, OverlayUi } from "./overlay.ts";

export class NvimOverlayUi implements OverlayUi {
  private ns = 0;
  private readonly prompts = new Prompts();
  constructor(private readonly nvim: Nvim) {}

  async init() {
    this.ns = await this.nvim.call("nvim_create_namespace", ["glean_overlay"]);
  }

  /** Editor/picker answers arrive as their own events, outside the overlay's chain. */
  submit(r: PromptResult) {
    this.prompts.submit(r);
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
    ])) as number[];
  }

  async facts(buf: number): Promise<BufFacts | undefined> {
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

  async lines(buf: number, lo = 0, hi = -1) {
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

  async stamp(buf: number, stamps: Parameters<OverlayUi["stamp"]>[1]) {
    const calls: unknown[] = [
      ["nvim_buf_clear_namespace", [buf, this.ns, 0, -1]],
    ];
    for (const s of stamps)
      calls.push(["nvim_buf_set_extmark", [buf, this.ns, s.row, 0, s.opts]]);
    for (let i = 0; i < calls.length; i += MAX_BATCH_CALLS)
      await this.nvim.call("nvim_call_atomic", [
        calls.slice(i, i + MAX_BATCH_CALLS),
      ]);
  }

  async activateUndo(buf: number) {
    await this.nvim.call("nvim_exec_lua", [
      `require("glean.node_gutter").activate_undo(..., "overlay")`,
      [buf],
    ]);
  }

  async park(buf: number, lnum: number) {
    await this.nvim.call("nvim_exec_lua", [
      `local buf, row = ...
if vim.api.nvim_get_current_buf() ~= buf then return end
vim.api.nvim_win_set_cursor(0, { math.min(row, vim.api.nvim_buf_line_count(buf)), 0 })`,
      [buf, lnum],
    ]);
  }

  async float(lines: Parameters<OverlayUi["float"]>[0]) {
    await this.nvim.call("nvim_exec_lua", [
      `return require("glean.node_overlay").float(...)`,
      [lines.map((l) => l.text), lines.map((l) => l.hl)],
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
      `return require("glean.node").comment_editor("overlay", 0, ...)`,
      [initial, token],
    ]);
    return result;
  }

  async pick(items: string[], title: string) {
    const { token, result } = this.prompts.pick();
    await this.nvim.call("nvim_exec_lua", [
      `return require("glean.node").pick_comment("overlay", ...)`,
      [items, token, title],
    ]);
    return result;
  }
}
