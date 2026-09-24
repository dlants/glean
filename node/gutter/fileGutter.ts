/**
 * The gutter in ordinary file buffers, driven by Lua events. Node owns the
 * projection, painting, marking and the mark undo stacks; Lua only forwards
 * events and hosts the foreign sign provider detach/reattach
 * (`glean.node_gutter`). Events are handled one at a time, in order. All nvim
 * access goes through the `GutterUi` port (`nvimGutterUi.ts`).
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { RepoPath, WorktreeLnum } from "../core/types.ts";
import type { SeenPlan } from "../render/actions.ts";
import { splitLines } from "../session/model.ts";
import type { Session } from "../session/session.ts";
import type { NotifyLevel } from "../view/review.ts";
import { BufUndo, type UndoDepth } from "./bufUndo.ts";
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
  | { kind: "focus"; buf: number; row: WorktreeLnum }
  | {
      kind: "toggle-mark";
      buf: number;
      line1: WorktreeLnum;
      line2?: WorktreeLnum;
    }
  | { kind: "goto-hunk"; buf: number; row: WorktreeLnum; dir: 1 | -1 }
  | { kind: "undo" | "redo"; buf: number; seq: number }
  | { kind: "toggle"; buf: number }
  | { kind: "wipe"; buf: number };

export function parseGutterEvent(v: unknown): GutterEvent | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const buf = o.buf;
  if (typeof buf !== "number") return undefined;
  const num = (k: string) => (typeof o[k] === "number" ? o[k] : undefined);
  // File-buffer rows are 1-based; the gutter only acts on buffers whose text
  // is the work tree, so they name work-tree lines.
  const lnum = (k: string) => num(k) as WorktreeLnum | undefined;
  switch (o.kind) {
    case "refresh":
    case "toggle":
    case "wipe":
      return { kind: o.kind, buf };
    case "focus": {
      const row = lnum("row");
      return row === undefined ? undefined : { kind: "focus", buf, row };
    }
    case "toggle-mark": {
      const line1 = lnum("line1");
      if (line1 === undefined) return undefined;
      const line2 = lnum("line2");
      return line2 === undefined
        ? { kind: "toggle-mark", buf, line1 }
        : { kind: "toggle-mark", buf, line1, line2 };
    }
    case "goto-hunk": {
      const row = lnum("row");
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

export type BufInfo = {
  buf: number;
  name: string;
  modified: boolean;
  lines: number;
  cursor: WorktreeLnum | undefined;
  /** Only fetched on request (`undotree()` is not constant work). */
  seq: number | undefined;
  focus: boolean;
};
export function parseInfos(v: unknown): BufInfo[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x: Record<string, unknown>) =>
    typeof x.buf === "number" &&
    typeof x.name === "string" &&
    typeof x.lines === "number"
      ? [
          {
            buf: x.buf,
            name: x.name,
            modified: x.modified === true,
            lines: x.lines,
            cursor:
              typeof x.cursor === "number"
                ? (x.cursor as WorktreeLnum)
                : undefined,
            seq: typeof x.seq === "number" ? x.seq : undefined,
            focus: x.focus !== false,
          },
        ]
      : [],
  );
}

export type GutterSign = {
  lnum: WorktreeLnum;
  kind: GutterKind;
  seen: boolean;
};
/** One buffer's new gutter state. `member` flips the maps/sign column (and
 * the foreign provider); `signs` replace the previous ones. */
export type GutterPaint = {
  buf: number;
  member: "attach" | "detach" | undefined;
  signs: GutterSign[];
  stale: boolean;
  focus: GutterSign[];
};
export type GutterUi = {
  infos(bufs: number[] | undefined, withSeq: boolean): Promise<BufInfo[]>;
  lines(buf: number): Promise<string[]>;
  /** Applied as one batch, in order. */
  paint(paints: GutterPaint[]): Promise<void>;
  focus(buf: number, signs: GutterSign[]): Promise<void>;
  setUndoDepth(buf: number, depth: UndoDepth): Promise<void>;
  /** Move the cursor (with a jumplist entry) if `buf` is still current. */
  park(buf: number, row: number): Promise<void>;
  notify(msg: string, level: NotifyLevel): Promise<void>;
  logError(err: unknown): void;
};

type Painted = { path: RepoPath; marks: GutterMarks; stale: boolean };
/** One entry of a file buffer's glean stack: a seen-mark, or a comment
 * change made through the overlay (`node/overlay/overlay.ts`). */
export type FileUndo =
  | { kind: "mark"; plan: SeenPlan; cursor: WorktreeLnum }
  | {
      kind: "comment";
      run: (reverse: boolean) => Promise<void>;
      cursor: number;
    };

export class FileGutter {
  enabled = true;
  private readonly off = new Set<number>();
  private readonly painted = new Map<number, Painted>();
  private readonly members = new Set<number>();
  readonly undo = new BufUndo<FileUndo>();
  private chain: Promise<void> = Promise.resolve();
  private readonly pendingRefresh = new Set<number>();
  /** Bumped per `refreshAll`; a superseded full repaint is skipped. */
  private allGen = 0;

  constructor(
    private readonly ui: GutterUi,
    private readonly session: () => Session | undefined,
  ) {}

  /** Serialized: a repaint never interleaves with another. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn).catch((err: unknown) => {
      this.ui.logError(err);
    });
    return this.chain;
  }

  handle(ev: GutterEvent): Promise<void> {
    // A typing burst sends one refresh per keystroke; one queued repaint per
    // buffer covers all of them.
    if (ev.kind === "refresh") {
      if (this.pendingRefresh.has(ev.buf)) return this.chain;
      this.pendingRefresh.add(ev.buf);
      return this.enqueue(() => {
        this.pendingRefresh.delete(ev.buf);
        return this.repaint([ev.buf]);
      });
    }
    return this.enqueue(() => this.run(ev));
  }
  /** Repaint every loaded named buffer (the model moved). */
  refreshAll(): Promise<void> {
    const gen = ++this.allGen;
    return this.enqueue(() =>
      gen === this.allGen ? this.repaint(undefined, gen) : Promise.resolve(),
    );
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
        const [info] = await this.ui.infos([ev.buf], false);
        if (!info) return;
        await this.ui.focus(ev.buf, focusSigns(info, p));
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
        const [info] = await this.ui.infos([ev.buf], false);
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

  private async repaint(bufs: number[] | undefined, gen?: number) {
    const paints: GutterPaint[] = [];
    for (const info of await this.ui.infos(bufs, false)) {
      // Projection is per buffer; yield between them, and abandon a full
      // repaint once a newer one is queued.
      if (gen !== undefined) {
        await new Promise((r) => setImmediate(r));
        if (gen !== this.allGen) return;
      }
      const { buf } = info;
      const st = this.statusFor(buf, info.name);
      // Membership (not paintedness) owns the maps and the sign column, so a
      // momentarily modified file keeps both.
      let member: GutterPaint["member"];
      if (st) {
        this.members.add(buf);
        member = "attach";
      } else if (this.members.delete(buf)) member = "detach";
      const had = this.painted.delete(buf);
      if (!(had || st || member)) continue;
      const paint: GutterPaint = {
        buf,
        member,
        signs: [],
        stale: false,
        focus: [],
      };
      paints.push(paint);
      if (!st || st.marks.size === 0) continue;
      const p = { ...st, stale: info.modified };
      this.painted.set(buf, p);
      paint.stale = p.stale;
      for (const [lnum, m] of st.marks)
        if (lnum >= 1 && lnum <= info.lines)
          paint.signs.push({ lnum, kind: m.kind, seen: m.seen });
      paint.focus = focusSigns(info, p);
    }
    await this.ui.paint(paints);
  }

  private warn(msg: string) {
    return this.ui.notify(`glean: ${msg}`, "warn");
  }

  private park(buf: number, row: number) {
    return this.ui.park(buf, row);
  }

  /** Record an already-applied action on `buf`'s stack (seq: its `seq_last`). */
  async push(buf: number, seq: number, a: FileUndo) {
    this.undo.push(buf, seq, a);
    await this.syncUndoVar(buf);
  }

  private async syncUndoVar(buf: number) {
    const d = this.undo.depth(buf);
    if (d) await this.ui.setUndoDepth(buf, d);
  }

  /**
   * `:Glean toggle-mark`. A modified buffer, or one whose text is not the
   * work tree the model was built from, is refused: its rows would name
   * lines the reviewer is not looking at.
   */
  private async toggleMark(
    buf: number,
    line1: WorktreeLnum,
    line2?: WorktreeLnum,
  ) {
    const s = this.session();
    if (!s?.worktree) return void (await this.warn("no live work-tree review"));
    const [info] = await this.ui.infos([buf], true);
    if (!info || info.seq === undefined) return;
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
    const [lines, disk] = await Promise.all([
      this.ui.lines(buf),
      readFile(resolve(s.repoRoot, path), "utf8").then(splitLines, () => []),
    ]);
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
    await this.push(buf, info.seq, {
      kind: "mark",
      plan: r.plan,
      cursor: line2 !== undefined && line2 < line1 ? line2 : line1,
    });
  }

  private async step(dir: "undo" | "redo", buf: number, seq: number) {
    const s = this.session();
    const a =
      dir === "undo" ? this.undo.undo(buf, seq) : this.undo.redo(buf, seq);
    await this.syncUndoVar(buf);
    if (!a) return;
    if (a.kind === "comment") {
      await a.run(dir === "undo");
      await this.park(buf, a.cursor);
      return;
    }
    if (!s) return;
    const { plan } = a;
    const op =
      dir === "redo" ? plan.op : plan.op === "mark" ? "unmark" : "mark";
    await s.applySeen(plan.ids, op, plan.sticky);
    await this.park(buf, a.cursor);
  }
}

function focusSigns(info: BufInfo, p: Painted | undefined): GutterSign[] {
  if (!p || p.stale || !info.focus || info.cursor === undefined) return [];
  const range = hunkRange(p.marks, info.cursor);
  if (!range) return [];
  const out: GutterSign[] = [];
  // The model can lag the buffer, so rows are clamped to what it has.
  for (
    let l = Math.max(range.lo, 1);
    l <= Math.min(range.hi, info.lines);
    l++
  ) {
    const lnum = l as WorktreeLnum;
    const m = p.marks.get(lnum);
    if (m) out.push({ lnum, kind: m.kind, seen: m.seen });
  }
  return out;
}
