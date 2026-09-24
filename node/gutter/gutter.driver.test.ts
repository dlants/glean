import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import {
  luaEval,
  pollUntil,
  sleep,
  startBackend,
  startNvim,
  withNvim,
} from "../test/driver.ts";
import { makeRepo } from "../test/repo.ts";

const UNSEEN =
  "2:GleanGutterChange 3:GleanGutterContextSeen 4:GleanGutterAdd 5:GleanGutterAdd";
const ROW4_SEEN =
  "2:GleanGutterChange 3:GleanGutterContextSeen 4:GleanGutterAddSeen 5:GleanGutterAdd";

let template: ReturnType<typeof makeRepo> | undefined;
/** Tests edit the work tree, so each gets a copy of one template repo. */
function repo() {
  template ??= makeRepo([
    { files: { "f.txt": "one\ntwo\nthree\n", "d.txt": "a\nb\nc\nd\ne\n" } },
    { msg: "c1", files: { "f.txt": "one\ntwo\nthree\nfour\n" } },
  ]);
  const root = mkdtempSync(join(tmpdir(), "glean-gutter-repo-"));
  cpSync(template.root, root, { recursive: true });
  writeFileSync(join(root, "f.txt"), "one\ntwo more\nthree\nfour\nfive\n");
  writeFileSync(join(root, "d.txt"), "a\nd\ne\n");
  return { root, shas: template.shas };
}

/** Sorted "lnum:hl" of the gutter namespace in the current buffer. */
const signs = (nvim: Nvim, ns = "glean_gutter", field = "sign_hl_group") =>
  luaEval<string>(
    nvim,
    `(function()
  local ns = vim.api.nvim_create_namespace(${JSON.stringify(ns)})
  local out = {}
  for _, m in ipairs(vim.api.nvim_buf_get_extmarks(0, ns, 0, -1, { details = true })) do
    out[#out + 1] = (m[2] + 1) .. ":" .. vim.trim(m[4].${field})
  end
  table.sort(out)
  return table.concat(out, " ")
end)()`,
  );
const waitSigns = (nvim: Nvim, want: string, ns?: string, field?: string) =>
  pollUntil(async () =>
    (await signs(nvim, ns, field)) === want ? true : undefined,
  );

async function openFile(nvim: Nvim, preamble = "") {
  const r = repo();
  const stateDir = mkdtempSync(join(tmpdir(), "glean-gutter-"));
  await luaEval(
    nvim,
    `(function() vim.cmd.cd(${JSON.stringify(r.root)}); vim.g.glean_state_dir = ${JSON.stringify(stateDir)}; vim.g.glean_poll_ms = 30; ${preamble} end)()`,
  );
  if ((await luaEval(nvim, "vim.g.glean_node_channel")) === null)
    await startBackend(nvim);
  await nvim.call("nvim_command", [`Glean open ${r.shas[0]}`]);
  await pollUntil(async () =>
    (
      await luaEval<string[]>(
        nvim,
        "vim.api.nvim_buf_get_lines(0, 0, -1, false)",
      )
    ).some((l) => l.includes("f.txt"))
      ? true
      : undefined,
  );
  await nvim.call("nvim_command", ["edit f.txt"]);
  await waitSigns(nvim, UNSEEN);
  return r;
}
const input = async (nvim: Nvim, keys: string) => {
  await nvim.call("nvim_input", [keys]);
};
const cursor = (nvim: Nvim, row: number) =>
  nvim.call("nvim_win_set_cursor", [0, [row, 0]]);

describe("file-buffer gutter (driver)", () => {
  // One nvim and backend for the tests that leave both running; each wipes
  // the previous test's buffers (closing its review) and opens a fresh repo.
  let shared: Awaited<ReturnType<typeof startNvim>>;
  beforeAll(async () => {
    shared = await startNvim();
    await startBackend(shared.nvim);
    // A first open pays for the template repo and the backend's cold module
    // loads; do it here so no test carries that cost.
    await openFile(shared.nvim);
  });
  afterAll(() => shared.close());
  const withShared = async (fn: (nvim: Nvim) => Promise<void>) => {
    await shared.nvim.call("nvim_command", ["silent! %bwipe!"]);
    await fn(shared.nvim);
  };
  it("paints, goes stale on edit, and repaints on revert", async () => {
    await withShared(async (nvim) => {
      await openFile(nvim);
      await nvim.call("nvim_buf_set_lines", [0, 0, 1, false, ["ONE"]]);
      await nvim.call("nvim_exec_autocmds", ["TextChanged", { buffer: 0 }]);
      await waitSigns(
        nvim,
        "2:GleanGutterStale 3:GleanGutterStale 4:GleanGutterStale 5:GleanGutterStale",
      );
      await nvim.call("nvim_command", ["silent edit!"]);
      await waitSigns(nvim, UNSEEN);
    });
  });
  it("marks with gmm/gm2j, and u/<C-r> ride the mark stack", async () => {
    await withShared(async (nvim) => {
      await openFile(nvim);
      await cursor(nvim, 4);
      await input(nvim, "gmm");
      await waitSigns(nvim, ROW4_SEEN);
      await cursor(nvim, 1);
      await pollUntil(async () =>
        (await luaEval<{ undo: number } | null>(nvim, "vim.b.glean_undo"))
          ?.undo === 1
          ? true
          : undefined,
      );
      await input(nvim, "u");
      await waitSigns(nvim, UNSEEN);
      await pollUntil(async () =>
        (await luaEval<number[]>(nvim, "vim.api.nvim_win_get_cursor(0)"))[0] ===
        4
          ? true
          : undefined,
      );
      await pollUntil(async () =>
        (await luaEval<{ redo: number } | null>(nvim, "vim.b.glean_undo"))
          ?.redo === 1
          ? true
          : undefined,
      );
      await input(nvim, "<C-r>");
      await waitSigns(nvim, ROW4_SEEN);
      await cursor(nvim, 2);
      await input(nvim, "gm2j");
      await waitSigns(
        nvim,
        "2:GleanGutterChangeSeen 3:GleanGutterContextSeen 4:GleanGutterAddSeen 5:GleanGutterAdd",
      );
    });
  });
  it("a write reconciles the model, and a novel edit wipes the mark stack", async () => {
    await withShared(async (nvim) => {
      await openFile(nvim);
      await nvim.call("nvim_buf_set_lines", [0, 4, 5, false, ["five edited"]]);
      await nvim.call("nvim_command", ["silent write"]);
      await cursor(nvim, 5);
      await pollUntil(async () =>
        (
          await luaEval<string>(
            nvim,
            `vim.inspect(require("glean.api").hunks(require("glean.api").sessions()[1].id))`,
          )
        ).includes("five edited")
          ? true
          : undefined,
      );
      await input(nvim, "gmm");
      await waitSigns(
        nvim,
        "2:GleanGutterChange 3:GleanGutterContextSeen 4:GleanGutterAdd 5:GleanGutterAddSeen",
      );
      await input(nvim, "A x<Esc>");
      await input(nvim, "u");
      await pollUntil(async () =>
        (await luaEval<boolean>(nvim, "vim.bo.modified")) ? undefined : true,
      );
      await nvim.call("nvim_exec_autocmds", ["BufWritePost", { buffer: 0 }]);
      // Nothing to wait on for "the mark survived": give the backend a few
      // poll ticks (glean_poll_ms = 30) to wrongly wipe it.
      await sleep(150);
      expect(await signs(nvim)).toContain("5:GleanGutterAddSeen");
    });
  });
  it("gmc marks the hunk and the focus overlay covers it", async () => {
    await withShared(async (nvim) => {
      await openFile(nvim);
      await cursor(nvim, 4);
      await waitSigns(
        nvim,
        "2:█ 3:▎ 4:█ 5:█",
        "glean_gutter_focus",
        "sign_text",
      );
      await cursor(nvim, 3);
      await waitSigns(nvim, "", "glean_gutter_focus", "sign_text");
      await cursor(nvim, 2);
      await input(nvim, "gmc");
      await waitSigns(
        nvim,
        "2:GleanGutterChangeSeen 3:GleanGutterContextSeen 4:GleanGutterAddSeen 5:GleanGutterAddSeen",
      );
    });
  });
  it("uncommitted deletions, ]c, and per-buffer/global toggles", async () => {
    await withShared(async (nvim) => {
      await openFile(nvim);
      await cursor(nvim, 1);
      await input(nvim, "]c");
      await pollUntil(async () =>
        (await luaEval<number[]>(nvim, "vim.api.nvim_win_get_cursor(0)"))[0] ===
        2
          ? true
          : undefined,
      );
      await input(nvim, "gt");
      await waitSigns(nvim, "");
      await input(nvim, "gt");
      await waitSigns(nvim, UNSEEN);
      await nvim.call("nvim_command", ["Glean toggle-gutter"]);
      await waitSigns(nvim, "");
      await nvim.call("nvim_command", ["Glean toggle-gutter"]);
      await waitSigns(nvim, UNSEEN);
      await nvim.call("nvim_command", ["edit d.txt"]);
      await waitSigns(nvim, "1:GleanGutterDelete");
      await nvim.call("nvim_command", ["1Glean toggle-mark"]);
      await waitSigns(nvim, "1:GleanGutterDeleteSeen");
    });
  });
  it("suppresses the foreign provider and reattaches on backend exit", async () => {
    await withNvim(async (nvim) => {
      await openFile(
        nvim,
        `vim.g.calls = {}
require("glean.node_gutter").setup({ suppress = {
  detach = function(b) local c = vim.g.calls; c[#c + 1] = "detach"; vim.g.calls = c end,
  attach = function(b) local c = vim.g.calls; c[#c + 1] = "attach"; vim.g.calls = c end,
} })`,
      );
      expect(await luaEval<string[]>(nvim, "vim.g.calls")).toContain("detach");
      await luaEval(nvim, `vim.fn.jobstop(require("glean.node").job_id)`);
      await pollUntil(async () =>
        (await luaEval<string[]>(nvim, "vim.g.calls")).at(-1) === "attach"
          ? true
          : undefined,
      );
      expect(await signs(nvim)).toBe("");
    });
  });
});
