/**
 * A live review session: owns the current model, store and classifier, and
 * keeps them in step with the repo. Refreshes are generation-guarded so an
 * older build that resolves late is dropped; polls never overlap.
 */
import { load as loadIgnore } from "../core/ignore.ts";
import { Store } from "../core/state.ts";
import { type Git, type Outcome, Poller } from "../git/git.ts";
import { GenerationGuard } from "../git/scheduler.ts";
import {
  type BuildOpts,
  buildModel,
  Classifier,
  loadWorktreeSeen,
  type ModelData,
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

export type RefreshResult =
  | { kind: "applied"; snapshot: Snapshot }
  | { kind: "stale" }
  | Exclude<Outcome<never>, { kind: "ok" }>;

export class Session {
  private readonly guard = new GenerationGuard();
  private readonly poller: Poller;
  private sig: string | undefined;
  private untrackedSig: string | undefined;
  current: Snapshot | undefined;
  /** Called after each applied refresh (the view re-renders from here). */
  onChange: (s: Snapshot) => void = () => {};

  constructor(private readonly opts: SessionOpts) {
    this.poller = new Poller(async () => {
      await this.poll({ untracked: true });
    });
  }

  get worktree(): boolean {
    return this.opts.target.kind === "worktree";
  }

  async refresh(): Promise<RefreshResult> {
    const gen = this.guard.bump();
    const { git, base, target } = this.opts;
    const built = await buildModel(git, base, target, this.opts.build);
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

  startLive(intervalMs: number) {
    if (!this.worktree) return;
    this.poller.start(intervalMs);
  }

  stop() {
    this.poller.stop();
    this.guard.bump();
  }
}
