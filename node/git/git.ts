/**
 * Async git plumbing. Every call goes through an injectable `GitRunner` with a
 * per-call timeout, so a hung or slow git never blocks anything but the
 * awaiting caller.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type FileEntry, parse } from "../core/diff.ts";
import type { RepoPath, Sha } from "../core/types.ts";

export type GitResult =
  | { kind: "ok"; stdout: string }
  | { kind: "error"; code: number; stderr: string }
  | { kind: "timeout" };

export type RunOpts = { cwd: string; timeoutMs: number; stdin?: string };

export interface GitRunner {
  run(args: readonly string[], opts: RunOpts): Promise<GitResult>;
}

export type Outcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "error"; message: string };

export const DEFAULT_TIMEOUT_MS = 10_000;

// Pin diff path-prefix config so paths are always `a/`/`b/` regardless of the
// user's git config, which the diff parser's prefix stripping assumes.
const PINNED_CONFIG = [
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.noprefix=false",
];

/** Spawns real git; kills the process when `timeoutMs` elapses. */
export function spawnRunner(env?: NodeJS.ProcessEnv): GitRunner {
  return {
    run(args, opts) {
      return new Promise((resolve) => {
        const child = spawn("git", [...PINNED_CONFIG, ...args], {
          cwd: opts.cwd,
          env: env ?? process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let settled = false;
        const settle = (r: GitResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(r);
        };
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          settle({ kind: "timeout" });
        }, opts.timeoutMs);
        child.stdout.on("data", (b: Buffer) => out.push(b));
        child.stderr.on("data", (b: Buffer) => err.push(b));
        child.on("error", (e) =>
          settle({ kind: "error", code: -1, stderr: e.message }),
        );
        child.on("close", (code) => {
          const stdout = Buffer.concat(out).toString("utf8");
          const stderr = Buffer.concat(err).toString("utf8");
          settle(
            code === 0
              ? { kind: "ok", stdout }
              : { kind: "error", code: code ?? -1, stderr },
          );
        });
        child.stdin.on("error", () => {});
        child.stdin.end(opts.stdin ?? "");
      });
    },
  };
}

export type LogCommit = {
  sha: Sha;
  shortSha: string;
  summary: string;
  parents: Sha[];
};

export type CommitPatch = { sha: Sha; summary: string; files: FileEntry[] };

export type DiffOpts = { ignoreWhitespace?: boolean; path?: RepoPath };

/** The poll signature plus the text it was computed from, reused by refresh. */
export type PollResult = { sig: string; head: string; diffText: string };

const LOG_PATCH_ARGS = [
  "log",
  "--first-parent",
  "--reverse",
  "-p",
  "-U0",
  "-M",
  "--no-color",
  "--format=%x00%H%x09%s",
];

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const trimEnd = (s: string) => s.replace(/\s+$/, "");

function diffArgs(
  head: readonly string[],
  refs: readonly string[],
  opts: DiffOpts,
) {
  const args = [...head];
  if (opts.ignoreWhitespace) args.push("--ignore-all-space");
  args.push(...refs);
  if (opts.path !== undefined) args.push("--", opts.path);
  return args;
}

function parseLogPatches(out: string): CommitPatch[] {
  const patches: CommitPatch[] = [];
  for (const chunk of out.split("\0").slice(1)) {
    const m = /^([0-9a-f]+)\t([^\n]*)\n?([\s\S]*)$/.exec(chunk);
    if (m) {
      patches.push({ sha: m[1] as Sha, summary: m[2]!, files: parse(m[3]!) });
    }
  }
  return patches;
}

function map<A, B>(o: Outcome<A>, f: (a: A) => B): Outcome<B> {
  return o.kind === "ok" ? { kind: "ok", value: f(o.value) } : o;
}

export class Git {
  readonly repoRoot: string;
  private readonly runner: GitRunner;
  private readonly timeoutMs: number;

  constructor(opts: {
    repoRoot: string;
    runner: GitRunner;
    timeoutMs?: number;
  }) {
    this.repoRoot = opts.repoRoot;
    this.runner = opts.runner;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async run(args: readonly string[], stdin?: string): Promise<Outcome<string>> {
    const opts: RunOpts = { cwd: this.repoRoot, timeoutMs: this.timeoutMs };
    if (stdin !== undefined) opts.stdin = stdin;
    const r = await this.runner.run(args, opts);
    switch (r.kind) {
      case "ok":
        return { kind: "ok", value: r.stdout };
      case "error":
        return { kind: "error", message: r.stderr };
      case "timeout":
        return {
          kind: "error",
          message: `git ${args[0] ?? ""} timed out after ${this.timeoutMs}ms`,
        };
    }
  }

  private async line(args: readonly string[]): Promise<string | undefined> {
    const r = await this.run(args);
    if (r.kind !== "ok") return undefined;
    const v = trimEnd(r.value);
    return v === "" ? undefined : v;
  }

  async revParse(ref: string): Promise<Outcome<Sha>> {
    return map(await this.run(["rev-parse", ref]), (s) => trimEnd(s) as Sha);
  }

  async mergeBase(a: string, b: string): Promise<Outcome<Sha>> {
    return map(await this.run(["merge-base", a, b]), (s) => trimEnd(s) as Sha);
  }

  remoteUrl(remote: string) {
    return this.line(["remote", "get-url", remote]);
  }

  currentBranch() {
    return this.line(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  upstream(ref = "HEAD") {
    return this.line([
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      `${ref}@{upstream}`,
    ]);
  }

  defaultTrunk() {
    return this.line(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  }

  /** Absolute shared git dir: identical across linked worktrees of a repo. */
  async commonDir(): Promise<string | undefined> {
    const out = await this.line(["rev-parse", "--git-common-dir"]);
    if (out === undefined) return undefined;
    const abs = isAbsolute(out) ? out : join(this.repoRoot, out);
    return (await realpath(abs)).replace(/\/$/, "");
  }

  /** First-parent history from HEAD, newest first, paged by limit/skip. */
  async logCommits(
    opts: { limit?: number; skip?: number } = {},
  ): Promise<Outcome<LogCommit[]>> {
    const args = [
      "log",
      "--first-parent",
      "--no-color",
      "--abbrev=8",
      "--format=%x00%H%x09%h%x09%P%x09%s",
    ];
    if (opts.skip) args.push(`--skip=${opts.skip}`);
    if (opts.limit !== undefined) args.push(`-n${opts.limit}`);
    return map(await this.run(args), (out) => {
      const commits: LogCommit[] = [];
      for (const raw of out.split("\0").slice(1)) {
        const m = /^([0-9a-f]+)\t([0-9a-f]+)\t([^\t]*)\t(.*)$/.exec(
          raw.replace(/\n$/, ""),
        );
        if (!m) continue;
        commits.push({
          sha: m[1] as Sha,
          shortSha: m[2]!,
          parents: (m[3]!.match(/[0-9a-f]+/g) ?? []) as Sha[],
          summary: m[4]!,
        });
      }
      return commits;
    });
  }

  /** First-parent commits of `base..target`, oldest first, each with its patch. */
  async logPatches(
    base: string,
    target: string,
    opts: { ignoreWhitespace?: boolean } = {},
  ): Promise<Outcome<CommitPatch[]>> {
    const args = diffArgs(LOG_PATCH_ARGS, [`${base}..${target}`], opts);
    return map(await this.run(args), parseLogPatches);
  }

  /** First-parent patches from the root commit through `target`. */
  async logPatchesFromRoot(
    target: string,
    opts: { ignoreWhitespace?: boolean } = {},
  ): Promise<Outcome<CommitPatch[]>> {
    const args = diffArgs(LOG_PATCH_ARGS, ["--root", target], opts);
    return map(await this.run(args), parseLogPatches);
  }

  /** The object-format-specific empty tree id. */
  async emptyTree(): Promise<Outcome<Sha>> {
    const r = await this.run(["hash-object", "-t", "tree", "--stdin"], "");
    return map(r, (s) => trimEnd(s) as Sha);
  }

  private async diff(refs: readonly string[], opts: DiffOpts) {
    const r = await this.run(diffArgs(["diff", "--no-color"], refs, opts));
    return map(r, parse);
  }

  /** `git diff HEAD`: staged + unstaged tracked changes. */
  worktreeDiff(opts: DiffOpts = {}) {
    return this.diff(["HEAD"], opts);
  }

  /** `git diff <base>`: everything since base, committed and uncommitted. */
  diffToWorktree(base: string, opts: DiffOpts = {}) {
    return this.diff([base], opts);
  }

  /** `git diff <base> <target>`. */
  diffRefs(base: string, target: string, opts: DiffOpts = {}) {
    return this.diff([base, target], opts);
  }

  /** Three-dot net diff: what target added since it diverged from base. */
  combinedDiff(base: string, target: string, opts: DiffOpts = {}) {
    return this.diff([`${base}...${target}`], opts);
  }

  /** Two-dot `from..to` diff. */
  rangeDiff(from: string, to: string, opts: DiffOpts = {}) {
    return this.diff([`${from}..${to}`], opts);
  }

  private untrackedArgs(path?: RepoPath) {
    const args = ["ls-files", "--others", "--exclude-standard", "-z"];
    if (path !== undefined) args.push("--", path);
    return args;
  }

  /**
   * Untracked, non-ignored files as all-addition FileEntries. Binary or
   * unreadable files are skipped. Read-only: never `git add -N`.
   */
  async untracked(path?: RepoPath): Promise<Outcome<FileEntry[]>> {
    const r = await this.run(this.untrackedArgs(path));
    if (r.kind !== "ok") return r;
    const files: FileEntry[] = [];
    for (const p of r.value.split("\0")) {
      if (p === "") continue;
      let content: string;
      try {
        content = await readFile(join(this.repoRoot, p), "utf8");
      } catch {
        continue;
      }
      if (content.includes("\0")) continue;
      const lines =
        content === "" ? [] : content.replace(/\n$/, "").split("\n");
      const n = lines.length;
      files.push({
        path: p as RepoPath,
        oldPath: p as RepoPath,
        kind: "add",
        hunks:
          n > 0
            ? [
                {
                  oldStart: 0,
                  oldCount: 0,
                  newStart: 1,
                  newCount: n,
                  header: `@@ -0,0 +1,${n} @@`,
                  lines: lines.map((text, i) => ({
                    kind: "add" as const,
                    text,
                    newLnum: i + 1,
                  })),
                },
              ]
            : [],
      });
    }
    return { kind: "ok", value: files };
  }

  /** HEAD plus the tracked diff against HEAD; the refresh reuses the text. */
  async poll(): Promise<PollResult> {
    const [head, diff] = await Promise.all([
      this.run(["rev-parse", "HEAD"]),
      this.run(["diff", "--no-color", "HEAD"]),
    ]);
    const h = head.kind === "ok" ? trimEnd(head.value) : "";
    const d = diff.kind === "ok" ? diff.value : "";
    return { sig: sha256(`${h}\0${d}`), head: h, diffText: d };
  }

  /** Signature over the untracked listing (a whole-tree walk: slow tick only). */
  async untrackedSig(): Promise<string> {
    const r = await this.run(this.untrackedArgs());
    return sha256(r.kind === "ok" ? r.value : "");
  }

  async fetch(remote: string, refspec: string): Promise<Outcome<true>> {
    return map(await this.run(["fetch", remote, refspec]), () => true as const);
  }

  show(ref: string, path: RepoPath) {
    return this.run(["show", `${ref}:${path}`]);
  }

  /**
   * Contents of many paths at one ref from a single `cat-file --batch`.
   * Paths absent from the ref are missing from the map.
   */
  async showMany(
    ref: string,
    paths: readonly RepoPath[],
  ): Promise<Map<RepoPath, string>> {
    const out = new Map<RepoPath, string>();
    if (paths.length === 0) return out;
    const stdin = `${paths.map((p) => `${ref}:${p}`).join("\n")}\n`;
    const r = await this.runner.run(["cat-file", "--batch"], {
      cwd: this.repoRoot,
      timeoutMs: this.timeoutMs,
      stdin,
    });
    if (r.kind !== "ok") return out;
    // Walk by byte counts from each `<oid> <type> <size>` header: blobs contain
    // newlines, and `size` is in bytes.
    const body = Buffer.from(r.stdout, "utf8");
    let pos = 0;
    for (const path of paths) {
      const nl = body.indexOf(0x0a, pos);
      if (nl < 0) break;
      const header = body.subarray(pos, nl).toString("utf8");
      pos = nl + 1;
      const m = /^[0-9a-f]+ [a-z]+ (\d+)$/.exec(header);
      if (m) {
        const size = Number(m[1]);
        out.set(path, body.subarray(pos, pos + size).toString("utf8"));
        pos += size + 1;
      }
    }
    return out;
  }
}

/**
 * Runs `tick` on an interval, never overlapping itself: a tick that is still
 * in flight when the next is due makes that next one a no-op.
 */
export class Poller {
  private inFlight = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly tick: () => Promise<void>) {}

  /** Run one tick unless one is already running. Resolves false if skipped. */
  async poke(): Promise<boolean> {
    if (this.inFlight) return false;
    this.inFlight = true;
    try {
      await this.tick();
    } finally {
      this.inFlight = false;
    }
    return true;
  }

  start(intervalMs: number) {
    this.stop();
    this.timer = setInterval(() => {
      this.poke().catch(() => {});
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
