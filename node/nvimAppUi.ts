/** The nvim adapter for the `App` core's `AppUi` port. */
import { basename } from "node:path";
import type { AppUi } from "./app.ts";
import { readOpenConfig } from "./config.ts";
import type { WorktreeLnum } from "./core/types.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import type { Prompts } from "./view/prompts.ts";
import { ReviewView } from "./view/view.ts";

/** `AppUi` over nvim: config reads, buffer/window ops, list painting. */
export function nvimAppUi(nvim: Nvim, prompts: Prompts): AppUi {
  const lua = (code: string, args: unknown[] = []) =>
    nvim.call("nvim_exec_lua", [code, args]);
  return {
    config: () => readOpenConfig(nvim),
    async cursorFile() {
      const [name, lnum] = (await lua(
        `return { vim.api.nvim_buf_get_name(0), vim.api.nvim_win_get_cursor(0)[1] }`,
      )) as [string, number];
      return { name, lnum: lnum as WorktreeLnum };
    },
    async bufValid(buf) {
      return (await nvim.call("nvim_buf_is_valid", [buf])) as boolean;
    },
    async openReviewBuffer(title) {
      return (await lua(
        `return require("glean.review-buffer").open_review_buffer(...)`,
        [title],
      )) as number;
    },
    async renameBuffer(buf, title) {
      await lua(`pcall(vim.api.nvim_buf_set_name, ...)`, [buf, title]);
    },
    async showBuffer(buf) {
      await lua(`require("glean.buffer-util").show_buffer(...)`, [buf]);
    },
    async wipeBuffer(buf) {
      await lua(`pcall(vim.api.nvim_buf_delete, ..., { force = true })`, [buf]);
    },
    async blankBuffer(buf) {
      await lua(
        `local buf = ...
for _, ns in pairs(vim.api.nvim_get_namespaces()) do
  vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
end
vim.bo[buf].modifiable = true
vim.api.nvim_buf_set_lines(buf, 0, -1, false, {})
vim.bo[buf].modifiable = false`,
        [buf],
      );
    },
    async setCursor(buf, row) {
      await lua(
        `local buf, row = ...
for _, win in ipairs(vim.fn.win_findbuf(buf)) do
  pcall(vim.api.nvim_win_set_cursor, win, { math.min(row + 1, vim.api.nvim_buf_line_count(buf)), 0 })
end`,
        [buf, row],
      );
    },
    async openListBuffer(kind, root) {
      return (await lua(
        `return require("glean.list-buffer").open_list_buffer(...)`,
        [kind, `Glean:${basename(root)} ${kind}`],
      )) as number;
    },
    async paintList(buf, frame) {
      await lua(
        `local buf, lines, hls = ...
local ns = vim.api.nvim_create_namespace("glean_list")
vim.bo[buf].modifiable = true
vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
vim.bo[buf].modifiable = false
vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
for i, h in ipairs(hls) do
  local group = (i == 1) and "GleanModeHeader" or "GleanCommitHeader"
  if h[2] < 0 then
    vim.api.nvim_buf_set_extmark(buf, ns, h[1], 0, { end_row = h[1] + 1, hl_group = group, hl_eol = true })
  else
    vim.api.nvim_buf_set_extmark(buf, ns, h[1], 0, { end_col = h[2], hl_group = group })
  end
end`,
        [
          buf,
          frame.lines,
          frame.highlights.map((h) => [
            h.row,
            h.endCol === "eol" ? -1 : h.endCol,
          ]),
        ],
      );
    },
    async notify(msg, level) {
      await nvim.call("nvim_notify", [
        msg,
        level === "error" ? 4 : level === "warn" ? 3 : 2,
        {},
      ]);
    },
    review(buf, session, opts) {
      return new ReviewView(nvim, buf, session, opts, prompts);
    },
  };
}
