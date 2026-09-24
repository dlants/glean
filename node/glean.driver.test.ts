import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import { luaEval, pollUntil, startBackend, withNvim } from "./test/driver.ts";
import { makeRepo } from "./test/repo.ts";

describe("node bridge", () => {
  it(":Glean ping reaches node and node answers", async () => {
    await withNvim(async (nvim) => {
      await startBackend(nvim);
      await nvim.call("nvim_command", ["Glean ping"]);
      const pongs = await pollUntil(() =>
        luaEval<number | null>(nvim, "vim.g.glean_pong").then(
          (p) => p ?? undefined,
        ),
      );
      expect(pongs).toBe(1);
    });
  });

  it("killing node tears down the bridge and leaves nvim usable", async () => {
    await withNvim(async (nvim) => {
      await startBackend(nvim);
      const pid = await luaEval<number>(
        nvim,
        `vim.fn.jobpid(require("glean.rpc-bridge").job_id)`,
      );
      process.kill(pid, "SIGKILL");
      await pollUntil(async () =>
        (await luaEval<number>(nvim, `vim.fn.exists(":Glean")`)) === 0
          ? true
          : undefined,
      );
      expect(await luaEval<null>(nvim, "vim.g.glean_node_channel")).toBe(null);
      expect(await nvim.call("nvim_eval", ["1 + 1"])).toBe(2);
      // A late event against the dead channel must not raise.
      expect(
        await luaEval<boolean>(
          nvim,
          `require("glean.rpc-bridge").notify("gleanCommand", {})`,
        ),
      ).toBe(false);
    });
  });
});
describe("review targets (driver)", () => {
  const setup = async (nvim: Nvim, root: string) => {
    const stateDir = mkdtempSync(join(tmpdir(), "glean-targets-"));
    await luaEval(
      nvim,
      `(function() vim.cmd.cd(${JSON.stringify(root)}); vim.g.glean_state_dir = ${JSON.stringify(stateDir)} end)()`,
    );
    await startBackend(nvim);
  };
  const bufName = () =>
    "vim.fn.fnamemodify(vim.api.nvim_buf_get_name(0), ':t')";
  const lines = (nvim: Nvim) =>
    luaEval<string[]>(nvim, "vim.api.nvim_buf_get_lines(0, 0, -1, false)");

  it(":Glean log → <CR> opens the selected commit, one review at a time", async () => {
    const repo = makeRepo([
      { files: { "a.txt": "1\n" } },
      { msg: "c1: one", files: { "a.txt": "ONE\n" } },
      { msg: "c2: two", files: { "b.txt": "B\n" } },
    ]);
    await withNvim(async (nvim) => {
      await setup(nvim, repo.root);
      await nvim.call("nvim_command", ["Glean log"]);
      const log = await pollUntil(async () => {
        const l = await lines(nvim);
        return l[0]?.startsWith("Glean log") ? l : undefined;
      });
      expect(log[1]).toContain("uncommitted changes");
      expect(log[2]).toContain("c2: two");
      expect(await luaEval<string>(nvim, bufName())).toBe(
        `Glean:${basename(repo.root)} log`,
      );
      // Row 4 is c1: its review contains only a.txt.
      await nvim.call("nvim_win_set_cursor", [0, [4, 0]]);
      await nvim.call("nvim_input", ["<CR>"]);
      const body = await pollUntil(async () => {
        const l = await lines(nvim);
        return l.some((s) => s.includes("ONE")) ? l : undefined;
      });
      expect(body.join("\n")).not.toContain("b.txt");
      const short = repo.shas[1]?.slice(0, 8);
      expect(await luaEval<string>(nvim, bufName())).toContain(`${short} [`);
    });
  });
});
describe("navigation and jump (driver)", () => {
  const setup = async (nvim: Nvim, root: string) => {
    const stateDir = mkdtempSync(join(tmpdir(), "glean-jump-"));
    await luaEval(
      nvim,
      `(function() vim.cmd.cd(${JSON.stringify(root)}); vim.g.glean_state_dir = ${JSON.stringify(stateDir)} end)()`,
    );
    await startBackend(nvim);
  };
  const lines = (nvim: Nvim) =>
    luaEval<string[]>(nvim, "vim.api.nvim_buf_get_lines(0, 0, -1, false)");
  const cursor = (nvim: Nvim) =>
    luaEval<number>(nvim, "vim.api.nvim_win_get_cursor(0)[1]");
  it("]c / [c step between hunks and vac selects a hunk", async () => {
    const repo = makeRepo([
      { files: { "j.txt": "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n" } },
      { msg: "c1", files: { "j.txt": "a\nB\nc\nd\ne\nf\ng\nh\ni\nJ\nk\n" } },
    ]);
    await withNvim(async (nvim) => {
      await setup(nvim, repo.root);
      await nvim.call("nvim_command", [`Glean ${repo.shas[0]} HEAD`]);
      const body = await pollUntil(async () => {
        const l = await lines(nvim);
        return l.includes("J") ? l : undefined;
      });
      // ]c from the top lands on the first hunk header, again on the second.
      await nvim.call("nvim_win_set_cursor", [0, [1, 0]]);
      await nvim.call("nvim_input", ["]c"]);
      const h1 = await pollUntil(async () => {
        const r = await cursor(nvim);
        return r > 1 ? r : undefined;
      });
      expect(body[h1 - 1]).toMatch(/@@/);
      await nvim.call("nvim_input", ["]c"]);
      const h2 = await pollUntil(async () => {
        const r = await cursor(nvim);
        return r > h1 ? r : undefined;
      });
      expect(body[h2 - 1]).toMatch(/@@/);
      await nvim.call("nvim_input", ["[c"]);
      await pollUntil(async () =>
        (await cursor(nvim)) === h1 ? true : undefined,
      );
      // `vac` selects the whole hunk linewise.
      await nvim.call("nvim_input", ["vac"]);
      const sel = await pollUntil(async () => {
        const s = await luaEval<[string, number, number]>(
          nvim,
          `{ vim.api.nvim_get_mode().mode, vim.fn.line("v"), vim.fn.line(".") }`,
        );
        return s[0] === "V" ? s : undefined;
      });
      expect(sel[1]).toBe(h1);
      expect(sel[2]).toBeGreaterThan(h1);
      await nvim.call("nvim_input", ["<Esc>"]);
    });
  });
  it("<CR> jumps into the file and :Glean jump comes back", async () => {
    const repo = makeRepo([
      { files: { "j.txt": "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n" } },
      { msg: "c1", files: { "j.txt": "a\nB\nc\nd\ne\nf\ng\nh\ni\nJ\nk\n" } },
    ]);
    await withNvim(async (nvim) => {
      await setup(nvim, repo.root);
      await nvim.call("nvim_command", [`Glean ${repo.shas[0]} HEAD`]);
      const body = await pollUntil(async () => {
        const l = await lines(nvim);
        return l.includes("J") ? l : undefined;
      });
      const reviewBuf = await luaEval<number>(
        nvim,
        "vim.api.nvim_get_current_buf()",
      );
      // <CR> on the +J row opens the live file at line 10.
      const jRow = body.indexOf("J") + 1;
      await nvim.call("nvim_win_set_cursor", [0, [jRow, 0]]);
      await nvim.call("nvim_input", ["<CR>"]);
      const name = await pollUntil(async () => {
        const n = await luaEval<string>(nvim, "vim.api.nvim_buf_get_name(0)");
        return n.endsWith("/j.txt") ? n : undefined;
      });
      expect(name.startsWith("glean://")).toBe(false);
      expect(await cursor(nvim)).toBe(10);
      // Back from the file: the review cursor lands on the same line.
      await nvim.call("nvim_win_set_cursor", [0, [2, 0]]);
      await nvim.call("nvim_command", ["Glean jump"]);
      await pollUntil(async () =>
        (await luaEval<number>(nvim, "vim.api.nvim_get_current_buf()")) ===
        reviewBuf
          ? true
          : undefined,
      );
      const row = await pollUntil(async () => {
        const r = await cursor(nvim);
        return body[r - 1] === "b" ? r : undefined;
      });
      // The deleted `b` sits at post-image slot 2 and precedes `B`: as in Lua,
      // the earlier of the tied rows wins.
      expect(body[row]).toBe("B");
    });
  });
  it("D opens a base/live diffsplit", async () => {
    const repo = makeRepo([
      { files: { "j.txt": "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n" } },
      { msg: "c1", files: { "j.txt": "a\nB\nc\nd\ne\nf\ng\nh\ni\nJ\nk\n" } },
    ]);
    await withNvim(async (nvim) => {
      await setup(nvim, repo.root);
      await nvim.call("nvim_command", [`Glean ${repo.shas[0]} HEAD`]);
      const body = await pollUntil(async () => {
        const l = await lines(nvim);
        return l.includes("J") ? l : undefined;
      });
      await nvim.call("nvim_win_set_cursor", [0, [body.indexOf("b") + 1, 0]]);
      // D opens base on the left, the live file on the right, both in diff mode.
      await nvim.call("nvim_input", ["D"]);
      const wins = await pollUntil(async () => {
        const w = await luaEval<{ name: string; diff: boolean; col: number }[]>(
          nvim,
          `vim.tbl_map(function(w) return { name = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(w)), diff = vim.wo[w].diff, col = vim.api.nvim_win_get_position(w)[2] } end, vim.api.nvim_tabpage_list_wins(0))`,
        );
        return w.filter((x) => x.diff).length === 2 ? w : undefined;
      });
      const diffs = wins.filter((w) => w.diff).sort((a, b) => a.col - b.col);
      expect(diffs[0]?.name).toContain(
        `glean://${repo.shas[0]?.slice(0, 8)}:j.txt`,
      );
      expect(diffs[1]?.name.endsWith("/j.txt")).toBe(true);
    });
  });
});

describe("seen extras and whitespace (driver)", () => {
  const setup = async (nvim: Nvim, root: string) => {
    const stateDir = mkdtempSync(join(tmpdir(), "glean-ws-"));
    await luaEval(
      nvim,
      `(function() vim.cmd.cd(${JSON.stringify(root)}); vim.g.glean_state_dir = ${JSON.stringify(stateDir)} end)()`,
    );
    await startBackend(nvim);
  };
  const lines = (nvim: Nvim) =>
    luaEval<string[]>(nvim, "vim.api.nvim_buf_get_lines(0, 0, -1, false)");
  const floats = (nvim: Nvim) =>
    luaEval<string[][]>(
      nvim,
      `vim.tbl_map(function(w) return vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(w), 0, -1, false) end, vim.tbl_filter(function(w) return vim.api.nvim_win_get_config(w).relative ~= "" end, vim.api.nvim_list_wins()))`,
    );
  it("the sticky float follows the topline and closes when the review is hidden", async () => {
    const base = Array.from({ length: 80 }, (_, i) => `line${i + 1}`);
    const edited = base.map((l, i) => (i >= 9 && i < 70 ? `${l}_Z` : l));
    const repo = makeRepo([
      { files: { "s.txt": `${base.join("\n")}\n` } },
      { msg: "tall", files: { "s.txt": `${edited.join("\n")}\n` } },
    ]);
    await withNvim(async (nvim) => {
      await setup(nvim, repo.root);
      await nvim.call("nvim_command", [`Glean ${repo.shas[0]} HEAD`]);
      const body = await pollUntil(async () => {
        const l = await lines(nvim);
        return l.includes("line40_Z") ? l : undefined;
      });
      const hunk = body.findIndex((l) => l.includes("@@"));
      const fileRow = body.findIndex((l) => l.includes("s.txt"));
      await luaEval(nvim, `(function() vim.wo.scrolloff = 0 end)()`);
      await nvim.call("nvim_win_set_height", [0, 10]);
      await nvim.call("nvim_win_set_cursor", [0, [1, 0]]);
      await nvim.call("nvim_input", ["j"]);
      await pollUntil(async () =>
        (await floats(nvim)).length === 0 ? true : undefined,
      );
      // Scroll the hunk's headers out of view: summary, file and hunk pin.
      const scrollTo = async (top: number) =>
        luaEval(
          nvim,
          `(function() vim.fn.winrestview({ topline = ${top}, lnum = ${top} }) end)()`,
        );
      await scrollTo(hunk + 31);
      const f1 = await pollUntil(async () => {
        const f = await floats(nvim);
        return f.length === 1 ? f[0] : undefined;
      });
      expect(f1).toEqual([body[0], body[fileRow], body[hunk]]);
      // The active hunk carries the gutter bar and, after the delay, the indent.
      const marks = await pollUntil(async () => {
        const m = await luaEval<number>(
          nvim,
          `#vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace("glean-review-cursor-indent"), 0, -1, {})`,
        );
        return m > 0 ? m : undefined;
      });
      expect(marks).toBeGreaterThan(60);
      // Back at the top the float closes.
      await scrollTo(1);
      await pollUntil(async () =>
        (await floats(nvim)).length === 0 ? true : undefined,
      );
      await scrollTo(hunk + 31);
      await pollUntil(async () =>
        (await floats(nvim)).length === 1 ? true : undefined,
      );
      // A float closed from outside is reopened by the next paint.
      await luaEval(
        nvim,
        `(function() for _, w in ipairs(vim.api.nvim_list_wins()) do if vim.api.nvim_win_get_config(w).relative ~= "" then vim.api.nvim_win_close(w, true) end end end)()`,
      );
      await scrollTo(hunk + 33);
      await pollUntil(async () =>
        (await floats(nvim)).length === 1 ? true : undefined,
      );
      // Hiding the review (another buffer in its window) closes it.
      await nvim.call("nvim_command", ["enew"]);
      await pollUntil(async () =>
        (await floats(nvim)).length === 0 ? true : undefined,
      );
    });
  });
  it("a superseded hunk indent is dropped; only the latest hunk is indented", async () => {
    const base = Array.from({ length: 40 }, (_, i) => `l${i + 1}`);
    const edited = base.map((l, i) => (i === 3 || i === 30 ? `${l}_Z` : l));
    const repo = makeRepo([
      { files: { "h.txt": `${base.join("\n")}\n` } },
      { msg: "two", files: { "h.txt": `${edited.join("\n")}\n` } },
    ]);
    await withNvim(async (nvim) => {
      await luaEval(
        nvim,
        `(function() require("glean").config.hunk_indent_delay_ms = 50 end)()`,
      );
      await setup(nvim, repo.root);
      await nvim.call("nvim_command", [`Glean ${repo.shas[0]} HEAD`]);
      const body = await pollUntil(async () => {
        const l = await lines(nvim);
        return l.includes("l31_Z") ? l : undefined;
      });
      const a = body.indexOf("l4_Z");
      const b = body.indexOf("l31_Z");
      await nvim.call("nvim_win_set_cursor", [0, [a + 1, 0]]);
      await new Promise((r) => setTimeout(r, 20));
      await nvim.call("nvim_win_set_cursor", [0, [b + 1, 0]]);
      const rows = () =>
        luaEval<number[]>(
          nvim,
          `vim.tbl_map(function(m) return m[2] end, vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_create_namespace("glean-review-cursor-indent"), 0, -1, {}))`,
        );
      const marked = await pollUntil(async () => {
        const r = await rows();
        return r.length > 0 ? r : undefined;
      });
      // Outlast the delay so a stale timer for hunk A would have fired.
      await new Promise((r) => setTimeout(r, 100));
      expect(await rows()).toEqual(marked);
      const hunkB = body.lastIndexOf(
        body.filter((l) => l.includes("@@")).at(-1) ?? "",
      );
      for (const r of marked) expect(r).toBeGreaterThan(hunkB);
    });
  });
  it("U unmarks all; :e rebuilds in place", async () => {
    const repo = makeRepo([
      { files: { "w.txt": "a\nb\n1\n2\n3\n4\n5\n6\n7\n8\nd\n" } },
      {
        msg: "ws",
        files: { "w.txt": "a\n  b\n1\n2\n3\n4\n5\n6\n7\n8\nD\n" },
      },
    ]);
    await withNvim(async (nvim) => {
      await setup(nvim, repo.root);
      await nvim.call("nvim_command", [`Glean ${repo.shas[0]} HEAD`]);
      await pollUntil(async () => {
        const l = await lines(nvim);
        return l.includes("D") ? true : undefined;
      });
      const buf = await luaEval<number>(nvim, "vim.api.nvim_get_current_buf()");
      // m on the file header marks everything; U brings it all back.
      const header = (await lines(nvim)).findIndex((l) => l.includes("w.txt"));
      await nvim.call("nvim_win_set_cursor", [0, [header + 1, 0]]);
      await nvim.call("nvim_input", ["m"]);
      await pollUntil(async () =>
        (await lines(nvim)).includes("D") ? undefined : true,
      );
      await nvim.call("nvim_input", ["U"]);
      await pollUntil(async () =>
        (await lines(nvim)).includes("D") ? true : undefined,
      );
      // :e rebuilds in the same buffer (nvim has already blanked it and
      // parked the cursor on row 1 when BufReadCmd fires, as in Lua).
      await nvim.call("nvim_command", ["edit"]);
      await pollUntil(async () =>
        (await lines(nvim)).includes("D") ? true : undefined,
      );
      expect(
        await luaEval<number>(nvim, "vim.api.nvim_get_current_buf()"),
      ).toBe(buf);
    });
  });
});

describe("whitespace-hidden comments (driver)", () => {
  it("<CR> on a (hidden) summary comment restores exact mode and lands on it", async () => {
    const repo = makeRepo([
      { files: { "w.txt": "a\nb\nc\nd\n" } },
      { msg: "ws", files: { "w.txt": "a\n  b\nc\nD\n" } },
    ]);
    await withNvim(async (nvim) => {
      const stateDir = mkdtempSync(join(tmpdir(), "glean-wsc-"));
      await luaEval(
        nvim,
        `(function() vim.cmd.cd(${JSON.stringify(repo.root)}); vim.g.glean_state_dir = ${JSON.stringify(stateDir)} end)()`,
      );
      await startBackend(nvim);
      await luaEval(
        nvim,
        `require("glean.api").add_comment({ repo = ${JSON.stringify(repo.root)}, path = "w.txt", lnum = 2, text = "space note" })`,
      );
      const lines = () =>
        luaEval<string[]>(nvim, "vim.api.nvim_buf_get_lines(0, 0, -1, false)");
      await nvim.call("nvim_command", [`Glean ${repo.shas[0]} HEAD`]);
      await pollUntil(async () =>
        (await lines()).includes("  b") ? true : undefined,
      );
      await nvim.call("nvim_input", ["W"]);
      const ignored = await pollUntil(async () => {
        const l = await lines();
        return l[0]?.includes("ignore-whitespace") &&
          l.some((s) => s.includes("(hidden)"))
          ? l
          : undefined;
      });
      const row = ignored.findIndex((l) => l.includes("space note"));
      await nvim.call("nvim_win_set_cursor", [0, [row + 1, 0]]);
      await nvim.call("nvim_input", ["<CR>"]);
      await pollUntil(async () => {
        const l = await lines();
        const r = (await nvim.call("nvim_win_get_cursor", [0]))[0];
        return !l[0]?.includes("ignore-whitespace") &&
          l[r - 1]?.includes("space note") &&
          !l[r - 1]?.includes("(hidden)") &&
          l[r - 2] === "  b"
          ? true
          : undefined;
      });
    });
  });
});

describe("comment editor (driver)", () => {
  it("c / i / dd author, edit and delete comments, undoably", async () => {
    const repo = makeRepo([
      { files: { "f.txt": "one\ntwo\nthree\n" } },
      { msg: "c1", files: { "f.txt": "one\nTWO\nthree\n" } },
      { msg: "c2", files: { "f.txt": "one\nTWO\nTHREE\n" } },
    ]);
    await withNvim(async (nvim) => {
      const stateDir = mkdtempSync(join(tmpdir(), "glean-cm-"));
      await luaEval(
        nvim,
        `(function() vim.cmd.cd(${JSON.stringify(repo.root)}); vim.g.glean_state_dir = ${JSON.stringify(stateDir)} end)()`,
      );
      await startBackend(nvim);
      await nvim.call("nvim_command", [`Glean ${repo.shas[0]} HEAD`]);
      const rbuf = await pollUntil(async () => {
        const b = await luaEval<number>(nvim, "vim.api.nvim_get_current_buf()");
        return b > 1 ? b : undefined;
      });
      const lines = () =>
        luaEval<string[]>(
          nvim,
          `vim.api.nvim_buf_get_lines(${rbuf}, 0, -1, false)`,
        );
      const until = (p: (l: string[]) => boolean) =>
        pollUntil(async () => {
          const l = await lines();
          return p(l) ? l : undefined;
        });
      const has = (s: string) => (l: string[]) => l.some((x) => x.includes(s));
      const review = await luaEval<number>(
        nvim,
        "vim.api.nvim_get_current_win()",
      );
      const at = async (pred: (l: string) => boolean) => {
        await nvim.call("nvim_set_current_win", [review]);
        const row = (await lines()).findIndex(pred);
        expect(row).toBeGreaterThanOrEqual(0);
        await nvim.call("nvim_win_set_cursor", [review, [row + 1, 0]]);
      };
      const inEditor = async (text: string[]) => {
        await pollUntil(async () =>
          (
            await luaEval<string>(nvim, "vim.api.nvim_buf_get_name(0)")
          ).includes("glean-comment://")
            ? true
            : undefined,
        );
        await nvim.call("nvim_input", ["<Esc>"]);
        await nvim.call("nvim_buf_set_lines", [0, 0, -1, false, text]);
        await nvim.call("nvim_command", ["write"]);
      };
      await until((l) => l.includes("TWO"));

      // c: a multi-line comment renders across rows; u / <C-r> round-trip it.
      await at((l) => l === "TWO");
      await nvim.call("nvim_input", ["c"]);
      await inEditor(["first line", "second line"]);
      await until(
        (l) =>
          l.some((x) => /💬 \[\d+\] first line/.test(x)) &&
          l.includes("💬 second line"),
      );
      await at((l) => l === "TWO");
      await nvim.call("nvim_input", ["u"]);
      await until((l) => !has("first line")(l));
      await nvim.call("nvim_input", ["<C-r>"]);
      await until(has("first line"));

      // i: edit the comment under the cursor.
      await at((l) => /💬 \[\d+\] first line/.test(l));
      await nvim.call("nvim_input", ["i"]);
      await inEditor(["edited"]);
      await until((l) => has("edited")(l) && !has("first line")(l));

      // dd: delete it from its inline row; u restores.
      await at((l) => /💬 \[\d+\] edited/.test(l));
      await nvim.call("nvim_input", ["dd"]);
      await until((l) => !has("edited")(l));
      await nvim.call("nvim_input", ["u"]);
      await until(has("edited"));
    });
  });
});
