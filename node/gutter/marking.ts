/**
 * The file-buffer side of the seen model: the gutter projection of one path
 * and its inverse (`:Glean toggle-mark`), both over the combined scope.
 */
import type { LineId, RepoPath } from "../core/types.ts";
import type { SeenPlan, Sticky } from "../render/actions.ts";
import type { Classifier } from "../session/model.ts";
import { type GutterMarks, type GutterSource, project } from "./project.ts";

/** Undefined when the review is not work-tree targeted or lacks the path. */
export function fileStatus(
  cls: Classifier,
  path: RepoPath,
): GutterMarks | undefined {
  if (!cls.model.worktree) return undefined;
  const file = cls.model.files.find((f) => f.path === path);
  if (!file) return undefined;
  const owner = cls.combinedOwner(path);
  return project(file.hunks, (dl) => {
    const id = cls.lineIdentity(dl, path, owner);
    return id !== undefined && cls.idSeen(id);
  });
}

export type FilePlan =
  | { kind: "ok"; plan: SeenPlan }
  | { kind: "inert"; reason: string };

/**
 * Flip rows `srow..erow` (1-based, inclusive) of `path`'s post-image. With
 * `expandHunk`, rows widen to every line of their hunks. The op is mark unless
 * every addressed identity is already seen, so a partial selection completes.
 */
export function planFileMarks(
  cls: Classifier,
  path: RepoPath,
  srow: number,
  erow: number,
  expandHunk: boolean,
): FilePlan {
  const marks = fileStatus(cls, path);
  const file = cls.model.files.find((f) => f.path === path);
  if (!marks || !file)
    return { kind: "inert", reason: "no live review for this file" };
  const picked = new Map<string, GutterSource>();
  const take = (s: GutterSource) => picked.set(`${s.hunk}:${s.li}`, s);
  const hunks = new Set<number>();
  for (let l = Math.min(srow, erow); l <= Math.max(srow, erow); l++)
    for (const s of marks.get(l)?.sources ?? [])
      if (expandHunk) hunks.add(s.hunk);
      else take(s);
  for (const hi of [...hunks].sort((a, b) => a - b))
    for (let li = 0; li < (file.hunks[hi]?.lines.length ?? 0); li++)
      take({ hunk: hi, li });
  const owner = cls.combinedOwner(path);
  const ids: LineId[] = [];
  const sticky: Sticky[] = [];
  for (const s of picked.values()) {
    const dl = file.hunks[s.hunk]?.lines[s.li];
    const id = dl && cls.lineIdentity(dl, path, owner);
    if (!dl || !id) continue;
    ids.push(id);
    sticky.push({ path, text: dl.text });
  }
  if (ids.length === 0)
    return { kind: "inert", reason: "no reviewable lines in the selection" };
  const op = ids.every((id) => cls.idSeen(id)) ? "unmark" : "mark";
  return { kind: "ok", plan: { op, ids, sticky, clear: [] } };
}
