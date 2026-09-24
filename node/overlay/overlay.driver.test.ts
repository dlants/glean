import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { luaEval, pollUntil, startBackend, startNvim } from "../test/driver.ts";
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
/** Waits for the file buffer's glean undo stack to reach `depth`. */
const undoDepth = (nvim: Nvim, undo: number, redo = 0) =>
  waitFor(async () => {
    const d = await luaEval<{ undo: number; redo: number } | null>(
      nvim,
      "vim.b.glean_undo",
    );
    return d?.undo === undo && d.redo === redo;
  });
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
}

const FILES = {
  "f.txt": "alpha\nbeta\ngamma\n",
  "quiet.txt": "nothing here\n",
  "author.txt": "one\ntwo\nthree\nfour\n",
};
type Ctx = {
  nvim: Nvim;
  root: string;
  head: string;
  recs: () => ReturnType<typeof records>;
  has: (t: string) => Promise<boolean>;
  find: (
    t: string,
  ) => Promise<Awaited<ReturnType<typeof records>>[number] | undefined>;
  api: (lua: string) => Promise<unknown>;
};
// One nvim + backend for the whole file (startup is ~250 ms); each test gets
// its own repo, state dir and tab.
let shared: Awaited<ReturnType<typeof startNvim>>;
beforeAll(async () => {
  shared = await startNvim();
  await luaEval(
    shared.nvim,
    `(function() vim.o.autoread = true; vim.o.hidden = true; require("glean.overlay").setup() end)()`,
  );
  await startBackend(shared.nvim);
});
afterAll(() => shared.close());
async function withOverlay(fn: (c: Ctx) => Promise<void>) {
  const repo = makeRepo([{ files: FILES }]);
  const { nvim } = shared;
  const stateDir = mkdtempSync(join(tmpdir(), "glean-ov-"));
  await luaEval(
    nvim,
    `(function() vim.cmd.tabnew(); vim.cmd.tcd(${JSON.stringify(repo.root)}); vim.g.glean_state_dir = ${JSON.stringify(stateDir)} end)()`,
  );
  const root = JSON.stringify(repo.root);
  const recs = () => records(nvim, repo.root);
  await fn({
    nvim,
    root: repo.root,
    head: repo.shas[0] ?? "",
    recs,
    has: async (t) => (await recs()).some((r) => r.text === t),
    find: async (t) => (await recs()).find((r) => r.text === t),
    api: (call) =>
      luaEval(nvim, `require("glean.api").${call.replace("$REPO", root)}`),
  });
}

describe("file-buffer comment overlay (driver, overlay_test)", () => {
  it("renders and re-resolves on reload and on write", async () => {
    await withOverlay(async ({ nvim, root, recs, api }) => {
      await api(
        `add_comment({ repo = $REPO, path = "f.txt", lnum = 2, text = "why beta?\\nsecond line" })`,
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
        join(root, "f.txt"),
        "prefix\nprefix2\nalpha\nbeta\ngamma\n",
      );
      await nvim.call("nvim_command", ["checktime"]);
      await waitFor(async () => (await signs(nvim))[0]?.row === 3);
      await waitFor(async () => (await recs())[0]?.lnum === 4);

      // A user edit + write moves it the same way.
      await nvim.call("nvim_buf_set_lines", [0, 0, 0, false, ["extra"]]);
      await nvim.call("nvim_command", ["write"]);
      await waitFor(async () => (await recs())[0]?.lnum === 5);
    });
  });

  it("floats the body, toggles inline bodies and jumps to the next", async () => {
    await withOverlay(async ({ nvim, api }) => {
      await api(
        `add_comment({ repo = $REPO, path = "f.txt", lnum = 2, text = "why beta?\\nsecond line" })`,
      );
      await nvim.call("nvim_command", ["edit f.txt"]);
      await waitFor(async () => (await signs(nvim)).length === 1);
      // Float: whole body.
      await nvim.call("nvim_win_set_cursor", [0, [2, 0]]);
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
          ((await nvim.call("nvim_win_get_cursor", [0])) as number[])[0] === 2,
      );
    });
  });

  it("leaves a file with no comments untouched, `u` included", async () => {
    await withOverlay(async ({ nvim, api }) => {
      await api(
        `add_comment({ repo = $REPO, path = "f.txt", lnum = 1, text = "c" })`,
      );
      await nvim.call("nvim_command", ["edit quiet.txt"]);
      await nvim.call("nvim_exec_autocmds", ["BufReadPost", { buffer: 0 }]);
      // Overlay events are handled in order: once f.txt is stamped, quiet.txt's were handled.
      await nvim.call("nvim_command", ["edit f.txt"]);
      await waitFor(async () => (await signs(nvim)).length === 1);
      await nvim.call("nvim_command", ["buffer quiet.txt"]);
      expect(await marks(nvim)).toEqual([]);
      expect(await mapped(nvim, "u")).toBe(false);
      expect(await mapped(nvim, "<C-R>")).toBe(false);
    });
  });

  it("a cancelled editor or dismissed picker adds/deletes nothing and later prompts still run", async () => {
    await withOverlay(async ({ nvim, recs, has, api }) => {
      for (const text of ["one a", "one b"])
        await api(
          `add_comment({ repo = $REPO, path = "author.txt", lnum = 2, text = "${text}" })`,
        );
      await nvim.call("nvim_command", ["edit author.txt"]);
      await waitFor(() => mapped(nvim, "u"));
      await nvim.call("nvim_win_set_cursor", [0, [1, 0]]);
      await nvim.call("nvim_command", ["Glean comment"]);
      await waitFor(async () =>
        (await luaEval<string>(nvim, "vim.api.nvim_buf_get_name(0)")).includes(
          "glean-comment://",
        ),
      );
      await nvim.call("nvim_input", ["<Esc>q"]);
      await waitFor(
        async () =>
          !(
            await luaEval<string>(nvim, "vim.api.nvim_buf_get_name(0)")
          ).includes("glean-comment://"),
      );
      await luaEval(
        nvim,
        `(function() vim.ui.select = function(_, _, cb) cb(nil, nil) end end)()`,
      );
      await nvim.call("nvim_win_set_cursor", [0, [2, 0]]);
      await nvim.call("nvim_input", ["<Plug>(glean-comment-delete)"]);
      await nvim.call("nvim_win_set_cursor", [0, [3, 0]]);
      await nvim.call("nvim_command", ["Glean comment"]);
      await author(nvim, "after cancel");
      await waitFor(() => has("after cancel"));
      expect((await recs()).map((r) => r.text).sort()).toEqual([
        "after cancel",
        "one a",
        "one b",
      ]);
      await undoDepth(nvim, 1);
    });
  });
  it("deletes the picked one of several, u restores and <C-r> re-deletes", async () => {
    await withOverlay(async ({ nvim, recs, has, api }) => {
      for (const text of ["about two", "second on two"])
        await api(
          `add_comment({ repo = $REPO, path = "author.txt", lnum = 2, text = "${text}" })`,
        );
      await nvim.call("nvim_command", ["edit author.txt"]);
      await waitFor(() => mapped(nvim, "u"));
      await luaEval(
        nvim,
        `(function() vim.ui.select = function(choices, _, cb)
  vim.g.picked_n = #choices
  for i, c in ipairs(choices) do if c == "second on two" then return cb(c, i) end end
  cb(nil, nil) end end)()`,
      );
      await nvim.call("nvim_win_set_cursor", [0, [2, 0]]);
      await nvim.call("nvim_input", ["<Plug>(glean-comment-delete)"]);
      await waitFor(async () => !(await has("second on two")));
      expect(await luaEval<number>(nvim, "vim.g.picked_n")).toBe(2);
      expect(await has("about two")).toBe(true);
      await undoDepth(nvim, 1);

      // u restores it without touching text; <C-r> removes it again.
      const text = await nvim.call("nvim_buf_get_lines", [0, 0, -1, false]);
      await nvim.call("nvim_input", ["u"]);
      await waitFor(() => has("second on two"));
      expect(await nvim.call("nvim_buf_get_lines", [0, 0, -1, false])).toEqual(
        text,
      );
      await undoDepth(nvim, 0, 1);
      await nvim.call("nvim_input", ["<C-r>"]);
      await waitFor(async () => !(await has("second on two")));
      expect((await recs()).length).toBe(1);
    });
  });
});
