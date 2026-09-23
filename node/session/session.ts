/**
 * A live review session: owns the current model, store and classifier, and
 * keeps them in step with the repo. Refreshes are generation-guarded so an
 * older build that resolves late is dropped; polls never overlap.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as baseline from "../core/baseline.ts";
import type { FileEntry } from "../core/diff.ts";
import { load as loadIgnore } from "../core/ignore.ts";
import * as ranges from "../core/ranges.ts";
import { type CommentRecord, contentHash, Store } from "../core/state.ts";
import type {
  HeadLnum,
  LineId,
  RepoPath,
  WorktreeLnum,
} from "../core/types.ts";
import { type Git, type Outcome, Poller } from "../git/git.ts";
import { GenerationGuard } from "../git/scheduler.ts";
import type { SeenPlan, Sticky } from "../render/actions.ts";
import {
  type CommentPair,
  collectComments,
  type PlacedComment,
  resolveComments,
  type SummaryGroup,
} from "../render/comments.ts";
import type { CollapseKey, CollapseState, FileRef } from "../render/render.ts";
import {
  type BuildOpts,
  buildModel,
  Classifier,
  type CommitPatchCache,
  loadWorktreeSeen,
  type ModelData,
  splitLines,
  type Target,
} from "./model.ts";

export type SessionOpts = {
  git: Git;
  base: string;
  target: Target;
  stateDir: string;
  wtShard?: string;
  build?: BuildOpts;
};

export type Snapshot = { model: ModelData; store: Store; cls: Classifier };

/** An undoable user action. `cursor` is the row to restore on undo. */
export type Undoable =
  | { kind: "seen"; plan: SeenPlan; cursor?: number }
  | {
      /** Replace `before` with `after` (add: no before; delete: no after; edit/reply: both). */
      kind: "comment";
      path: RepoPath;
      before: CommentRecord | undefined;
      after: CommentRecord | undefined;
      cursor?: number;
    }
  | {
      kind: "collapse";
      key: CollapseKey;
      value: boolean | undefined;
      prev: boolean | undefined;
      cursor?: number;
    };

export type RefreshResult =
  | { kind: "applied"; snapshot: Snapshot }
  | { kind: "stale" }
  | Exclude<Outcome<never>, { kind: "ok" }>;

export class Session {
  private readonly guard = new GenerationGuard();
  private readonly patchCache: CommitPatchCache = new Map();
  private readonly poller: Poller;
  private sig: string | undefined;
  private untrackedSig: string | undefined;
  current: Snapshot | undefined;
  /** Ephemeral view state: explicit collapse overrides (never persisted). */
  collapse: CollapseState = new Map();
  private undoStack: Undoable[] = [];
  private redoStack: Undoable[] = [];
  /** Called after each applied refresh (the view re-renders from here). */
  onChange: (s: Snapshot) => void = () => {};

  constructor(private readonly opts: SessionOpts) {
    this.poller = new Poller(async () => {
      await this.poll({ untracked: true });
    });
  }

  /**
   * The `RenderInput.comments` hook: comments are content-addressed per path,
   * so every display file resolves against the canonical file of that path.
   */
  commentsHook(): (
    ref: FileRef,
    file: FileEntry,
  ) => ReadonlyMap<number, readonly PlacedComment[]> {
    const snap = this.current;
    const empty = new Map<number, PlacedComment[]>();
    if (!snap) return () => empty;
    return (_ref, file) => {
      const records = snap.store.commentsFor(file.path);
      if (records.length === 0) return empty;
      const canonical = snap.model.canonicalFiles.find(
        (f) => f.path === file.path,
      );
      return resolveComments(file, canonical, records);
    };
  }
  /**
   * The bottom comment summary: every path in the diff plus every path the
   * store holds comments for, so no comment is ever invisible. Work-tree text
   * is read up front so classification itself stays synchronous.
   */
  async commentSummary(): Promise<SummaryGroup[]> {
    const snap = this.current;
    if (!snap) return [];
    const { model, store } = snap;
    const pairs = new Map<RepoPath, CommentPair>();
    for (const canonical of model.canonicalFiles)
      pairs.set(canonical.path, {
        path: canonical.path,
        canonical,
        display: model.files.find((f) => f.path === canonical.path),
      });
    for (const path of store.commentPaths())
      if (!pairs.has(path))
        pairs.set(path, { path, canonical: undefined, display: undefined });
    const commented = [...pairs.keys()].filter(
      (p) => store.commentsFor(p).length > 0,
    );
    const wt = new Map<RepoPath, string[]>();
    await Promise.all(
      commented.map(async (p) => {
        const text = await readFile(
          join(this.opts.git.repoRoot, p),
          "utf8",
        ).catch(() => undefined);
        if (text !== undefined) wt.set(p, splitLines(text));
      }),
    );
    return collectComments(
      commented.flatMap((p) => pairs.get(p) ?? []),
      (p) => store.commentsFor(p),
      (p) => wt.get(p),
      this.opts.build?.ignoreWhitespace ?? false,
    );
  }
  get worktree(): boolean {
    return this.opts.target.kind === "worktree";
  }

  async refresh(): Promise<RefreshResult> {
    const gen = this.guard.bump();
    const { git, base, target } = this.opts;
    // Seeding the poll signatures alongside the build means an edit landing
    // after this refresh starts is seen by the very next poll tick.
    const [built] = await Promise.all([
      buildModel(git, base, target, this.opts.build, this.patchCache),
      this.worktree ? this.seedSignatures() : undefined,
    ]);
    if (!this.guard.isCurrent(gen)) return { kind: "stale" };
    if (built.kind !== "ok") return built;
    const model = built.value;
    const store = new Store(this.opts.stateDir, this.opts.wtShard);
    const [, ignore] = await Promise.all([
      store.load(model.commits.map((c) => c.sha)),
      // Re-read per refresh so an edit to `.gleanignore` lands on the next reload.
      loadIgnore(git.repoRoot),
    ]);
    const wt = await loadWorktreeSeen(git, git.repoRoot, store, model);
    if (!this.guard.isCurrent(gen)) return { kind: "stale" };
    if (wt.kind !== "ok") return wt;
    const snapshot = {
      model,
      store,
      cls: new Classifier(model, store, wt.value, ignore),
    };
    this.current = snapshot;
    this.onChange(snapshot);
    return { kind: "applied", snapshot };
  }

  /**
   * Rebuild the classifier after a store write (marks change seen-ness, not
   * the model). Worktree seen sets are re-read since marks move the baseline.
   */
  async reclassify(): Promise<RefreshResult> {
    const cur = this.current;
    if (!cur) return this.refresh();
    const gen = this.guard.bump();
    const { git } = this.opts;
    const [wt, ignore] = await Promise.all([
      loadWorktreeSeen(git, git.repoRoot, cur.store, cur.model),
      loadIgnore(git.repoRoot),
    ]);
    if (!this.guard.isCurrent(gen)) return { kind: "stale" };
    if (wt.kind !== "ok") return wt;
    const snapshot = {
      ...cur,
      cls: new Classifier(cur.model, cur.store, wt.value, ignore),
    };
    this.current = snapshot;
    this.onChange(snapshot);
    return { kind: "applied", snapshot };
  }

  /**
   * One repo check: refresh only when the poll signature (or, with
   * `untracked`, the untracked listing) moved. The first check only records
   * the baseline signatures.
   */
  private async seedSignatures() {
    const { git } = this.opts;
    const [p, u] = await Promise.all([git.poll(), git.untrackedSig()]);
    if (p.kind === "ok") this.sig = p.value.sig;
    if (u.kind === "ok") this.untrackedSig = u.value;
  }

  async poll(
    o: { untracked?: boolean } = {},
  ): Promise<"refreshed" | "unchanged" | "error"> {
    if (!this.worktree) return "unchanged";
    const { git } = this.opts;
    const [p, u] = await Promise.all([
      git.poll(),
      o.untracked ? git.untrackedSig() : undefined,
    ]);
    if (p.kind !== "ok" || (u && u.kind !== "ok")) return "error";
    const usig = u?.kind === "ok" ? u.value : undefined;
    const first = this.sig === undefined;
    const changed =
      p.value.sig !== this.sig ||
      (usig !== undefined && usig !== this.untrackedSig);
    this.sig = p.value.sig;
    if (usig !== undefined) this.untrackedSig = usig;
    if (first || !changed) return "unchanged";
    const r = await this.refresh();
    return r.kind === "applied" || r.kind === "stale" ? "refreshed" : "error";
  }

  /**
   * Mark or unmark exactly `ids`, persist the touched shards, and reclassify.
   * Committed ids fold through the store's ranges. A worktree add moves the
   * path's reviewed baseline R over just that line; a worktree del is a plain
   * head-line range edit, so a repeated line never depends on a diff picking
   * the "right" copy.
   */
  async applySeen(
    ids: readonly LineId[],
    op: "mark" | "unmark",
    sticky: readonly Sticky[] = [],
  ): Promise<RefreshResult> {
    const cur = this.current;
    if (!cur) return this.refresh();
    const { store } = cur;
    const touched = new Set<string>();
    const committed = ids.filter(
      (id) => id.kind === "committed-add" || id.kind === "committed-del",
    );
    if (op === "mark") store.mark(committed);
    else store.unmark(committed);
    for (const id of committed)
      touched.add(id.kind === "committed-add" ? id.sha : id.removerSha);
    const byPath = new Map<RepoPath, LineId[]>();
    for (const id of ids) {
      if (id.kind !== "worktree-add" && id.kind !== "worktree-del") continue;
      byPath.set(id.path, [...(byPath.get(id.path) ?? []), id]);
    }
    if (byPath.size > 0) {
      const { git } = this.opts;
      const heads = await git.showMany(cur.model.head, [...byPath.keys()]);
      if (heads.kind !== "ok") return heads;
      for (const [path, pathIds] of byPath) {
        const blob = heads.value.get(path);
        const head = blob?.kind === "found" ? splitLines(blob.text) : [];
        const headHash = contentHash(head);
        const wt = await readFile(join(git.repoRoot, path), "utf8").then(
          splitLines,
          () => [],
        );
        const rec = store.baseline(path, headHash);
        let dels: ranges.RangeSet<HeadLnum> = rec?.dels ?? [];
        const adds: WorktreeLnum[] = [];
        for (const id of pathIds) {
          if (id.kind === "worktree-del") {
            const r: ranges.Range<HeadLnum> = [id.lnum, id.lnum];
            dels = op === "mark" ? ranges.add(dels, r) : ranges.remove(dels, r);
          } else if (id.kind === "worktree-add") adds.push(id.lnum);
        }
        const reviewed = rec?.lines ?? head;
        const next =
          op === "mark"
            ? baseline.markAdds(reviewed, wt, adds)
            : baseline.unmarkAdds(head, reviewed, wt, adds);
        store.setBaseline(path, headHash, next, dels);
      }
      touched.add(store.wtShard);
    }
    // Applied even when the seen write was a no-op (already-seen lines) so an
    // explicit re-mark still exempts the line from demotion.
    for (const s of sticky) {
      if (op === "mark") store.addSticky(s.path, s.text);
      else store.removeSticky(s.path, s.text);
      touched.add(store.wtShard);
    }
    await Promise.all([...touched].map((id) => store.save(id)));
    return this.reclassify();
  }

  private async swapComment(
    path: RepoPath,
    from: CommentRecord | undefined,
    to: CommentRecord | undefined,
  ): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    const { store } = cur;
    if (from) store.removeCommentRecord(path, { id: from.id });
    if (to) store.addCommentRecord(path, { ...to });
    await store.save(store.wtShard);
    await this.reclassify();
  }

  /** Navigation-only expansion: not recorded on the undo stack. */
  expand(ks: readonly CollapseKey[]) {
    const next = new Map(this.collapse);
    for (const k of ks) next.set(k, false);
    this.collapse = next;
  }

  private setCollapse(key: CollapseKey, v: boolean | undefined) {
    const next = new Map(this.collapse);
    if (v === undefined) next.delete(key);
    else next.set(key, v);
    this.collapse = next;
  }

  private async apply(a: Undoable, reverse: boolean): Promise<void> {
    if (a.kind === "collapse") {
      this.setCollapse(a.key, reverse ? a.prev : a.value);
      return;
    }
    if (a.kind === "comment") {
      await this.swapComment(
        a.path,
        reverse ? a.after : a.before,
        reverse ? a.before : a.after,
      );
      return;
    }
    const { plan } = a;
    const op = reverse ? (plan.op === "mark" ? "unmark" : "mark") : plan.op;
    if (!reverse) for (const k of plan.clear) this.setCollapse(k, undefined);
    await this.applySeen(plan.ids, op, plan.sticky);
  }

  /** Apply a fresh action, push it for undo, and clear the redo stack. */
  async perform(a: Undoable): Promise<void> {
    await this.apply(a, false);
    this.undoStack.push(a);
    this.redoStack = [];
  }

  /** Reverse the last action; returns it (for cursor restore) or undefined. */
  async undo(): Promise<Undoable | undefined> {
    const a = this.undoStack.pop();
    if (!a) return undefined;
    await this.apply(a, true);
    this.redoStack.push(a);
    return a;
  }

  async redo(): Promise<Undoable | undefined> {
    const a = this.redoStack.pop();
    if (!a) return undefined;
    await this.apply(a, false);
    this.undoStack.push(a);
    return a;
  }

  startLive(intervalMs: number) {
    if (!this.worktree) return;
    this.poller.start(intervalMs);
  }

  /** One immediate poll, e.g. when a hidden view is re-displayed. */
  async pokePoll() {
    if (this.worktree) await this.poller.poke();
  }
  stop() {
    this.poller.stop();
    this.guard.bump();
  }
}
