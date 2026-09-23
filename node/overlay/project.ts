/**
 * The file-buffer comment overlay, pure half (port of `overlay.lua`): resolve
 * records against a buffer's lines, and describe the extmarks, float and
 * quickfix entries that show them. A comment's position is never tracked; it
 * is re-resolved by content on every event that can change the text.
 */
import { fileProjection, locate } from "../core/comments.ts";
import type { CommentRecord } from "../core/state.ts";
import type { RepoPath } from "../core/types.ts";

const EOL_WIDTH = 60;
export function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > EOL_WIDTH ? `${line.slice(0, EOL_WIDTH - 1)}…` : line;
}

export type OverlayEntry = {
  record: CommentRecord;
  outdated: boolean;
  /** Rows the comment spans in the file (1 when outdated). */
  length: number;
};
export type OverlayGroup = { lnum: number; entries: OverlayEntry[] };

/**
 * Group `records` by the line they resolve to in `lines`, ordered by line. A
 * record with no file projection (del-only) has no file position and is
 * skipped. A record whose resolved line differs from its stored `lnum` is
 * updated in place and reported through `moved`, so the caller persists it.
 */
export function resolveOverlay(
  records: readonly CommentRecord[],
  lines: readonly string[],
): { groups: OverlayGroup[]; moved: boolean } {
  const last = Math.max(lines.length, 1);
  const byLnum = new Map<number, OverlayGroup>();
  let moved = false;
  for (const record of records) {
    const run = fileProjection(record);
    if (run.length === 0) continue;
    const loc = locate(record, lines, undefined, "file");
    const lnum = Math.max(1, Math.min(loc.lnum, last));
    if (record.lnum !== lnum) {
      record.lnum = lnum;
      moved = true;
    }
    let group = byLnum.get(lnum);
    if (!group) {
      group = { lnum, entries: [] };
      byLnum.set(lnum, group);
    }
    const outdated = loc.kind === "outdated";
    group.entries.push({ record, outdated, length: outdated ? 1 : run.length });
  }
  const groups = [...byLnum.values()].sort((a, b) => a.lnum - b.lnum);
  return { groups, moved };
}

export type BodyLine = { text: string; hl: string };
/** The body (and any agent reply) of a record, as display lines. */
export function bodyLines(record: CommentRecord): BodyLine[] {
  const out: BodyLine[] = record.text
    .split("\n")
    .map((text) => ({ text, hl: "GleanComment" }));
  if (record.reply)
    for (const l of record.reply.split("\n"))
      out.push({ text: `↳ ${l}`, hl: "GleanCommentReply" });
  return out;
}

export type Stamp = { row: number; opts: Record<string, unknown> };
/** The extmarks (0-based rows) of one buffer, given its line count. */
export function stamps(
  groups: readonly OverlayGroup[],
  inline: boolean,
  total: number,
): Stamp[] {
  const out: Stamp[] = [];
  for (const group of groups) {
    const { entries } = group;
    const head = entries[0];
    if (!head) continue;
    const allOutdated = entries.every((e) => e.outdated);
    const length = Math.max(1, ...entries.map((e) => e.length));
    const hl = allOutdated ? "GleanCommentOutdated" : "GleanComment";
    let label = `#${head.record.id} ${firstLine(head.record.text)}`;
    if (entries.length > 1) label += ` (+${entries.length - 1} more)`;
    if (allOutdated) label += " (outdated)";
    const opts: Record<string, unknown> = {
      sign_text: "💬",
      sign_hl_group: hl,
      virt_text: [[` ${label}`, hl]],
      virt_text_pos: "eol",
      hl_mode: "combine",
    };
    if (inline)
      opts.virt_lines = entries.flatMap((e) =>
        bodyLines(e.record).map((l) => [[`  ${l.text}`, l.hl]]),
      );
    out.push({ row: group.lnum - 1, opts });
    // Make a multi-line comment's extent visible.
    if (length > 1)
      for (
        let l = group.lnum;
        l <= Math.min(group.lnum + length - 1, total);
        l++
      )
        out.push({ row: l - 1, opts: { line_hl_group: "GleanCommentLine" } });
  }
  return out;
}

/** Every record resolving to `lnum`. */
export function recordsAt(
  groups: readonly OverlayGroup[],
  lnum: number,
): CommentRecord[] {
  return groups
    .filter((g) => g.lnum === lnum)
    .flatMap((g) => g.entries.map((e) => e.record));
}

/** The float's lines and per-line (0-based) highlight groups. */
export function floatLines(records: readonly CommentRecord[]): BodyLine[] {
  const out: BodyLine[] = [];
  for (const record of records) {
    if (out.length > 0) out.push({ text: "", hl: "" });
    out.push({ text: `#${record.id}`, hl: "GleanCommentId" });
    out.push(...bodyLines(record));
  }
  return out;
}

/** The nearest commented line after (dir 1) or before (dir -1) `cur`. */
export function jumpLnum(
  groups: readonly OverlayGroup[],
  cur: number,
  dir: 1 | -1,
): number | undefined {
  let best: number | undefined;
  for (const { lnum } of groups) {
    if (dir > 0 && lnum > cur && (best === undefined || lnum < best))
      best = lnum;
    if (dir < 0 && lnum < cur && (best === undefined || lnum > best))
      best = lnum;
  }
  return best;
}

export type QuickfixItem = { filename: string; lnum: number; text: string };
/**
 * Every comment in the repo, resolved against the working tree. A record with
 * no file projection, or whose file is unreadable, is listed at its stored
 * lnum and marked outdated rather than dropped.
 */
export function quickfixItems(
  root: string,
  files: readonly {
    path: RepoPath;
    records: readonly CommentRecord[];
    lines: readonly string[] | undefined;
  }[],
): QuickfixItem[] {
  return files.flatMap(({ path, records, lines }) =>
    records.map((record) => {
      let lnum = record.lnum;
      let outdated = true;
      if (lines && fileProjection(record).length > 0) {
        const loc = locate(record, lines, undefined, "file");
        lnum = Math.max(1, Math.min(loc.lnum, Math.max(lines.length, 1)));
        outdated = loc.kind === "outdated";
      }
      return {
        filename: `${root}/${path}`,
        lnum,
        text: `#${record.id} ${firstLine(record.text)}${outdated ? " (outdated)" : ""}`,
      };
    }),
  );
}
