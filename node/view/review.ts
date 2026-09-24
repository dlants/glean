/**
 * The review buffer's core: owns scope, the current frame and every decision
 * an action makes (planners, Session writes, cursor placement, prompts,
 * jumps). It talks to the display only through `ReviewUi`, in glean's own
 * vocabulary, so it runs in node without nvim; `ReviewView` is the nvim adapter.
 */

import type { CommentRecord } from "../core/state.ts";
import type { Layer, LineId, RepoPath, WorktreeLnum } from "../core/types.ts";
import { GenerationGuard } from "../git/scheduler.ts";
import {
  collapseTarget,
  nextUnseenHunk,
  planToggleSeen,
  planUnmarkAll,
  planUnmarkHunk,
  planVisualMark,
  resolveFile,
  rowOfHunk,
  type SeenPlan,
} from "../render/actions.ts";
import { cursorAnchor, restoreAnchor } from "../render/anchor.ts";
import {
  commentsAtLine,
  commentTarget,
  commentUnder,
  summaryCommentsIn,
} from "../render/commentActions.ts";
import type { SummaryGroup } from "../render/comments.ts";
import {
  type DiffContext,
  diffContext,
  fileHeaderRow,
  hunkRange,
  jumpTarget,
  type NavUnit,
  navRow,
  sourceLineRow,
} from "../render/nav.ts";
import {
  type CollapseKey,
  type Frame,
  keys,
  render,
} from "../render/render.ts";
import type { Scope } from "../session/model.ts";
import type { Session } from "../session/session.ts";
import {
  type IsStale,
  type LineReader,
  type ResolvedJump,
  resolveJump,
} from "./jump.ts";

/** Everything the Lua keymaps can send. Rows are 0-based. */
export type Action =
  | { kind: "toggle-seen"; row: number }
  | { kind: "visual-mark"; srow: number; erow: number }
  | { kind: "toggle-fold"; row: number }
  | { kind: "toggle-scope"; row: number }
  | { kind: "jump"; row: number; col: number }
  | { kind: "diffsplit"; row: number }
  | { kind: "delete-comments"; srow: number; erow: number }
  | { kind: "add-comment"; srow: number; erow: number }
  | { kind: "edit-comment"; row: number }
  | { kind: "delete-comment"; row: number }
  | { kind: "delete-comment-at"; row: number }
  /** A comment editor / picker opened by node returned (no value: dismissed). */
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "unmark-hunk"; row: number }
  | { kind: "unmark-all" }
  | { kind: "toggle-whitespace"; row: number }
  /** Cursor moved / scrolled / window layout changed: repaint the cursor decor. */
  | { kind: "cursor" }
  | { kind: "sticky-close" }
  | { kind: "visibility"; visible: boolean }
  /** Registry-level (not the view): the buffer was wiped, or `:e` hard reset. */
  | { kind: "gone" }
  | { kind: "reset"; row: number | undefined };

export function parseAction(v: unknown): Action | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const num = (k: string) => (typeof o[k] === "number" ? o[k] : undefined);
  switch (o.kind) {
    case "toggle-seen":
    case "toggle-scope":
    case "toggle-fold":
    case "unmark-hunk":
    case "toggle-whitespace":
    case "edit-comment":
    case "delete-comment":
    case "delete-comment-at":
    case "diffsplit": {
      const row = num("row");
      return row === undefined ? undefined : { kind: o.kind, row };
    }
    case "visual-mark":
    case "add-comment":
    case "delete-comments": {
      const srow = num("srow");
      const erow = num("erow");
      return srow === undefined || erow === undefined
        ? undefined
        : { kind: o.kind, srow, erow };
    }
    case "jump": {
      const row = num("row");
      const col = num("col");
      return row === undefined || col === undefined
        ? undefined
        : { kind: "jump", row, col };
    }
    case "reset":
      return { kind: "reset", row: num("row") };
    case "visibility":
      return typeof o.visible === "boolean"
        ? { kind: "visibility", visible: o.visible }
        : undefined;
    case "undo":
    case "redo":
    case "unmark-all":
    case "cursor":
    case "sticky-close":
    case "gone":
      return { kind: o.kind };
    default:
      return undefined;
  }
}

export type Query =
  | { kind: "hunk-range"; row: number }
  | { kind: "nav"; row: number; unit: NavUnit; forward: boolean };
export function parseQuery(v: unknown): Query | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.row !== "number") return undefined;
  if (o.kind === "hunk-range") return { kind: "hunk-range", row: o.row };
  if (
    o.kind === "nav" &&
    (o.unit === "hunk" || o.unit === "file") &&
    typeof o.forward === "boolean"
  )
    return { kind: "nav", row: o.row, unit: o.unit, forward: o.forward };
  return undefined;
}

/** Collapse keys hiding `path`'s lines in `scope`, so navigation can reach them. */
function revealKeys(
  scope: Scope,
  path: RepoPath,
  sha: Layer | undefined,
): CollapseKey[] {
  const parts = path.split("/");
  const prefixes = parts
    .slice(1)
    .map((_, i) => parts.slice(0, i + 1).join("/"));
  if (scope === "combined")
    return [keys.cfile(path), keys.cseen(path), ...prefixes.map(keys.cdir)];
  if (sha === undefined) return [];
  return [
    keys.commit(sha),
    keys.file(sha, path),
    keys.seen(sha, path),
    ...prefixes.map((p) => keys.dir(sha, p)),
  ];
}

function ownerSha(id: LineId | undefined): Layer | undefined {
  if (id?.kind === "committed-add") return id.sha;
  if (id?.kind === "committed-del") return id.removerSha;
  return undefined;
}

export type NotifyLevel = "info" | "warn" | "error";
/** What the review core needs from wherever it is displayed. */
export type ReviewUi = {
  /** Show `frame`; called in frame order, never concurrently. */
  paint(frame: Frame): Promise<void>;
  setCursor(row: number): Promise<void>;
  notify(msg: string, level: NotifyLevel): Promise<void>;
  /** Resolves with the submitted text, or undefined when dismissed. */
  editor(initial: string[]): Promise<string | undefined>;
  /** Resolves with the picked index, or undefined when dismissed. */
  pick(items: string[]): Promise<number | undefined>;
  /** The work-tree line a jump compares against (unsaved edits included). */
  worktreeLine: LineReader;
  openJump(target: ResolvedJump, col: number, isStale: IsStale): Promise<void>;
  openDiffsplit(
    ctx: DiffContext,
    ignoreWhitespace: boolean,
    isStale: IsStale,
  ): Promise<void>;
  openFileAt(path: RepoPath, lnum: WorktreeLnum): Promise<void>;
};

export type ViewOpts = {
  minSeenRun?: number;
  hunkIndent?: number;
  hunkIndentDelayMs?: number;
};

export class ReviewController {
  frame: Frame | undefined;
  scope: Scope = "combined";
  /** False while the display is hidden: model changes skip the repaint. */
  live = true;
  private summary: readonly SummaryGroup[] = [];
  /** Latest `<CR>`/`D`/`:Glean jump`; an older one never moves windows or the cursor. */
  private readonly jumpGuard = new GenerationGuard();
  private staleCheck(): IsStale {
    const gen = this.jumpGuard.bump();
    return () => !this.jumpGuard.isCurrent(gen);
  }

  constructor(
    readonly session: Session,
    private readonly ui: ReviewUi,
    private readonly opts: ViewOpts = {},
    onError: (e: unknown) => void = () => undefined,
  ) {
    session.onChange = () => {
      // Hidden: the model keeps refreshing (gutter/file-buffer paths read it),
      // only the paint waits for the display to come back.
      if (this.live) void this.redraw().catch(onError);
    };
  }

  private build(summary: readonly SummaryGroup[]): Frame | undefined {
    const snap = this.session.current;
    if (!snap) return undefined;
    return render({
      scope: this.scope,
      cls: snap.cls,
      collapse: this.session.collapse,
      isSticky: (p, t) => snap.store.isSticky(p, t),
      minSeenRun: this.opts.minSeenRun ?? 5,
      ignoreWhitespace: this.session.ignoreWhitespace,
      comments: this.session.commentsHook(),
      summary,
    });
  }

  private drawChain: Promise<unknown> = Promise.resolve();
  /** Serialized so frames reach `paint` in the order they were built. */
  redraw(): Promise<void> {
    const next = this.drawChain.then(() => this.draw());
    this.drawChain = next.catch(() => undefined);
    return next;
  }
  private async draw() {
    const summary = await this.session.commentSummary();
    this.summary = summary;
    const frame = this.build(summary);
    if (!frame) return;
    this.frame = frame;
    await this.ui.paint(frame);
  }

  /**
   * Synchronous lookups the keymaps need before returning (`gleanReviewQuery`).
   * Must stay free of awaits (git, redraw): nvim is blocked until it replies.
   */
  query(q: Query): [number, number] | undefined {
    const frame = this.frame;
    if (!frame) return undefined;
    if (q.kind === "hunk-range") {
      const r = hunkRange(frame, q.row);
      return r && [r.lo, r.hi];
    }
    const row = navRow(frame, q.row, q.unit, q.forward);
    if (row === undefined) return undefined;
    return [row, q.unit === "hunk" ? (hunkRange(frame, row)?.hi ?? row) : row];
  }
  /** Expand every collapse hiding `path`'s lines (file, seen section, dirs, markers). */
  private async revealPath(path: RepoPath) {
    const snap = this.session.current;
    if (!snap) return;
    const shas =
      this.scope === "combined"
        ? [undefined]
        : snap.model.commits
            .filter((c) => c.files.some((f) => f.path === path))
            .map((c) => c.sha);
    this.session.expand(shas.flatMap((s) => revealKeys(this.scope, path, s)));
    await this.redraw();
    const markers = (this.frame?.rows ?? []).flatMap((t) =>
      t.kind === "marker" &&
      resolveFile(snap.cls, t.file)?.file.path === path &&
      this.session.collapse.get(keys.marker(t.key)) !== false
        ? [keys.marker(t.key)]
        : [],
    );
    if (markers.length === 0) return;
    this.session.expand(markers);
    await this.redraw();
  }
  /**
   * `:Glean jump`: park on the row showing `path`:`lnum`, expanding whatever
   * hides it. Undefined when the file is not part of the review.
   */
  async gotoSource(
    path: RepoPath,
    lnum: WorktreeLnum,
  ): Promise<number | undefined> {
    const snap = this.session.current;
    if (!snap) return undefined;
    const inReview =
      snap.model.files.some((f) => f.path === path) ||
      snap.model.commits.some((c) => c.files.some((f) => f.path === path));
    if (!inReview) return undefined;
    const isStale = this.staleCheck();
    await this.revealPath(path);
    if (isStale()) return undefined;
    const cls = this.session.current?.cls ?? snap.cls;
    const row = this.frame && sourceLineRow(cls, this.frame, path, lnum);
    if (row !== undefined) await this.ui.setCursor(row);
    return row;
  }
  /** `<CR>`: summary rows navigate within the review, diff rows open the source. */
  private async jump(row: number, col: number) {
    const isStale = this.staleCheck();
    const snap = this.session.current;
    const frame = this.frame;
    if (!snap || !frame) return;
    const t = frame.rows[row];
    if (t?.kind === "summary-file") {
      const r = fileHeaderRow(snap.cls, frame, t.path);
      if (r !== undefined) await this.ui.setCursor(r);
      return;
    }
    if (t?.kind === "summary-comment") {
      const entry = this.summary
        .find((g) => g.path === t.path)
        ?.entries.find((e) => e.record.id === t.commentId);
      // An off-diff comment has no review row: open the file at its line.
      if (entry?.state === "file" && entry.fileLnum !== undefined) {
        await this.ui.openFileAt(t.path, entry.fileLnum as WorktreeLnum);
        return;
      }
      // A comment hidden by ignore-whitespace has no row in this mode: go back
      // to exact mode first.
      if (entry?.hidden && this.session.ignoreWhitespace) {
        const r = await this.session.setIgnoreWhitespace(false);
        if (r.kind !== "applied" || isStale()) return;
        await this.redraw();
      }
      await this.revealComment(t.path, t.commentId, isStale);
      return;
    }
    const jt = jumpTarget(snap.cls, t, this.session.range);
    if (!jt) return;
    const rj = await resolveJump(this.session.git, jt, this.ui.worktreeLine);
    if (isStale()) return;
    await this.ui.openJump(rj, col, isStale);
  }
  private async revealComment(
    path: RepoPath,
    commentId: number,
    isStale: IsStale,
  ) {
    const find = () => {
      const cls = this.session.current?.cls;
      const rows = this.frame?.rows ?? [];
      return rows.findIndex(
        (r) =>
          r.kind === "comment" &&
          r.commentId === commentId &&
          cls !== undefined &&
          resolveFile(cls, r.file)?.file.path === path,
      );
    };
    let row = find();
    if (row < 0) {
      await this.revealPath(path);
      row = find();
    }
    if (row < 0) {
      const cls = this.session.current?.cls;
      const header = cls && this.frame && fileHeaderRow(cls, this.frame, path);
      if (header !== undefined) row = header;
    }
    if (row >= 0 && !isStale()) await this.ui.setCursor(row);
  }
  private async dropComment(
    path: RepoPath,
    before: CommentRecord,
    row: number,
  ) {
    await this.session.perform({
      kind: "comment",
      path,
      change: { op: "delete", before: { ...before } },
      cursor: row,
    });
    await this.redraw();
  }
  /** After marking, land on the next unseen hunk below the cursor. */
  private async markAndAdvance(plan: SeenPlan, row: number) {
    const before = this.frame;
    const next =
      plan.op === "mark" && before ? nextUnseenHunk(before, row) : undefined;
    await this.session.perform({ kind: "seen", plan, cursor: row });
    await this.redraw();
    const frame = this.frame;
    if (!frame || frame.rows.length === 0) return;
    const dest = next === undefined ? undefined : rowOfHunk(frame, next);
    await this.ui.setCursor(dest ?? Math.min(row, frame.rows.length - 1));
  }
  /**
   * `W`: flip the whitespace projection and put the cursor back on the same
   * semantic line (rows are not comparable across projections).
   */
  private async toggleWhitespace(row: number) {
    const snap = this.session.current;
    const anchor = snap && cursorAnchor(snap.cls, this.frame?.rows[row]);
    const r = await this.session.setIgnoreWhitespace(
      !this.session.ignoreWhitespace,
    );
    if (r.kind !== "applied") return;
    await this.redraw();
    const next = this.frame;
    const cls = this.session.current?.cls;
    const dest = anchor && next && cls && restoreAnchor(cls, next, anchor);
    if (dest !== undefined) await this.ui.setCursor(dest);
  }
  /** Every review action except the display-only ones (`cursor`,
   * `sticky-close`, `visibility`) and prompt results, which the adapter routes. */
  async dispatch(a: Action) {
    const snap = this.session.current;
    const frame = this.frame;
    if (!snap || !frame) return;
    switch (a.kind) {
      case "toggle-seen": {
        const t = frame.rows[a.row];
        const plan = t && planToggleSeen(snap.cls, this.scope, t);
        if (plan) await this.markAndAdvance(plan, a.row);
        return;
      }
      case "unmark-hunk": {
        const t = frame.rows[a.row];
        const plan = t && planUnmarkHunk(snap.cls, this.scope, t);
        if (!plan) return;
        await this.session.perform({ kind: "seen", plan, cursor: a.row });
        await this.redraw();
        return;
      }
      case "unmark-all": {
        const plan = planUnmarkAll(snap.cls, this.scope);
        if (!plan) return;
        await this.session.perform({ kind: "seen", plan });
        await this.redraw();
        return;
      }
      case "toggle-whitespace":
        await this.toggleWhitespace(a.row);
        return;
      case "visual-mark": {
        const plan = planVisualMark(
          snap.cls,
          this.scope,
          frame.rows,
          a.srow,
          a.erow,
        );
        if (plan) await this.markAndAdvance(plan, a.srow);
        return;
      }
      case "toggle-fold": {
        const t = frame.rows[a.row];
        const c = t && collapseTarget(snap.cls, this.session.collapse, t);
        if (!c) return;
        await this.session.perform({
          kind: "collapse",
          key: c.key,
          value: !c.collapsed,
          prev: this.session.collapse.get(c.key),
          cursor: a.row,
        });
        await this.redraw();
        return;
      }
      case "toggle-scope": {
        const anchor = cursorAnchor(snap.cls, frame.rows[a.row]);
        this.scope = this.scope === "combined" ? "commits" : "combined";
        if (anchor?.kind === "line")
          this.session.expand(
            revealKeys(
              this.scope,
              anchor.path,
              anchor.sha ?? ownerSha(anchor.id),
            ),
          );
        await this.redraw();
        const next = this.frame;
        const cls = this.session.current?.cls ?? snap.cls;
        const row = anchor && next && restoreAnchor(cls, next, anchor);
        if (row !== undefined) await this.ui.setCursor(row);
        return;
      }
      case "jump":
        await this.jump(a.row, a.col);
        return;
      case "diffsplit": {
        const isStale = this.staleCheck();
        const ctx = diffContext(
          snap.cls,
          frame.rows[a.row],
          this.session.range,
        );
        if (!ctx) return;
        await this.ui.openDiffsplit(
          ctx,
          this.session.ignoreWhitespace,
          isStale,
        );
        return;
      }
      case "delete-comments": {
        const removed = summaryCommentsIn(
          snap.store,
          frame.rows,
          a.srow,
          a.erow,
        );
        if (removed.length === 0) return;
        await this.session.perform({
          kind: "comments",
          removed,
          cursor: Math.min(a.srow, a.erow),
        });
        await this.redraw();
        return;
      }
      case "add-comment": {
        const lo = Math.min(a.srow, a.erow);
        const ct = commentTarget(
          snap.cls,
          this.scope,
          frame.rows,
          lo,
          Math.max(a.srow, a.erow),
          this.session.worktree,
        );
        if (!ct) {
          await this.ui.notify("glean: cannot comment here", "warn");
          return;
        }
        const text = await this.ui.editor([]);
        if (text === undefined) return;
        await this.session.perform({
          kind: "comment",
          path: ct.path,
          change: {
            op: "add",
            after: {
              id: (this.session.current?.store ?? snap.store).nextCommentId(),
              lnum: ct.lnum,
              content: ct.content,
              text,
              reply: undefined,
              origin: ct.origin,
            },
          },
          cursor: lo,
        });
        await this.redraw();
        return;
      }
      case "edit-comment": {
        const c = commentUnder(snap.cls, snap.store, frame.rows[a.row]);
        if (!c) return;
        const text = await this.ui.editor(c.record.text.split("\n"));
        if (text === undefined || text === c.record.text) return;
        await this.session.perform({
          kind: "comment",
          path: c.path,
          change: {
            op: "edit",
            before: { ...c.record },
            after: { ...c.record, text },
          },
          cursor: a.row,
        });
        await this.redraw();
        return;
      }
      case "delete-comment": {
        const c = commentUnder(snap.cls, snap.store, frame.rows[a.row]);
        if (c) await this.dropComment(c.path, c.record, a.row);
        return;
      }
      case "delete-comment-at": {
        const at = commentsAtLine(
          snap.cls,
          frame.rows[a.row],
          this.session.commentsHook(),
        );
        if (!at) return;
        if (at.records.length === 0) {
          await this.ui.notify("glean: no comment on this line", "warn");
          return;
        }
        const [only, ...rest] = at.records;
        if (only && rest.length === 0) {
          await this.dropComment(at.path, only, a.row);
          return;
        }
        const i = await this.ui.pick(at.records.map((r) => r.text));
        const r = i === undefined ? undefined : at.records[i];
        if (r) await this.dropComment(at.path, r, a.row);
        return;
      }
      case "undo":
      case "redo": {
        const r = await (a.kind === "undo"
          ? this.session.undo()
          : this.session.redo());
        if (!r) return;
        await this.redraw();
        const n = this.frame?.rows.length ?? 0;
        if (r.cursor !== undefined && n > 0)
          await this.ui.setCursor(Math.min(r.cursor, n - 1));
        return;
      }
    }
  }
}
