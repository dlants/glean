import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import {
  luaEval,
  pollUntil,
  sleep,
  startBackend,
  withNvim,
} from "../test/driver.ts";
import { makeRepo } from "../test/repo.ts";

type Mark = {
  row: number;
  sign?: string;
  hl?: string;
  text?: string;
  lineHl?: boolean;
  virtLines?: boolean;
};
const marks = (nvim: Nvim) =>
  luaEval<Mark[]>(
    nvim,
    `(function()
  local ns = vim.api.nvim_create_namespace("glean_overlay")
  local out = {}
  for _, m in ipairs(vim.api.nvim_buf_get_extmarks(0, ns, 0, -1, { details = true })) do
    local d = m[4]
    out[#out + 1] = { row = m[2], sign = d.sign_text and vim.trim(d.sign_text) or nil, hl = d.sign_hl_group,
      text = d.virt_text and d.virt_text[1][1] or nil, lineHl = d.line_hl_group ~= nil,
      virtLines = d.virt_lines ~= nil }
  end
  return out
end)()`,
  );
const signs = async (nvim: Nvim) =>
  (await marks(nvim)).filter((m) => m.sign !== undefined);
const waitFor = <T>(fn: () => Promise<T | undefined | false>) =>
  pollUntil(async () => (await fn()) || undefined);
const records = (nvim: Nvim, root: string) =>
  luaEval<
    {
      id: number;
      text: string;
      lnum: number;
      path: string;
      origin?: { sha: string; dirty: boolean };
    }[]
  >(nvim, `require("glean.api").comments({ repo = ${JSON.stringify(root)} })`);
const mapped = (nvim: Nvim, lhs: string) =>
  luaEval<boolean>(
    nvim,
    `(function() for _, m in ipairs(vim.api.nvim_buf_get_keymap(0, "n")) do if m.lhs == ${JSON.stringify(lhs)} then return true end end return false end)()`,
  );
async function author(nvim: Nvim, text: string) {
  await waitFor(async () =>
    (await luaEval<string>(nvim, "vim.api.nvim_buf_get_name(0)")).includes(
      "glean-comment://",
    ),
  );
  await nvim.call("nvim_input", ["<Esc>"]);
  await nvim.call("nvim_buf_set_lines", [0, 0, -1, false, text.split("\n")]);
  await nvim.call("nvim_command", ["write"]);
  await waitFor(
    async () =>
      !(await luaEval<string>(nvim, "vim.api.nvim_buf_get_name(0)")).includes(
        "glean-comment://",
      ),
  );
  // The record is saved before its undo entry is pushed.
  await sleep(300);
}

describe("file-buffer comment overlay (driver, overlay_test)", () => {
  it("renders, re-resolves, floats, toggles, lists, authors and undoes", async () => {
    const repo = makeRepo([
      {
        files: {
          "f.txt": "alpha\nbeta\ngamma\n",
          "quiet.txt": "nothing here\n",
          "author.txt": "one\ntwo\nthree\nfour\n",
        },
      },
    ]);
    await withNvim(async (nvim) => {
      const stateDir = mkdtempSync(join(tmpdir(), "glean-ov-"));
      await luaEval(
        nvim,
        `(function() vim.cmd.cd(${JSON.stringify(repo.root)}); vim.g.glean_state_dir = ${JSON.stringify(stateDir)}; vim.o.autoread = true; require("glean.node_overlay").setup() end)()`,
      );
      await startBackend(nvim);
      const root = JSON.stringify(repo.root);
      await luaEval(
        nvim,
        `require("glean.api").add_comment({ repo = ${root}, path = "f.txt", lnum = 2, text = "why beta?\\nsecond line" })`,
      );
      // Open: one sign on the resolved line, eol text is the first line only.
      await nvim.call("nvim_command", ["edit f.txt"]);
      const [s] = await waitFor(async () => {
        const got = await signs(nvim);
        return got.length === 1 && got;
      });
      expect(s!.row).toBe(1);
      expect(s!.text).toContain("why beta?");
      expect(s!.text).not.toContain("second line");

      // An external rewrite: the reload re-resolves and persists the move.
      writeFileSync(
        join(repo.root, "f.txt"),
        "prefix\nprefix2\nalpha\nbeta\ngamma\n",
      );
      await nvim.call("nvim_command", ["checktime"]);
      await waitFor(async () => (await signs(nvim))[0]?.row === 3);
      await waitFor(
        async () => (await records(nvim, repo.root))[0]?.lnum === 4,
      );

      // A user edit + write moves it the same way.
      await nvim.call("nvim_buf_set_lines", [0, 0, 0, false, ["extra"]]);
      await nvim.call("nvim_command", ["write"]);
      await waitFor(
        async () => (await records(nvim, repo.root))[0]?.lnum === 5,
      );

      // Float: whole body; none on an uncommented line.
      await nvim.call("nvim_win_set_cursor", [0, [5, 0]]);
      await nvim.call("nvim_input", ["<Plug>(glean-comment-show)"]);
      const float = await waitFor(() =>
        luaEval<string | null>(
          nvim,
          `(function() for _, w in ipairs(vim.api.nvim_list_wins()) do if vim.w[w].glean_overlay_float then return table.concat(vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(w), 0, -1, false), "\\n") end end end)()`,
        ).then((t) => t ?? undefined),
      );
      expect(float).toContain("second line");

      // Toggle: inline bodies come and go, the sign stays.
      await nvim.call("nvim_input", ["<Plug>(glean-comment-toggle)"]);
      await waitFor(async () => (await marks(nvim)).some((m) => m.virtLines));
      expect(await signs(nvim)).toHaveLength(1);
      await nvim.call("nvim_input", ["<Plug>(glean-comment-toggle)"]);
      await waitFor(async () => !(await marks(nvim)).some((m) => m.virtLines));
      expect(await signs(nvim)).toHaveLength(1);

      // Next/prev jump by resolved position.
      await nvim.call("nvim_win_set_cursor", [0, [1, 0]]);
      await nvim.call("nvim_input", ["<Plug>(glean-comment-next)"]);
      await waitFor(
        async () =>
          ((await nvim.call("nvim_win_get_cursor", [0])) as number[])[0] === 5,
      );

      // Deleting the text renders it outdated.
      await nvim.call("nvim_buf_set_lines", [0, 4, 5, false, ["rewritten"]]);
      await nvim.call("nvim_command", ["write"]);
      await waitFor(
        async () => (await signs(nvim))[0]?.hl === "GleanCommentOutdated",
      );
      expect((await signs(nvim))[0]!.text).toContain("(outdated)");

      // A file with no comments is untouched, `u` included.
      await nvim.call("nvim_command", ["edit quiet.txt"]);
      await nvim.call("nvim_exec_autocmds", ["BufReadPost", { buffer: 0 }]);
      await new Promise((r) => setTimeout(r, 200));
      expect(await marks(nvim)).toEqual([]);
      expect(await mapped(nvim, "u")).toBe(false);
      expect(await mapped(nvim, "<C-R>")).toBe(false);

      // Authoring: `:Glean comment` on the cursor line and a range.
      const head = repo.run(["rev-parse", "HEAD"]).trim();
      await nvim.call("nvim_command", ["edit author.txt"]);
      await nvim.call("nvim_win_set_cursor", [0, [2, 0]]);
      await nvim.call("nvim_command", ["Glean comment"]);
      await author(nvim, "about two");
      const two = await waitFor(async () =>
        (await records(nvim, repo.root)).find((r) => r.text === "about two"),
      );
      expect(two.lnum).toBe(2);
      expect(two.origin).toEqual({ sha: head, dirty: false });
      await waitFor(() => mapped(nvim, "u"));
      await nvim.call("nvim_command", ["3,4Glean comment"]);
      await author(nvim, "about the tail");
      const tail = await waitFor(async () =>
        (await records(nvim, repo.root)).find(
          (r) => r.text === "about the tail",
        ),
      );
      expect(tail.lnum).toBe(3);
      const content = await luaEval<string[]>(
        nvim,
        `(function() for _, c in ipairs(require("glean.api").comments({ repo = ${root} })) do if c.text == "about the tail" then return c.content end end end)()`,
      );
      expect(content).toEqual(["three", "four"]);
      await waitFor(
        async () => (await marks(nvim)).filter((m) => m.lineHl).length === 2,
      );

      // Delete with several on one line: pick exactly the chosen one.
      await nvim.call("nvim_command", ["Glean comment"]);
      await author(nvim, "second on two");
      await waitFor(async () =>
        (await records(nvim, repo.root)).some(
          (r) => r.text === "second on two",
        ),
      );
      await luaEval(
        nvim,
        `(function() vim.ui.select = function(choices, _, cb)
  vim.g.picked_n = #choices
  for i, c in ipairs(choices) do if c == "second on two" then return cb(c, i) end end
  cb(nil, nil) end end)()`,
      );
      await nvim.call("nvim_win_set_cursor", [0, [2, 0]]);
      await nvim.call("nvim_input", ["<Plug>(glean-comment-delete)"]);
      await waitFor(
        async () =>
          !(await records(nvim, repo.root)).some(
            (r) => r.text === "second on two",
          ),
      );
      expect(await luaEval<number>(nvim, "vim.g.picked_n")).toBe(2);
      expect(
        (await records(nvim, repo.root)).some((r) => r.text === "about two"),
      ).toBe(true);

      // u restores it without touching text; <C-r> removes it again.
      const text = await nvim.call("nvim_buf_get_lines", [0, 0, -1, false]);
      await nvim.call("nvim_input", ["u"]);
      await waitFor(async () =>
        (await records(nvim, repo.root)).some(
          (r) => r.text === "second on two",
        ),
      );
      expect(await nvim.call("nvim_buf_get_lines", [0, 0, -1, false])).toEqual(
        text,
      );
      await nvim.call("nvim_input", ["<C-r>"]);
      await waitFor(
        async () =>
          !(await records(nvim, repo.root)).some(
            (r) => r.text === "second on two",
          ),
      );

      const has = async (t: string) =>
        (await records(nvim, repo.root)).some((r) => r.text === t);
      const find = async (t: string) =>
        (await records(nvim, repo.root)).find((r) => r.text === t);
      const replyOf = async (id: number) =>
        (
          await luaEval<{ id: number; reply?: string }[]>(
            nvim,
            `require("glean.api").comments({ repo = ${root} })`,
          )
        ).find((r) => r.id === id)?.reply;
      // Edit swaps the text; u restores the original.
      await nvim.call("nvim_win_set_cursor", [0, [2, 0]]);
      await nvim.call("nvim_input", ["<Plug>(glean-comment-edit)"]);
      await author(nvim, "edited two");
      await waitFor(() => has("edited two"));
      expect(await has("about two")).toBe(false);
      await nvim.call("nvim_input", ["u"]);
      await waitFor(() => has("about two"));
      await sleep(300);
      expect(await has("edited two")).toBe(false);
      // An unchanged edit does nothing (nothing new to undo).
      await nvim.call("nvim_input", ["<Plug>(glean-comment-edit)"]);
      await author(nvim, "about two");
      // Reply fills the slot, replying again replaces it; u restores each before.
      const twoId = (await find("about two"))!.id;
      await nvim.call("nvim_input", ["<Plug>(glean-comment-reply)"]);
      await author(nvim, "r1");
      await waitFor(async () => (await replyOf(twoId)) === "r1");
      await nvim.call("nvim_input", ["<Plug>(glean-comment-reply)"]);
      await author(nvim, "r2");
      await waitFor(async () => (await replyOf(twoId)) === "r2");
      await nvim.call("nvim_input", ["u"]);
      await waitFor(async () => (await replyOf(twoId)) === "r1");
      await sleep(300);
      await nvim.call("nvim_input", ["u"]);
      await waitFor(async () => (await replyOf(twoId)) === undefined);
      expect(await has("about two")).toBe(true);
      // Add: u removes it, <C-r> brings it back under the same id, u removes it again.
      await nvim.call("nvim_win_set_cursor", [0, [1, 0]]);
      await nvim.call("nvim_command", ["Glean comment"]);
      await author(nvim, "added one");
      const added = await waitFor(() => find("added one"));
      await nvim.call("nvim_input", ["u"]);
      await waitFor(async () => !(await has("added one")));
      await sleep(300);
      await nvim.call("nvim_input", ["<C-r>"]);
      const redone = await waitFor(() => find("added one"));
      expect(redone.id).toBe(added.id);
      await sleep(300);
      await nvim.call("nvim_input", ["u"]);
      await waitFor(async () => !(await has("added one")));
      // An agent api write re-stamps the open file buffer.
      const before = (await signs(nvim)).length;
      await luaEval(
        nvim,
        `require("glean.api").add_comment({ repo = ${root}, path = "author.txt", lnum = 1, text = "from agent" })`,
      );
      await waitFor(async () =>
        (await marks(nvim)).some((m) => m.text?.includes("from agent")),
      );
      expect((await signs(nvim)).length).toBeGreaterThan(before);
      // Quickfix: every record, named by file.
      await nvim.call("nvim_command", ["Glean comments"]);
      const qf = await waitFor(async () => {
        const items = await luaEval<{ text: string }[]>(
          nvim,
          "vim.fn.getqflist()",
        );
        return items.length === 4 && items;
      });
      expect(qf.map((i) => i.text).join("\n")).toContain("(outdated)");
    });
  });

  it("outside a git repo authoring only notifies", async () => {
    await withNvim(async (nvim) => {
      await startBackend(nvim);
      const dir = mkdtempSync(join(tmpdir(), "glean-loose-"));
      writeFileSync(join(dir, "loose.txt"), "hello\n");
      await luaEval(
        nvim,
        `(function() vim.notify = function(m) vim.g.notified = m end; vim.cmd("edit ${join(dir, "loose.txt")}") end)()`,
      );
      await nvim.call("nvim_command", ["Glean comment"]);
      const msg = await waitFor(() =>
        luaEval<string | null>(nvim, "vim.g.notified").then(
          (m) => m ?? undefined,
        ),
      );
      expect(msg).toContain("git repo");
      expect(await luaEval<string>(nvim, "vim.bo.buftype")).toBe("");
      expect(await marks(nvim)).toEqual([]);
    });
  });
});
