/**
 * Pure projection of the model into buffer rows (port of `Session:build`):
 * lines, highlights, a `RowTarget` per row, the top-level sections used to
 * diff frames, and the del/add replace blocks handed to the async intraline
 * refiner. Comments are not rendered yet (they move with the 4c reducer).
 */

import type { DiffLine, FileEntry, Hunk } from "../core/diff.ts";
import { dirLayout } from "../core/dirtree.ts";
import type { LineId, RepoPath } from "../core/types.ts";
import type {
  Classifier,
  ModelCommit,
  OwnerFn,
  Scope,
} from "../session/model.ts";
import type { PlacedComment, SummaryGroup } from "./comments.ts";
import {
  displaySeenSet,
  hunkMarkerRuns,
  type MarkerKey,
  type MarkerRun,
  markerKey,
} from "./markers.ts";

export const CHEVRON_OPEN = "▼";
export const CHEVRON_CLOSED = "▶";

declare const collapseKeyBrand: unique symbol;
/** A view-state collapse key; never persisted. */
export type CollapseKey = string & { readonly [collapseKeyBrand]: true };
const ck = (s: string) => s as CollapseKey;
export const keys = {
  commit: (sha: string) => ck(`c:${sha}`),
  file: (sha: string, path: RepoPath) => ck(`f:${sha}\0${path}`),
  cfile: (path: RepoPath) => ck(`cf:${path}`),
  seen: (sha: string, path: RepoPath) => ck(`s:${sha}\0${path}`),
  cseen: (path: RepoPath) => ck(`cs:${path}`),
  dir: (sha: string, prefix: string) => ck(`d:${sha}\0${prefix}`),
  cdir: (prefix: string) => ck(`cd:${prefix}`),
  marker: (k: MarkerKey) => k as string as CollapseKey,
};
/** Explicit collapse overrides; an absent key takes the row kind's default. */
export type CollapseState = ReadonlyMap<CollapseKey, boolean>;

/** Which file a row belongs to, in the scope that rendered it. */
export type FileRef =
  | { scope: "commits"; commit: number; file: number }
  | { scope: "combined"; file: number };

/** Which section of its file a hunk renders in. */
export type Sec = "seen" | "unseen";

export type RowTarget =
  | { kind: "blank" }
  | { kind: "mode-header" }
  | { kind: "commit-header"; commit: number }
  | {
      kind: "dir";
      scope: "commits" | "combined";
      commit: number | undefined;
      prefix: string;
      files: readonly number[];
    }
  | { kind: "file-header"; file: FileRef }
  | { kind: "seen-section"; file: FileRef }
  | { kind: "divider"; file: FileRef }
  | { kind: "hunk-header"; file: FileRef; hunk: number; sec: Sec }
  | {
      kind: "comment";
      file: FileRef;
      hunk: number;
      li: number;
      commentId: number;
    }
  | { kind: "line"; file: FileRef; hunk: number; li: number; sec: Sec }
  | { kind: "summary-header" }
  | { kind: "summary-file"; path: RepoPath }
  | { kind: "summary-comment"; path: RepoPath; commentId: number }
  | {
      kind: "marker";
      file: FileRef;
      hunk: number;
      run: MarkerRun;
      key: MarkerKey;
    }
  | {
      kind: "marker-line";
      file: FileRef;
      hunk: number;
      li: number;
      key: MarkerKey;
    };

export type Highlight =
  | { kind: "line"; row: number; hl: string; sign?: "+" | "-" | " " }
  | { kind: "span"; row: number; hl: string; startCol: number; endCol: number };

export type Section = { key: string; lo: number; hi: number };
export type IntraBlock = {
  dels: { row: number; text: string }[];
  adds: { row: number; text: string }[];
};

export type Frame = {
  lines: string[];
  rows: RowTarget[];
  highlights: Highlight[];
  sections: Section[];
  intraBlocks: IntraBlock[];
};

export type RenderInput = {
  scope: Scope;
  cls: Classifier;
  collapse: CollapseState;
  isSticky: (path: RepoPath, text: string) => boolean;
  minSeenRun: number;
  ignoreWhitespace: boolean;
  /** Comments placed per display file, keyed by 0-based flattened line index (see `resolveComments`). */
  comments?: (
    ref: FileRef,
    file: FileEntry,
  ) => ReadonlyMap<number, readonly PlacedComment[]>;
  /** The bottom comment summary (see `collectComments`). */
  summary?: readonly SummaryGroup[];
};

/** Summary rows are laid out, not soft-wrapped, so the frame stays a pure list of strings. */
const SUMMARY_WIDTH = 100;
const chars = (s: string) => [...s].length;
function wrapText(text: string, indent: string, cont: string): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let lead = indent;
    let room = SUMMARY_WIDTH - chars(lead);
    let line: string | undefined;
    for (const word of para.split(/\s+/).filter((w) => w !== "")) {
      if (line === undefined) line = word;
      else if (chars(line) + 1 + chars(word) <= room) line = `${line} ${word}`;
      else {
        out.push(lead + line);
        lead = cont;
        room = SUMMARY_WIDTH - chars(cont);
        line = word;
      }
    }
    out.push(lead + (line ?? ""));
  }
  return out;
}

const sign = (dl: DiffLine) =>
  dl.kind === "add" ? "+" : dl.kind === "del" ? "-" : " ";
const lineHl = (dl: DiffLine) =>
  dl.kind === "add"
    ? "GleanAdd"
    : dl.kind === "del"
      ? "GleanDel"
      : "GleanContext";
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

export function render(input: RenderInput): Frame {
  const { scope, cls, collapse } = input;
  const model = cls.model;
  const f: Frame = {
    lines: [],
    rows: [],
    highlights: [],
    sections: [],
    intraBlocks: [],
  };
  const section = (key: string, fn: () => void) => {
    const lo = f.lines.length;
    fn();
    f.sections.push({ key, lo, hi: f.lines.length });
  };
  const emit = (
    text: string,
    target: RowTarget,
    hl?: string,
    s?: "+" | "-" | " ",
  ): number => {
    // Every row must be a single buffer line.
    f.lines.push(text.replace(/[\r\n]/g, " "));
    f.rows.push(target);
    const row = f.lines.length - 1;
    if (hl !== undefined) {
      f.highlights.push(
        s === undefined
          ? { kind: "line", row, hl }
          : { kind: "line", row, hl, sign: s },
      );
    }
    return row;
  };
  const span = (row: number, startCol: number, endCol: number, hl: string) =>
    f.highlights.push({ kind: "span", row, hl, startCol, endCol });
  const isCollapsed = (key: CollapseKey, dflt: boolean) =>
    collapse.get(key) ?? dflt;

  /** "(seen / unseen)" hunk tally of a collapsed row. */
  const summary = (files: readonly { file: FileEntry; owner: OwnerFn }[]) => {
    let seen = 0;
    let total = 0;
    for (const { file, owner } of files) {
      for (const h of file.hunks) {
        const ids = cls.changedIds(h, file.path, owner);
        if (ids.length === 0) continue;
        total++;
        if (ids.every((id: LineId) => cls.idSeen(id))) seen++;
      }
    }
    return total === 0 ? "" : `  (${seen} seen / ${total - seen} unseen)`;
  };

  const emitHunk = (
    hunk: Hunk,
    hi: number,
    file: FileEntry,
    ref: FileRef,
    owner: OwnerFn,
    inSeen: boolean,
  ) => {
    const sec: Sec = inSeen ? "seen" : "unseen";
    const placed = input.comments?.(ref, file);
    let base = 0;
    for (let k = 0; k < hi; k++) base += file.hunks[k]?.lines.length ?? 0;
    const emitComments = (li: number) => {
      for (const pc of placed?.get(base + li) ?? []) {
        const tag = pc.outdated ? " (outdated)" : "";
        emit(
          `    💬${tag} ${pc.record.text}`,
          { kind: "comment", file: ref, hunk: hi, li, commentId: pc.record.id },
          "GleanComment",
        );
        if (pc.record.reply !== undefined)
          emit(
            `      ↳ ${pc.record.reply}`,
            {
              kind: "comment",
              file: ref,
              hunk: hi,
              li,
              commentId: pc.record.id,
            },
            "GleanCommentReply",
          );
      }
    };
    emit(
      `--- ${hunk.header}`,
      { kind: "hunk-header", file: ref, hunk: hi, sec },
      "GleanHunkHeader",
    );
    let runs: MarkerRun[] = [];
    if (!inSeen) {
      runs = hunkMarkerRuns(hunk, (dl) => {
        const id = cls.lineIdentity(dl, file.path, owner);
        return id !== undefined && cls.idSeen(id);
      });
      if (scope === "combined") {
        const display = displaySeenSet(runs, input.minSeenRun, (i) =>
          input.isSticky(file.path, hunk.lines[i]?.text ?? ""),
        );
        runs = hunkMarkerRuns(hunk, (_, i) => display.has(i));
      }
    }
    const runAt = new Map(runs.map((r) => [r.lo, r]));
    let dels: IntraBlock["dels"] = [];
    let adds: IntraBlock["adds"] = [];
    const flush = () => {
      if (dels.length > 0 && adds.length > 0)
        f.intraBlocks.push({ dels, adds });
      dels = [];
      adds = [];
    };
    let li = 0;
    while (li < hunk.lines.length) {
      const run = runAt.get(li);
      if (run) {
        const key = markerKey(scope, file.path, run.texts);
        const n = run.texts.length;
        const label = `marked ${n} line${n === 1 ? "" : "s"}`;
        const mt: RowTarget = { kind: "marker", file: ref, hunk: hi, run, key };
        if (isCollapsed(keys.marker(key), true)) {
          emit(`  ✓ ${label}`, mt, "GleanSeen");
        } else {
          emit(`  ${CHEVRON_OPEN} ✓ ${label}`, mt, "GleanSeen");
          for (let ri = run.lo; ri <= run.hi; ri++) {
            const dl = hunk.lines[ri];
            if (!dl) continue;
            emit(
              dl.text,
              { kind: "marker-line", file: ref, hunk: hi, li: ri, key },
              "GleanSeen",
              sign(dl),
            );
          }
        }
        flush();
        li = run.hi + 1;
        continue;
      }
      const dl = hunk.lines[li];
      if (!dl) break;
      const row = emit(
        dl.text,
        { kind: "line", file: ref, hunk: hi, li, sec },
        lineHl(dl),
        sign(dl),
      );
      emitComments(li);
      if (dl.kind === "del") {
        if (adds.length > 0) flush();
        dels.push({ row, text: dl.text });
      } else if (dl.kind === "add") {
        adds.push({ row, text: dl.text });
      } else {
        flush();
      }
      li++;
    }
    flush();
  };

  const emitFileBody = (
    file: FileEntry,
    ref: FileRef,
    owner: OwnerFn,
    seenKey: CollapseKey,
    indent: string,
  ) => {
    const seenIdx: number[] = [];
    const unseenIdx: number[] = [];
    file.hunks.forEach((h, i) => {
      (cls.hunkSeen(h, file.path, owner) ? seenIdx : unseenIdx).push(i);
    });
    let emitted = false;
    const body = (hi: number, inSeen: boolean) => {
      const hunk = file.hunks[hi];
      if (!hunk) return;
      if (emitted) emit("", { kind: "blank" });
      emitHunk(hunk, hi, file, ref, owner, inSeen);
      emitted = true;
    };
    let seenExpanded = false;
    if (seenIdx.length > 0) {
      const c = isCollapsed(seenKey, true);
      seenExpanded = !c;
      emit(
        `${indent}${c ? CHEVRON_CLOSED : CHEVRON_OPEN} seen (${seenIdx.length} hunks)`,
        { kind: "seen-section", file: ref },
        "GleanSeen",
      );
      if (!c) for (const hi of seenIdx) body(hi, true);
    }
    if (seenExpanded && unseenIdx.length > 0) {
      emit("--- unseen ---", { kind: "divider", file: ref }, "GleanDivider");
    }
    for (const hi of unseenIdx) body(hi, false);
  };

  section("header", () => {
    let mode = scope === "combined" ? "combined" : "commit-by-commit";
    if (input.ignoreWhitespace) mode += " · ignore-whitespace";
    const p = cls.progressCounts(scope);
    const head = `── ${mode} ──  unreviewed: ${plural(p.files, "file", "files")} / ${plural(p.hunks, "hunk", "hunks")} `;
    const a = `+${p.adds}`;
    const d = `-${p.dels}`;
    const row = emit(
      `${head}[${a} / ${d}]`,
      { kind: "mode-header" },
      "GleanModeHeader",
    );
    // Byte offsets: the prefix holds multibyte box-drawing characters.
    const astart = Buffer.byteLength(head) + 1;
    const dstart = astart + a.length + 3;
    span(row, astart, astart + a.length, "GleanAddText");
    span(row, dstart, dstart + d.length, "GleanDelText");
  });

  if (scope === "commits") {
    model.commits.forEach((commit, ci) => {
      section(`commit:${commit.sha}`, () => renderCommit(commit, ci));
    });
  } else {
    const layout = dirLayout(model.files.map((x) => x.path));
    let skip: number | undefined;
    layout.forEach((node, ni) => {
      if (skip !== undefined && node.depth <= skip) skip = undefined;
      if (skip !== undefined) return;
      if (node.kind === "dir") {
        section(`dir:${ni}:${node.prefix}`, () => {
          const files = node.files;
          const c = isCollapsed(
            keys.cdir(node.prefix),
            cls.dirSeen({ scope: "combined", fileIndices: files }),
          );
          const tally = c
            ? summary(
                files.flatMap((i) => {
                  const file = model.files[i];
                  return file
                    ? [{ file, owner: cls.combinedOwner(file.path) }]
                    : [];
                }),
              )
            : "";
          emit(
            `${"  ".repeat(node.depth)}${c ? CHEVRON_CLOSED : CHEVRON_OPEN} ${node.prefix}/${tally}`,
            {
              kind: "dir",
              scope: "combined",
              commit: undefined,
              prefix: node.prefix,
              files,
            },
            "GleanFileHeader",
          );
          if (c) skip = node.depth;
        });
        return;
      }
      const file = model.files[node.index];
      if (!file) return;
      section(`cf:${file.path}`, () => {
        const ref: FileRef = { scope: "combined", file: node.index };
        const owner = cls.combinedOwner(file.path);
        const c = isCollapsed(keys.cfile(file.path), false);
        const tally = c ? summary([{ file, owner }]) : "";
        emit(
          `${"  ".repeat(node.depth)}${c ? CHEVRON_CLOSED : CHEVRON_OPEN} ${file.path} [${file.kind}]${tally}`,
          { kind: "file-header", file: ref },
          "GleanFileHeader",
        );
        if (!c) {
          emitFileBody(
            file,
            ref,
            owner,
            keys.cseen(file.path),
            "  ".repeat(node.depth + 1),
          );
        }
      });
    });
  }
  const groups = input.summary ?? [];
  if (groups.length > 0) {
    section("comments", () => {
      const total = groups.reduce((n, g) => n + g.entries.length, 0);
      emit(
        `comments (${total})`,
        { kind: "summary-header" },
        "GleanModeHeader",
      );
      for (const g of groups) {
        emit("", { kind: "blank" });
        emit(
          `▾ ${g.path}`,
          { kind: "summary-file", path: g.path },
          "GleanFileHeader",
        );
        for (const e of g.entries) {
          const r = e.record;
          const loc =
            e.state === "outdated"
              ? "(outdated)"
              : e.hidden
                ? "(hidden)"
                : e.state === "file"
                  ? `file L${e.fileLnum}`
                  : e.displayLnum !== undefined
                    ? `L${e.displayLnum}`
                    : "L?";
          const target: RowTarget = {
            kind: "summary-comment",
            path: g.path,
            commentId: r.id,
          };
          const tag = `[${r.id}]`;
          let snippet = (r.content[0]?.text ?? "").replace(/^\s+/, "");
          if (r.content.length > 1) snippet += ` …+${r.content.length - 1}`;
          const prefix = `  ${tag} ${loc}  `;
          const room = Math.max(20, SUMMARY_WIDTH - prefix.length);
          if (chars(snippet) > room)
            snippet = `${[...snippet].slice(0, room - 1).join("")}…`;
          const row = emit(
            prefix + snippet,
            target,
            e.state === "outdated" || e.hidden ? "GleanSeen" : "GleanContext",
          );
          span(row, 2, 2 + tag.length, "GleanCommentId");
          for (const l of wrapText(r.text, "      💬 ", "         "))
            emit(l, target, "GleanComment");
          if (r.reply !== undefined)
            for (const l of wrapText(r.reply, "      ↳ ", "        "))
              emit(l, target, "GleanCommentReply");
        }
      }
    });
  }
  return f;

  function renderCommit(commit: ModelCommit, ci: number) {
    const cowner = cls.commitOwner(commit);
    const cc = isCollapsed(keys.commit(commit.sha), cls.commitSeen(commit));
    const all = commit.files.map((file) => ({ file, owner: cowner }));
    emit(
      `${cc ? CHEVRON_CLOSED : CHEVRON_OPEN} ${cls.commitSeen(commit) ? "✓" : "●"} ${commit.sha.slice(0, 8)} ${commit.summary}${cc ? summary(all) : ""}`,
      { kind: "commit-header", commit: ci },
      "GleanCommitHeader",
    );
    if (cc) return;
    let skip: number | undefined;
    for (const node of dirLayout(commit.files.map((x) => x.path))) {
      if (skip !== undefined && node.depth <= skip) skip = undefined;
      if (skip !== undefined) continue;
      const indent = "  ".repeat(node.depth);
      if (node.kind === "dir") {
        const files = node.files;
        const seen = cls.dirSeen({
          scope: "commits",
          commit,
          fileIndices: files,
        });
        const c = isCollapsed(keys.dir(commit.sha, node.prefix), seen);
        const tally = c
          ? summary(
              files.flatMap((i) =>
                commit.files[i]
                  ? [{ file: commit.files[i], owner: cowner }]
                  : [],
              ),
            )
          : "";
        emit(
          `${indent}${c ? CHEVRON_CLOSED : CHEVRON_OPEN} ${seen ? "✓" : " "} ${node.prefix}/${tally}`,
          {
            kind: "dir",
            scope: "commits",
            commit: ci,
            prefix: node.prefix,
            files,
          },
          "GleanFileHeader",
        );
        if (c) skip = node.depth;
        continue;
      }
      const file = commit.files[node.index];
      if (!file) continue;
      const ref: FileRef = { scope: "commits", commit: ci, file: node.index };
      const fseen = cls.fileSeen(file, cowner);
      const c = isCollapsed(keys.file(commit.sha, file.path), fseen);
      emit(
        `${indent}${c ? CHEVRON_CLOSED : CHEVRON_OPEN} ${fseen ? "✓" : " "} ${file.path} [${file.kind}]${c ? summary([{ file, owner: cowner }]) : ""}`,
        { kind: "file-header", file: ref },
        "GleanFileHeader",
      );
      if (!c) {
        emitFileBody(
          file,
          ref,
          cowner,
          keys.seen(commit.sha, file.path),
          `${indent}  `,
        );
      }
    }
  }
}
