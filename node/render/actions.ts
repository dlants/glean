/**
 * Pure planners for the row actions of the review buffer (port of
 * `Session:toggle_seen` / `collapse_action` and friends). Each takes the
 * current frame plus classifier and returns what to change; the session applies
 * seen edits to the store and the view owns cursor placement.
 */
import type { FileEntry, Hunk } from "../core/diff.ts";
import { type LineId, type RepoPath, WORKTREE } from "../core/types.ts";
import type { Classifier, OwnerFn, Scope } from "../session/model.ts";
import {
  type CollapseKey,
  type CollapseState,
  type FileRef,
  type Frame,
  keys,
  type RowTarget,
  type Sec,
} from "./render.ts";

type Resolved = { file: FileEntry; owner: OwnerFn; sha: string | undefined };

export function resolveFile(
  cls: Classifier,
  ref: FileRef,
): Resolved | undefined {
  if (ref.scope === "combined") {
    const file = cls.model.files[ref.file];
    return (
      file && { file, owner: cls.combinedOwner(file.path), sha: undefined }
    );
  }
  const commit = cls.model.commits[ref.commit];
  const file = commit?.files[ref.file];
  return (
    commit && file && { file, owner: cls.commitOwner(commit), sha: commit.sha }
  );
}

/** Every (file, hunks) pair a row addresses; empty for non-markable rows. */
function targetHunks(
  cls: Classifier,
  t: RowTarget,
): { path: RepoPath; owner: OwnerFn; hunks: Hunk[] }[] {
  const whole = (r: Resolved | undefined) =>
    r ? [{ path: r.file.path, owner: r.owner, hunks: r.file.hunks }] : [];
  switch (t.kind) {
    case "commit-header": {
      const commit = cls.model.commits[t.commit];
      if (!commit) return [];
      const owner = cls.commitOwner(commit);
      return commit.files.map((f) => ({ path: f.path, owner, hunks: f.hunks }));
    }
    case "dir":
      return t.files.flatMap((i) =>
        whole(
          resolveFile(
            cls,
            t.scope === "combined" || t.commit === undefined
              ? { scope: "combined", file: i }
              : { scope: "commits", commit: t.commit, file: i },
          ),
        ),
      );
    case "file-header":
      return whole(resolveFile(cls, t.file));
    case "hunk-header":
    case "line": {
      const r = resolveFile(cls, t.file);
      const h = r?.file.hunks[t.hunk];
      return r && h ? [{ path: r.file.path, owner: r.owner, hunks: [h] }] : [];
    }
    default:
      return [];
  }
}

export function targetIds(cls: Classifier, t: RowTarget): LineId[] {
  return targetHunks(cls, t).flatMap(({ path, owner, hunks }) =>
    hunks.flatMap((h) => cls.changedIds(h, path, owner)),
  );
}

export type Sticky = { path: RepoPath; text: string };

export type SeenPlan = {
  op: "mark" | "unmark";
  ids: LineId[];
  /** Combined scope only: explicit marks exempt lines from demotion. */
  sticky: Sticky[];
  /** Overrides to drop so marked content re-collapses to its default. */
  clear: CollapseKey[];
};

/**
 * What `m` does on a row. A hunk row's section decides the op (seen → unmark,
 * unseen → mark); a header falls back to whether everything is already seen.
 * Marker rows unmark their run.
 */
export function planToggleSeen(
  cls: Classifier,
  scope: Scope,
  t: RowTarget,
): SeenPlan | undefined {
  if (t.kind === "marker" || t.kind === "marker-line") {
    const r = resolveFile(cls, t.file);
    const h = r?.file.hunks[t.hunk];
    if (!r || !h) return undefined;
    const run = t.kind === "marker" ? t.run : undefined;
    const lo = run ? run.lo : 0;
    const hi = run ? run.hi : h.lines.length - 1;
    const ids: LineId[] = [];
    h.lines.forEach((dl, i) => {
      if (i < lo || i > hi) return;
      const id = cls.lineIdentity(dl, r.file.path, r.owner);
      if (id && cls.idSeen(id)) ids.push(id);
    });
    return { op: "unmark", ids, sticky: [], clear: [] };
  }
  const parts = targetHunks(cls, t);
  if (parts.length === 0) return undefined;
  const ids = targetIds(cls, t);
  const op =
    t.kind === "hunk-header" || t.kind === "line"
      ? t.sec === "seen"
        ? "unmark"
        : "mark"
      : ids.every((id) => cls.idSeen(id))
        ? "unmark"
        : "mark";
  const changed = ids.filter((id) => (op === "mark") !== cls.idSeen(id));
  const sticky: Sticky[] =
    scope === "combined"
      ? parts.flatMap(({ path, hunks }) =>
          hunks.flatMap((h) =>
            h.lines
              .filter((dl) => dl.kind !== "context")
              .map((dl) => ({ path, text: dl.text })),
          ),
        )
      : [];
  if (changed.length === 0 && sticky.length === 0) return undefined;
  const clear: CollapseKey[] = [];
  if (op === "mark") {
    for (const id of changed) {
      if (scope === "combined") clear.push(keys.cseen(id.path));
      else {
        const sha =
          id.kind === "committed-add"
            ? id.sha
            : id.kind === "committed-del"
              ? id.removerSha
              : undefined;
        clear.push(keys.seen(sha ?? WORKTREE, id.path));
      }
    }
    if (t.kind === "dir") {
      const sha =
        t.commit === undefined ? undefined : cls.model.commits[t.commit]?.sha;
      clear.push(
        sha === undefined ? keys.cdir(t.prefix) : keys.dir(sha, t.prefix),
      );
    }
  }
  return { op, ids: changed, sticky, clear: [...new Set(clear)] };
}

/** The collapse key a row toggles and its current effective state. */
export function collapseTarget(
  cls: Classifier,
  collapse: CollapseState,
  t: RowTarget,
): { key: CollapseKey; collapsed: boolean } | undefined {
  const eff = (key: CollapseKey, dflt: boolean) => ({
    key,
    collapsed: collapse.get(key) ?? dflt,
  });
  switch (t.kind) {
    case "commit-header": {
      const c = cls.model.commits[t.commit];
      return c && eff(keys.commit(c.sha), cls.commitSeen(c));
    }
    case "dir": {
      if (t.scope === "combined" || t.commit === undefined)
        return eff(
          keys.cdir(t.prefix),
          cls.dirSeen({ scope: "combined", fileIndices: t.files }),
        );
      const commit = cls.model.commits[t.commit];
      return (
        commit &&
        eff(
          keys.dir(commit.sha, t.prefix),
          cls.dirSeen({ scope: "commits", commit, fileIndices: t.files }),
        )
      );
    }
    case "file-header": {
      const r = resolveFile(cls, t.file);
      if (!r) return undefined;
      return r.sha === undefined
        ? eff(keys.cfile(r.file.path), false)
        : eff(keys.file(r.sha, r.file.path), cls.fileSeen(r.file, r.owner));
    }
    case "seen-section": {
      const r = resolveFile(cls, t.file);
      if (!r) return undefined;
      return r.sha === undefined
        ? eff(keys.cseen(r.file.path), true)
        : eff(keys.seen(r.sha, r.file.path), true);
    }
    case "marker":
    case "marker-line":
      return eff(keys.marker(t.key), true);
    default:
      return undefined;
  }
}

export function toggleCollapse(
  cls: Classifier,
  collapse: CollapseState,
  t: RowTarget,
): CollapseState | undefined {
  const c = collapseTarget(cls, collapse, t);
  if (!c) return undefined;
  return new Map(collapse).set(c.key, !c.collapsed);
}

/** Stable address of a hunk across renders (independent of its row). */
export function hunkKey(t: RowTarget): string | undefined {
  if (t.kind !== "hunk-header" && t.kind !== "line") return undefined;
  const f = t.file;
  return f.scope === "combined"
    ? `f:${f.file}:${t.hunk}`
    : `c:${f.commit}:${f.file}:${t.hunk}`;
}

/** Next still-unseen hunk header after `row`, other than the row's own hunk. */
export function nextUnseenHunk(frame: Frame, row: number): string | undefined {
  const cur = frame.rows[row] && hunkKey(frame.rows[row]);
  for (let r = row + 1; r < frame.rows.length; r++) {
    const t = frame.rows[r];
    if (t?.kind === "hunk-header" && t.sec === "unseen" && hunkKey(t) !== cur)
      return hunkKey(t);
  }
  return undefined;
}

export function rowOfHunk(frame: Frame, key: string): number | undefined {
  const r = frame.rows.findIndex(
    (t) => t.kind === "hunk-header" && hunkKey(t) === key,
  );
  return r < 0 ? undefined : r;
}

function sameFile(a: FileRef, b: FileRef): boolean {
  return a.scope === "combined"
    ? b.scope === "combined" && a.file === b.file
    : b.scope === "commits" && a.commit === b.commit && a.file === b.file;
}

/**
 * Where to land after un-marking the hunk at `row`: the next seen hunk of the
 * same file after it, else the file's first unseen hunk, else the hunk itself.
 * Captured before the unmark because the revived hunk's rows relocate.
 */
export function reviveDest(frame: Frame, row: number): string | undefined {
  const target = frame.rows[row];
  if (!target || (target.kind !== "hunk-header" && target.kind !== "line"))
    return undefined;
  const cur = hunkKey(target);
  const inFile = (t: RowTarget | undefined, sec: Sec) =>
    t?.kind === "hunk-header" && t.sec === sec && sameFile(t.file, target.file);
  for (let r = row + 1; r < frame.rows.length; r++) {
    const t = frame.rows[r];
    if (t && inFile(t, "seen") && hunkKey(t) !== cur) return hunkKey(t);
  }
  const first = frame.rows.find((t) => inFile(t, "unseen"));
  return first ? hunkKey(first) : cur;
}
