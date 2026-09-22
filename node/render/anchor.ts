/**
 * Scope-toggle cursor preservation (port of `Session:cursor_anchor` /
 * `restore_cursor_anchor`). Both scopes derive the same identity for the same
 * physical line, so an exact identity match survives a toggle; otherwise it
 * degrades to the same owner's nearest line, the nearest display line in the
 * file, then the file header.
 */
import type { DiffLine } from "../core/diff.ts";
import type { LineId, RepoPath } from "../core/types.ts";
import type { Classifier } from "../session/model.ts";
import { resolveFile } from "./actions.ts";
import type { Frame, RowTarget } from "./render.ts";

export type CursorAnchor =
  | { kind: "header"; path: RepoPath }
  | {
      kind: "line";
      path: RepoPath;
      sha: string | undefined;
      line: DiffLine;
      id: LineId | undefined;
    };

type LineRow = Extract<RowTarget, { kind: "line" }>;

function rowLine(cls: Classifier, t: LineRow) {
  const r = resolveFile(cls, t.file);
  const dl = r?.file.hunks[t.hunk]?.lines[t.li];
  if (!r || !dl) return undefined;
  return { r, dl, id: cls.lineIdentity(dl, r.file.path, r.owner) };
}

function idKey(id: LineId): string {
  return JSON.stringify(id);
}

function idOwner(id: LineId): string {
  switch (id.kind) {
    case "committed-add":
      return id.sha;
    case "committed-del":
      return id.removerSha;
    default:
      return `worktree:${id.path}`;
  }
}

export function cursorAnchor(
  cls: Classifier,
  t: RowTarget | undefined,
): CursorAnchor | undefined {
  if (!t) return undefined;
  if (t.kind === "line") {
    const l = rowLine(cls, t);
    if (!l) return undefined;
    return {
      kind: "line",
      path: l.r.file.path,
      sha: l.r.sha,
      line: l.dl,
      id: l.id,
    };
  }
  if (
    t.kind === "file-header" ||
    t.kind === "hunk-header" ||
    t.kind === "seen-section" ||
    t.kind === "divider"
  ) {
    const r = resolveFile(cls, t.file);
    return r && { kind: "header", path: r.file.path };
  }
  return undefined;
}

function lineDistance(a: DiffLine, b: DiffLine): number {
  if (a.kind !== "del" && b.kind !== "del")
    return Math.abs(a.newLnum - b.newLnum);
  if (a.kind !== "add" && b.kind !== "add")
    return Math.abs(a.oldLnum - b.oldLnum);
  return Math.abs(a.newLnum - b.newLnum);
}

/** The row to place the cursor on, or undefined when the file is absent. */
export function restoreAnchor(
  cls: Classifier,
  frame: Frame,
  anchor: CursorAnchor,
): number | undefined {
  let header: number | undefined;
  frame.rows.forEach((t, row) => {
    if (header !== undefined || t.kind !== "file-header") return;
    if (resolveFile(cls, t.file)?.file.path === anchor.path) header = row;
  });
  if (anchor.kind === "header") return header;
  type Best = { row: number; score: number } | undefined;
  const better = (b: Best, row: number, score: number): Best =>
    !b || score < b.score ? { row, score } : b;
  let exact: Best;
  let owner: Best;
  let best: Best;
  const key = anchor.id && idKey(anchor.id);
  frame.rows.forEach((t, row) => {
    if (t.kind !== "line") return;
    const l = rowLine(cls, t);
    if (!l || l.r.file.path !== anchor.path) return;
    const distance = lineDistance(anchor.line, l.dl);
    if (anchor.id && l.id) {
      if (idKey(l.id) === key) exact = better(exact, row, distance);
      else if (idOwner(l.id) === idOwner(anchor.id)) {
        const score =
          Math.abs(l.id.lnum - anchor.id.lnum) * 10 +
          (l.id.kind === anchor.id.kind ? 0 : 1);
        owner = better(owner, row, score);
      }
    }
    let score = distance * 10;
    if (anchor.sha !== undefined && l.r.sha !== anchor.sha) score += 1e6;
    if (l.dl.kind !== anchor.line.kind) score += 1;
    best = better(best, row, score);
  });
  return (exact ?? owner ?? best)?.row ?? header;
}
