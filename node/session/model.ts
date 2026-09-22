/**
 * The review model (port of init.lua's model half): acquiring the diff data
 * for `base..target` and classifying every changed line's identity and
 * seen-ness. Acquisition is async git; classification is pure and synchronous
 * over data prepared up front, so it never touches git or the filesystem.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as baseline from "../core/baseline.ts";
import type { DiffLine, FileEntry, Hunk } from "../core/diff.ts";
import type { Matcher } from "../core/ignore.ts";
import * as lineage from "../core/lineage.ts";
import * as ranges from "../core/ranges.ts";
import { contentHash, type Store } from "../core/state.ts";
import {
  type HeadLnum,
  type Layer,
  type LineId,
  type PostLnum,
  type PreLnum,
  type RepoPath,
  type Sha,
  WORKTREE,
  type WorktreeLnum,
} from "../core/types.ts";
import type { CommitPatch, Git, Outcome } from "../git/git.ts";

export type Target = { kind: "ref"; ref: string } | { kind: "worktree" };
export type ModelCommit = {
  sha: Layer;
  summary: string;
  files: readonly FileEntry[];
};
export type ModelData = {
  worktree: boolean;
  /** Display net diff base..target (untracked files appended in a work-tree review). */
  files: readonly FileEntry[];
  /** Display commits, oldest first; a work-tree review ends with the WORKTREE layer. */
  commits: readonly ModelCommit[];
  /** Exact (whitespace-sensitive) inputs to ownership and comments. */
  canonicalFiles: readonly FileEntry[];
  lineageCommits: readonly CommitPatch[];
  lineageWorktreeFiles: readonly FileEntry[];
  /** The resolved tip commit H. */
  head: Sha;
};

export type BuildOpts = { ignoreWhitespace?: boolean; fromRoot?: boolean };

/** Every git call of a build runs concurrently; any failure fails the build. */
export async function buildModel(
  git: Git,
  base: string,
  target: Target,
  opts: BuildOpts = {},
): Promise<Outcome<ModelData>> {
  const worktree = target.kind === "worktree";
  const commitTarget = target.kind === "worktree" ? "HEAD" : target.ref;
  const ws = opts.ignoreWhitespace === true;
  const netDiff = (ignoreWhitespace: boolean) =>
    target.kind === "worktree"
      ? git.diffToWorktree(base, { ignoreWhitespace })
      : opts.fromRoot
        ? git.diffRefs(base, target.ref, { ignoreWhitespace })
        : git.combinedDiff(base, target.ref, { ignoreWhitespace });
  const patches = (ignoreWhitespace: boolean) =>
    opts.fromRoot
      ? git.logPatchesFromRoot(commitTarget, { ignoreWhitespace })
      : git.logPatches(base, commitTarget, { ignoreWhitespace });
  const none: Promise<Outcome<FileEntry[]>> = Promise.resolve({
    kind: "ok",
    value: [],
  });
  const [
    net,
    exactNet,
    exactCommits,
    displayCommits,
    exactWt,
    displayWt,
    untracked,
    head,
  ] = await Promise.all([
    netDiff(ws),
    ws ? netDiff(false) : undefined,
    patches(false),
    ws ? patches(true) : undefined,
    worktree ? git.worktreeDiff() : none,
    worktree && ws ? git.worktreeDiff({ ignoreWhitespace: true }) : undefined,
    worktree ? git.untracked() : none,
    git.revParse(commitTarget),
  ]);
  for (const o of [
    net,
    exactNet,
    exactCommits,
    displayCommits,
    exactWt,
    displayWt,
    untracked,
    head,
  ]) {
    if (o !== undefined && o.kind !== "ok") return o;
  }
  // Narrowed above; re-read the values without non-null assertions.
  const val = <T>(o: Outcome<T> | undefined, fallback: T): T =>
    o?.kind === "ok" ? o.value : fallback;
  const untrackedFiles = val(untracked, []);
  const exactWtFiles = val(exactWt, []);
  const files = [...val(net, []), ...untrackedFiles];
  const canonicalFiles = ws ? [...val(exactNet, []), ...untrackedFiles] : files;
  const exact = val(exactCommits, []);
  const display = ws ? val(displayCommits, []) : exact;
  const commits: ModelCommit[] = display.map((c) => ({
    sha: c.sha,
    summary: c.summary,
    files: c.files,
  }));
  if (worktree) {
    commits.push({
      sha: WORKTREE,
      summary: "uncommitted changes",
      files: [...(ws ? val(displayWt, []) : exactWtFiles), ...untrackedFiles],
    });
  }
  return {
    kind: "ok",
    value: {
      worktree,
      files,
      commits,
      canonicalFiles,
      lineageCommits: exact,
      lineageWorktreeFiles: [...exactWtFiles, ...untrackedFiles],
      head: val(head, "" as Sha),
    },
  };
}

/** File text as lines, the way `readfile()` splits it (no trailing empty line). */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Seen-ness of one path's uncommitted lines. */
export type WorktreeSeen = {
  unseenAdds: ReadonlySet<WorktreeLnum>;
  dels: ranges.RangeSet<HeadLnum>;
};

/**
 * Prepare the worktree seen sets for every uncommitted path that has a stored
 * record (a path without one has nothing seen and needs no H or W). Reads H in
 * one `cat-file --batch` and W from disk.
 */
export async function loadWorktreeSeen(
  git: Git,
  repoRoot: string,
  store: Store,
  model: ModelData,
): Promise<Outcome<Map<RepoPath, WorktreeSeen>>> {
  const out = new Map<RepoPath, WorktreeSeen>();
  if (!model.worktree) return { kind: "ok", value: out };
  const paths = [
    ...new Set(model.lineageWorktreeFiles.map((f) => f.path)),
  ].filter((p) => store.hasBaseline(p));
  const heads = await git.showMany(model.head, paths);
  if (heads.kind !== "ok") return heads;
  for (const path of paths) {
    const blob = heads.value.get(path);
    const head = blob?.kind === "found" ? splitLines(blob.text) : [];
    const rec = store.baseline(path, contentHash(head));
    if (!rec) {
      out.set(path, { unseenAdds: new Set(), dels: [] });
      continue;
    }
    const wt = await readFile(join(repoRoot, path), "utf8").then(
      splitLines,
      () => [],
    );
    out.set(path, {
      unseenAdds: baseline.unseenAdds(rec.lines ?? head, wt),
      dels: rec.dels,
    });
  }
  return { kind: "ok", value: out };
}

/** Who owns a changed line: a commit (in its own coordinates) or the work tree. */
export type LineOwner =
  | { kind: "commit"; sha: Sha; lnum: number }
  | { kind: "worktree"; lnum: number }
  | { kind: "none" };
export type OwnerFn = (dl: DiffLine) => LineOwner;

export type Scope = "combined" | "commits";
export type Counts = {
  files: number;
  hunks: number;
  adds: number;
  dels: number;
};

function layerOwner(sha: Layer, lnum: number): LineOwner {
  return sha === WORKTREE
    ? { kind: "worktree", lnum }
    : { kind: "commit", sha, lnum };
}

/**
 * Pure classification over one model: line identities, seen-ness, rollups.
 * Recreate it whenever the model, store, or worktree seen sets change.
 */
export class Classifier {
  private readonly lineage: Map<RepoPath, lineage.PathLineage>;
  constructor(
    readonly model: ModelData,
    private readonly store: Store,
    private readonly wtSeen: ReadonlyMap<RepoPath, WorktreeSeen>,
    private readonly ignore: Matcher | undefined,
  ) {
    const patches: lineage.Patch[] = [...model.lineageCommits];
    if (model.worktree) {
      patches.push({ sha: WORKTREE, files: model.lineageWorktreeFiles });
    }
    this.lineage = lineage.compose(patches);
  }

  /** A commit-scope file's lines are owned by the commit displaying them. */
  commitOwner(commit: ModelCommit): OwnerFn {
    return (dl) => {
      if (dl.kind === "context") return { kind: "none" };
      return layerOwner(
        commit.sha,
        dl.kind === "add" ? dl.newLnum : dl.oldLnum,
      );
    };
  }

  /**
   * A combined-scope add is owned by its composed provenance; a del by the
   * commit that removed it (or the work tree when the removal is uncommitted).
   */
  combinedOwner(path: RepoPath): OwnerFn {
    const lin = this.lineage.get(path);
    const worktree = this.model.worktree;
    return (dl) => {
      if (dl.kind === "context") return { kind: "none" };
      if (dl.kind === "del") {
        const a = lin?.delAttr.get(dl.oldLnum);
        return a
          ? layerOwner(a.sha, a.lnum)
          : { kind: "worktree", lnum: dl.oldLnum };
      }
      const p = lin?.prov.get(dl.newLnum);
      if (p) return layerOwner(p.sha, p.lnum);
      // An add inherited unchanged from the base image only reads as an add
      // because the display diff aligned a repeated line differently; it owns
      // no review content.
      if (lin?.base(dl.newLnum) !== undefined || !worktree)
        return { kind: "none" };
      return { kind: "worktree", lnum: dl.newLnum };
    };
  }

  lineIdentity(
    dl: DiffLine,
    path: RepoPath,
    owner: OwnerFn,
  ): LineId | undefined {
    if (dl.kind === "context") return undefined;
    const o = owner(dl);
    switch (o.kind) {
      case "none":
        return undefined;
      case "worktree":
        return dl.kind === "add"
          ? { kind: "worktree-add", path, lnum: o.lnum as WorktreeLnum }
          : { kind: "worktree-del", path, lnum: o.lnum as HeadLnum };
      case "commit":
        return dl.kind === "add"
          ? {
              kind: "committed-add",
              sha: o.sha,
              path,
              lnum: o.lnum as PostLnum,
            }
          : {
              kind: "committed-del",
              removerSha: o.sha,
              path,
              lnum: o.lnum as PreLnum,
            };
    }
  }

  changedIds(hunk: Hunk, path: RepoPath, owner: OwnerFn): LineId[] {
    const ids: LineId[] = [];
    for (const dl of hunk.lines) {
      const id = this.lineIdentity(dl, path, owner);
      if (id) ids.push(id);
    }
    return ids;
  }

  /** Generated files are derived-seen: the store never learns about them. */
  isGenerated(path: RepoPath): boolean {
    return this.ignore?.match(path) ?? false;
  }

  idSeen(id: LineId): boolean {
    if (this.isGenerated(id.path)) return true;
    switch (id.kind) {
      case "worktree-add": {
        const s = this.wtSeen.get(id.path);
        // No record: R == H, so no uncommitted add is seen.
        return s !== undefined && !s.unseenAdds.has(id.lnum);
      }
      case "worktree-del": {
        const s = this.wtSeen.get(id.path);
        return s !== undefined && ranges.covers(s.dels, id.lnum);
      }
      default:
        return this.store.isSeen(id);
    }
  }

  /** Seen iff it has a changed line and every changed line is seen. */
  hunkSeen(hunk: Hunk, path: RepoPath, owner: OwnerFn): boolean {
    const ids = this.changedIds(hunk, path, owner);
    return ids.length > 0 && ids.every((id) => this.idSeen(id));
  }

  fileSeen(file: FileEntry, owner: OwnerFn): boolean {
    return file.hunks.every((h) => this.hunkSeen(h, file.path, owner));
  }

  commitSeen(commit: ModelCommit): boolean {
    const owner = this.commitOwner(commit);
    return commit.files.every((f) => this.fileSeen(f, owner));
  }

  /**
   * Is every file under a directory row seen? `fileIndices` index the scope's
   * file list: the commit's files in the commits scope, `model.files` otherwise.
   */
  dirSeen(
    dir:
      | {
          scope: "commits";
          commit: ModelCommit;
          fileIndices: readonly number[];
        }
      | { scope: "combined"; fileIndices: readonly number[] },
  ): boolean {
    if (dir.scope === "commits") {
      const { commit } = dir;
      const owner = this.commitOwner(commit);
      return dir.fileIndices.every((i) => {
        const f = commit.files[i];
        return f !== undefined && this.fileSeen(f, owner);
      });
    }
    return dir.fileIndices.every((i) => {
      const f = this.model.files[i];
      return f !== undefined && this.fileSeen(f, this.combinedOwner(f.path));
    });
  }
  /** Unreviewed work in a scope; a changed line with no identity counts as unseen. */
  progressCounts(scope: Scope): Counts {
    const counts: Counts = { files: 0, hunks: 0, adds: 0, dels: 0 };
    const countFile = (file: FileEntry, owner: OwnerFn) => {
      let fileUnseen = false;
      for (const hunk of file.hunks) {
        let hunkUnseen = false;
        for (const dl of hunk.lines) {
          if (dl.kind === "context") continue;
          const id = this.lineIdentity(dl, file.path, owner);
          if (!id || !this.idSeen(id)) {
            hunkUnseen = true;
            counts[dl.kind === "add" ? "adds" : "dels"]++;
          }
        }
        if (hunkUnseen) {
          fileUnseen = true;
          counts.hunks++;
        }
      }
      if (fileUnseen) counts.files++;
    };
    if (scope === "commits") {
      for (const c of this.model.commits) {
        const owner = this.commitOwner(c);
        for (const f of c.files) countFile(f, owner);
      }
    } else {
      for (const f of this.model.files)
        countFile(f, this.combinedOwner(f.path));
    }
    return counts;
  }
}
