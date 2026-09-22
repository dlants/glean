/**
 * Pure unified-diff parser: `git diff` text into FileEntries / Hunks / DiffLines.
 *
 * Every DiffLine carries a post-image slot (`newLnum`). A del's slot is the
 * post-image line it sat immediately before, so comment anchoring in the
 * post-image space is total.
 */
import type { RepoPath } from "./types.ts";

export type DiffLine =
  | { kind: "context"; text: string; oldLnum: number; newLnum: number }
  | { kind: "add"; text: string; newLnum: number }
  | { kind: "del"; text: string; oldLnum: number; newLnum: number };

export type Hunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  lines: DiffLine[];
};

export type FileKind = "add" | "delete" | "modify" | "rename";

export type FileEntry = {
  path: RepoPath;
  oldPath: RepoPath;
  kind: FileKind;
  hunks: Hunk[];
};

const HUNK_HEADER = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/;

function parseHunkHeader(line: string): Hunk | undefined {
  const m = HUNK_HEADER.exec(line);
  if (!m) return undefined;
  // git omits a count of 1.
  return {
    oldStart: Number(m[1]),
    oldCount: m[2] === "" ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === "" ? 1 : Number(m[4]),
    header: line,
    lines: [],
  };
}

function stripPrefix(p: string): RepoPath {
  return p.replace(/^[ab]\//, "") as RepoPath;
}

export function parse(text: string): FileEntry[] {
  const files: FileEntry[] = [];
  let file: FileEntry | undefined;
  let hunk: Hunk | undefined;
  let oldLnum = 0;
  let newLnum = 0;

  const finishHunk = () => {
    if (file && hunk) file.hunks.push(hunk);
    hunk = undefined;
  };

  for (const line of text.split("\n")) {
    const git = /^diff --git (\S+) (\S+)$/.exec(line);
    if (git) {
      finishHunk();
      file = {
        path: stripPrefix(git[2]!),
        oldPath: stripPrefix(git[1]!),
        kind: "modify",
        hunks: [],
      };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith("new file mode")) {
        file.kind = "add";
        continue;
      }
      if (line.startsWith("deleted file mode")) {
        file.kind = "delete";
        continue;
      }
      if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
        file.kind = "rename";
        continue;
      }
      // Path markers are only valid before the first `@@`: inside a hunk
      // `--- x` is a deleted `-- x` line and `+++ x` an added `++ x` line.
      if (line.startsWith("--- ")) continue;
      if (line.startsWith("+++ ")) {
        const p = line.slice(4);
        if (p !== "" && p !== "/dev/null") file.path = stripPrefix(p);
        continue;
      }
    }
    if (line.startsWith("@@")) {
      finishHunk();
      hunk = parseHunkHeader(line);
      if (hunk) {
        oldLnum = hunk.oldStart;
        newLnum = hunk.newStart;
      }
      continue;
    }
    if (!hunk) continue;
    const marker = line.charAt(0);
    const body = line.slice(1);
    if (marker === "+") {
      hunk.lines.push({ kind: "add", text: body, newLnum });
      newLnum++;
    } else if (marker === "-") {
      hunk.lines.push({ kind: "del", text: body, oldLnum, newLnum });
      oldLnum++;
    } else if (marker === " ") {
      hunk.lines.push({ kind: "context", text: body, oldLnum, newLnum });
      oldLnum++;
      newLnum++;
    }
    // `\ No newline at end of file` is decoration, not a line.
  }
  finishHunk();
  return files;
}

/**
 * Map a pre-image line number through `hunks` to the post-image. Undefined when
 * the line did not survive (deleted or replaced).
 */
export function mapLnum(
  hunks: readonly Hunk[],
  lnum: number,
): number | undefined {
  let shift = 0;
  for (const h of hunks) {
    if (lnum < h.oldStart) break;
    if (lnum < h.oldStart + h.oldCount) {
      for (const dl of h.lines) {
        if (dl.kind !== "add" && dl.oldLnum === lnum) {
          return dl.kind === "context" ? dl.newLnum : undefined;
        }
      }
      return undefined;
    }
    shift = h.newStart + h.newCount - (h.oldStart + h.oldCount);
  }
  return lnum + shift;
}
