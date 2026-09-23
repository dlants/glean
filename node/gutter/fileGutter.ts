/**
 * The gutter in ordinary file buffers, driven by Lua events. Node owns the
 * projection, painting, marking and the mark undo stacks; Lua only forwards
 * events and hosts the foreign sign provider detach/reattach
 * (`glean.node_gutter`). Events are handled one at a time, in order.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { RepoPath } from "../core/types.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { SeenPlan } from "../render/actions.ts";
import { splitLines } from "../session/model.ts";
import type { Session } from "../session/session.ts";
import { MAX_BATCH_CALLS } from "../view/view.ts";
import { BufUndo } from "./bufUndo.ts";
import { fileStatus, planFileMarks } from "./marking.ts";
import {
  type GutterKind,
  type GutterMarks,
  hunkRange,
  hunkStarts,
  nextHunkRow,
} from "./project.ts";

export type GutterEvent =
  | { kind: "refresh"; buf: number }
  | { kind: "focus"; buf: number; row: number }
  | { kind: "toggle-mark"; buf: number; line1: number; line2?: number }
  | { kind: "goto-hunk"; buf: number; row: number; dir: 1 | -1 }
  | { kind: "undo" | "redo"; buf: number; seq: number }
  | { kind: "toggle"; buf: number }
  | { kind: "wipe"; buf: number };

export function parseGutterEvent(v: unknown): GutterEvent | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const buf = o.buf;
  if (typeof buf !== "number") return undefined;
  const num = (k: string) => (typeof o[k] === "number" ? o[k] : undefined);
  switch (o.kind) {
    case "refresh":
    case "toggle":
    case "wipe":
      return { kind: o.kind, buf };
    case "focus": {
      const row = num("row");
      return row === undefined ? undefined : { kind: "focus", buf, row };
    }
    case "toggle-mark": {
      const line1 = num("line1");
      if (line1 === undefined) return undefined;
      const line2 = num("line2");
      return line2 === undefined
        ? { kind: "toggle-mark", buf, line1 }
        : { kind: "toggle-mark", buf, line1, line2 };
    }
    case "goto-hunk": {
      const row = num("row");
      const dir = o.dir === -1 ? -1 : o.dir === 1 ? 1 : undefined;
      return row === undefined || dir === undefined
        ? undefined
        : { kind: "goto-hunk", buf, row, dir };
    }
    case "undo":
    case "redo": {
      const seq = num("seq");
      return seq === undefined ? undefined : { kind: o.kind, buf, seq };
    }
    default:
      return undefined;
  }
}

type BufInfo = {
  buf: number;
  name: string;
  modified: boolean;
  lines: number;
  cursor: number | undefined;
  seq: number;
  focus: boolean;
};
function parseInfos(v: unknown): BufInfo[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x: Record<string, unknown>) =>
    typeof x.buf === "number" &&
    typeof x.name === "string" &&
    typeof x.lines === "number" &&
    typeof x.seq === "number"
      ? [
          {
            buf: x.buf,
            name: x.name,
            modified: x.modified === true,
            lines: x.lines,
            cursor: typeof x.cursor === "number" ? x.cursor : undefined,
            seq: x.seq,
            focus: x.focus !== false,
          },
        ]
      : [],
  );
}

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

type Painted = { path: RepoPath; marks: GutterMarks; stale: boolean };
type MarkUndo = { plan: SeenPlan; cursor: number };

export class FileGutter {
  enabled = true;
  private readonly off = new Set<number>();
  private readonly painted = new Map<number, Painted>();
  private readonly members = new Set<number>();
  readonly undo = new BufUndo<MarkUndo>();
  private chain: Promise<void> = Promise.resolve();
  private ns = 0;
  private nsFocus = 0;

  constructor(
    private readonly nvim: Nvim,
    private readonly session: () => Session | undefined,
  ) {}

  async init() {
    this.ns = await this.nvim.call("nvim_create_namespace", ["glean_gutter"]);
    this.nsFocus = await this.nvim.call("nvim_create_namespace", [
      "glean_gutter_focus",
    ]);
  }

  /** Serialized: a repaint never interleaves with another. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn).catch((err: unknown) => {
      this.nvim.logger.error(err instanceof Error ? err : String(err));
    });
    return this.chain;
  }

  handle(ev: GutterEvent): Promise<void> {
    return this.enqueue(() => this.run(ev));
  }
  /** Repaint every loaded named buffer (the model moved). */
  refreshAll(): Promise<void> {
    return this.enqueue(() => this.repaint(undefined));
  }
  setEnabled(on: boolean): Promise<void> {
    this.enabled = on;
    if (on) this.off.clear();
    return this.refreshAll();
  }

  private async run(ev: GutterEvent): Promise<void> {
    switch (ev.kind) {
      case "refresh":
        return this.repaint([ev.buf]);
      case "focus": {
        const p = this.painted.get(ev.buf);
        const [info] = await this.infos([ev.buf]);
        if (!info) return;
        await this.atomic(this.focusCalls(info, p));
        return;
      }
      case "toggle":
        if (!this.off.has(ev.buf) && this.members.has(ev.buf))
          this.off.add(ev.buf);
        else this.off.delete(ev.buf);
        return this.repaint([ev.buf]);
      case "wipe":
        this.off.delete(ev.buf);
        this.painted.delete(ev.buf);
        this.members.delete(ev.buf);
        this.undo.drop(ev.buf);
        return;
      case "goto-hunk": {
        const p = this.painted.get(ev.buf);
        const [info] = await this.infos([ev.buf]);
        if (!p || !info) return;
        const row = nextHunkRow(hunkStarts(p.marks, true), ev.row, ev.dir);
        if (row === undefined || row > info.lines) return;
        await this.park(ev.buf, row);
        return;
      }
      case "toggle-mark":
        return this.toggleMark(ev.buf, ev.line1, ev.line2);
      case "undo":
      case "redo":
        return this.step(ev.kind, ev.buf, ev.seq);
    }
  }

  private async infos(bufs: number[] | undefined): Promise<BufInfo[]> {
    return parseInfos(
      await this.nvim.call("nvim_exec_lua", [
        `return require("glean.node_gutter").info(...)`,
        [bufs ?? null],
      ]),
    );
  }

  private relPath(name: string): RepoPath | undefined {
    const s = this.session();
    if (!s || !s.worktree || name === "") return undefined;
    const rel = relative(s.repoRoot, resolve(name));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
    return rel as RepoPath;
  }

  private statusFor(buf: number, name: string) {
    if (!this.enabled || this.off.has(buf)) return undefined;
    const path = this.relPath(name);
    const cls = this.session()?.current?.cls;
    if (!path || !cls) return undefined;
    const marks = fileStatus(cls, path);
    return marks && { path, marks };
  }

  private async repaint(bufs: number[] | undefined) {
    const calls: unknown[] = [];
    for (const info of await this.infos(bufs)) {
      const { buf } = info;
      const st = this.statusFor(buf, info.name);
      // Membership (not paintedness) owns the maps and the sign column, so a
      // momentarily modified file keeps both.
      if (st) {
        this.members.add(buf);
        calls.push(lua(`require("glean.node_gutter").attach(...)`, [buf]));
      } else if (this.members.delete(buf)) {
        calls.push(lua(`require("glean.node_gutter").detach(...)`, [buf]));
      }
      const had = this.painted.delete(buf);
      if (had || st)
        calls.push(
          ["nvim_buf_clear_namespace", [buf, this.ns, 0, -1]],
          ["nvim_buf_clear_namespace", [buf, this.nsFocus, 0, -1]],
        );
      if (!st || st.marks.size === 0) continue;
      const p = { ...st, stale: info.modified };
      this.painted.set(buf, p);
      for (const [lnum, m] of st.marks) {
        if (lnum < 1 || lnum > info.lines) continue;
        calls.push([
          "nvim_buf_set_extmark",
          [
            buf,
            this.ns,
            lnum - 1,
            0,
            p.stale
              ? { sign_text: STALE_GLYPH, sign_hl_group: "GleanGutterStale" }
              : {
                  sign_text: GLYPH[m.kind],
                  sign_hl_group: GROUP[m.kind] + (m.seen ? "Seen" : ""),
                },
          ],
        ]);
      }
      calls.push(...this.focusCalls(info, p));
    }
    await this.atomic(calls);
  }

  private focusCalls(info: BufInfo, p: Painted | undefined): unknown[] {
    const calls: unknown[] = [
      ["nvim_buf_clear_namespace", [info.buf, this.nsFocus, 0, -1]],
    ];
    if (!p || p.stale || !info.focus || info.cursor === undefined) return calls;
    const range = hunkRange(p.marks, info.cursor);
    if (!range) return calls;
    // The model can lag the buffer, so rows are clamped to what it has.
    for (
      let l = Math.max(range.lo, 1);
      l <= Math.min(range.hi, info.lines);
      l++
    ) {
      const m = p.marks.get(l);
      if (!m) continue;
      calls.push([
        "nvim_buf_set_extmark",
        [
          info.buf,
          this.nsFocus,
          l - 1,
          0,
          {
            sign_text: FOCUS_GLYPH[m.kind],
            sign_hl_group: GROUP[m.kind] + (m.seen ? "Seen" : ""),
            priority: FOCUS_PRIORITY,
          },
        ],
      ]);
    }
    return calls;
  }

  private async atomic(calls: unknown[]) {
    for (let i = 0; i < calls.length; i += MAX_BATCH_CALLS)
      await this.nvim.call("nvim_call_atomic", [
        calls.slice(i, i + MAX_BATCH_CALLS) as never,
      ]);
  }

  private warn(msg: string) {
    return this.nvim.call("nvim_notify", [`glean: ${msg}`, 3, {}]);
  }

  /** Move the cursor (with a jumplist entry) if `buf` is still current. */
  private park(buf: number, row: number) {
    return this.nvim.call("nvim_exec_lua", [
      `local buf, row = ...
if vim.api.nvim_get_current_buf() ~= buf then return end
vim.cmd("normal! m'")
vim.api.nvim_win_set_cursor(0, { math.min(row, vim.api.nvim_buf_line_count(buf)), 0 })`,
      [buf, row],
    ]);
  }

  private async syncUndoVar(buf: number) {
    const d = this.undo.depth(buf);
    if (d) await this.nvim.call("nvim_buf_set_var", [buf, "glean_undo", d]);
  }

  /**
   * `:Glean toggle-mark`. A modified buffer, or one whose text is not the
   * work tree the model was built from, is refused: its rows would name
   * lines the reviewer is not looking at.
   */
  private async toggleMark(buf: number, line1: number, line2?: number) {
    const s = this.session();
    if (!s?.worktree) return void (await this.warn("no live work-tree review"));
    const [info] = await this.infos([buf]);
    if (!info) return;
    if (info.modified)
      return void (await this.warn("buffer is modified; write it first"));
    const path = this.relPath(info.name);
    if (!path)
      return void (await this.warn(
        "buffer is not a file in the review's repo",
      ));
    // One immediate poll first, so a write the timer hasn't seen yet lands
    // in the model before rows are resolved against it.
    await s.pokePoll();
    const [bufLines, disk] = await Promise.all([
      this.nvim.call("nvim_buf_get_lines", [buf, 0, -1, false]),
      readFile(resolve(s.repoRoot, path), "utf8").then(splitLines, () => []),
    ]);
    const lines = bufLines as string[];
    if (lines.length !== disk.length || lines.some((l, i) => l !== disk[i]))
      return void (await this.warn(
        "review is out of date for this file; refreshing, try again",
      ));
    const cls = s.current?.cls;
    if (!cls) return;
    const r = planFileMarks(
      cls,
      path,
      line1,
      line2 ?? line1,
      line2 === undefined,
    );
    if (r.kind === "inert") return void (await this.warn(r.reason));
    await s.applySeen(r.plan.ids, r.plan.op, r.plan.sticky);
    this.undo.push(buf, info.seq, {
      plan: r.plan,
      cursor: Math.min(line1, line2 ?? line1),
    });
    await this.syncUndoVar(buf);
  }

  private async step(dir: "undo" | "redo", buf: number, seq: number) {
    const s = this.session();
    const a =
      dir === "undo" ? this.undo.undo(buf, seq) : this.undo.redo(buf, seq);
    await this.syncUndoVar(buf);
    if (!a || !s) return;
    const { plan } = a;
    const op =
      dir === "redo" ? plan.op : plan.op === "mark" ? "unmark" : "mark";
    await s.applySeen(plan.ids, op, plan.sticky);
    await this.park(buf, a.cursor);
  }
}

function lua(code: string, args: unknown[]): unknown {
  return ["nvim_exec_lua", [code, args]];
}
