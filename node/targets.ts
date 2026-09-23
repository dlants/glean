/**
 * Review targets: resolving the `:Glean` open forms (dirty, base/target,
 * branch, PR) to a base/target pair, the review-buffer title, and the pure
 * halves of the log and PR list views. Port of the `open_*`/`resolve_*`,
 * LogView and PrView code in `lua/glean/init.lua` at 0f31363.
 */
import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { Sha } from "./core/types.ts";
import {
  DEFAULT_TIMEOUT_MS,
  type Git,
  type LogCommit,
  type Outcome,
} from "./git/git.ts";
import type { Target } from "./session/model.ts";

export type GhResult =
  | { kind: "ok"; stdout: string }
  | { kind: "error"; stderr: string };
/** Runs `gh` (args exclude the program name); injectable for tests. */
export type GhRunner = (args: readonly string[]) => Promise<GhResult>;

export function spawnGhRunner(
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): GhRunner {
  return (args) =>
    new Promise((resolve) => {
      const child = spawn("gh", [...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      const settle = (r: GhResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        settle({ kind: "error", stderr: `gh timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      child.stdout.on("data", (b: Buffer) => out.push(b));
      child.stderr.on("data", (b: Buffer) => err.push(b));
      child.on("error", (e) => settle({ kind: "error", stderr: e.message }));
      child.on("close", (code) =>
        settle(
          code === 0
            ? { kind: "ok", stdout: Buffer.concat(out).toString("utf8") }
            : { kind: "error", stderr: Buffer.concat(err).toString("utf8") },
        ),
      );
    });
}

/** A user-facing failure; the command layer reports its message as an error. */
export class TargetError extends Error {}
const fail = (msg: string): never => {
  throw new TargetError(`glean: ${msg}`);
};

export function isPrArg(arg: string | undefined): boolean {
  if (arg === undefined) return false;
  return (
    /^\d+$/.test(arg) ||
    /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+([/#?].*)?$/.test(arg)
  );
}

export function githubPrRepo(url: string | undefined): string | undefined {
  const m = url?.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
}

export function githubRemoteRepo(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const m =
    url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)/) ??
    url.match(/^git@github\.com:([^/]+)\/([^/]+)/) ??
    url.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)/);
  if (!m) return undefined;
  const repo = (m[2] ?? "").replace(/\/+$/, "").replace(/\.git$/, "");
  return `${m[1]}/${repo}`.toLowerCase();
}

/** A review base: a revision, or the empty tree with history from the root. */
export type SpecBase = { kind: "rev"; rev: string } | { kind: "root" };
export const revBase = (rev: string): SpecBase => ({ kind: "rev", rev });
export type OpenSpec = {
  base: SpecBase;
  target: Target;
  /** Shown in the title; defaults to the range identifier. */
  identifier?: string;
  /** Branch owning the content-addressed shard; defaults to the checkout's. */
  storageBranch?: string;
};

const okOr = <T>(o: Outcome<T>): T | undefined =>
  o.kind === "ok" ? o.value : undefined;

/** "Current branch + dirty": fork point from the trunk on a feature branch,
 * the upstream on the trunk itself; the target is always the work tree. */
export async function resolveDirty(
  git: Git,
  defaultBase: string,
): Promise<{ base: string; branch: string | undefined }> {
  const [trunkO, branchO] = await Promise.all([
    git.defaultTrunk(),
    git.currentBranch(),
  ]);
  const trunk = okOr(trunkO) ?? defaultBase;
  const branch = okOr(branchO);
  const base =
    branch === trunk.replace(/^[^/]+\//, "")
      ? okOr(await git.upstream())
      : okOr(await git.mergeBase(trunk, "HEAD"));
  return { base: base ?? trunk, branch };
}

export async function openDirtySpec(
  git: Git,
  defaultBase: string,
  explicitBase: string | undefined,
): Promise<OpenSpec> {
  const { base, branch } = await resolveDirty(git, defaultBase);
  const reviewBase = explicitBase ?? base;
  const target: Target = { kind: "worktree" };
  return {
    base: revBase(reviewBase),
    target,
    identifier: explicitBase ?? branch ?? rangeIdentifier(reviewBase, target),
  };
}

export async function resolvePr(
  git: Git,
  pr: string | undefined,
  gh: GhRunner,
): Promise<{ base: Sha; target: Sha; branch: string; number: number }> {
  const prRepo = githubPrRepo(pr);
  if (prRepo) {
    const origin = githubRemoteRepo(okOr(await git.remoteUrl("origin")));
    if (prRepo !== origin)
      fail(
        `PR repository ${prRepo} does not match origin${origin ? ` ${origin}` : ""}`,
      );
  }
  const args = ["pr", "view"];
  if (pr !== undefined) args.push(pr);
  args.push("--json", "number,baseRefName,headRefName,headRefOid,baseRefOid");
  const res = await gh(args);
  if (res.kind !== "ok") return fail(`\`gh pr view\` failed: ${res.stderr}`);
  const info = parseJson(res.stdout, "gh pr view") as {
    number?: unknown;
    baseRefName?: unknown;
    headRefName?: unknown;
    headRefOid?: unknown;
    baseRefOid?: unknown;
  };
  if (
    typeof info.number !== "number" ||
    typeof info.baseRefName !== "string" ||
    typeof info.headRefName !== "string" ||
    typeof info.headRefOid !== "string" ||
    typeof info.baseRefOid !== "string"
  )
    return fail("invalid `gh pr view` response");
  const head = await git.fetch("origin", `pull/${info.number}/head`);
  if (head.kind !== "ok") fail(`fetching PR head failed: ${head.message}`);
  const base = await git.fetch("origin", info.baseRefName);
  if (base.kind !== "ok") fail(`fetching PR base failed: ${base.message}`);
  // Validates the gh-reported oids against the fetched objects.
  const [baseOid, headOid] = await Promise.all([
    git.revParse(`${info.baseRefOid}^{commit}`),
    git.revParse(`${info.headRefOid}^{commit}`),
  ]);
  if (baseOid.kind !== "ok" || headOid.kind !== "ok")
    return fail("`gh pr view` returned unknown commit oids");
  return {
    base: baseOid.value,
    target: headOid.value,
    branch: info.headRefName,
    number: info.number,
  };
}

export async function openPrSpec(
  git: Git,
  pr: string | undefined,
  gh: GhRunner,
): Promise<OpenSpec> {
  const r = await resolvePr(git, pr, gh);
  return {
    base: revBase(r.base),
    target: { kind: "ref", ref: r.target },
    storageBranch: r.branch,
    identifier: `PR #${r.number}`,
  };
}

/** A branch against its trunk fork point, preferring the remote copy. Fetches
 * are best-effort: a local-only branch or an offline remote still resolves. */
export async function resolveBranch(
  git: Git,
  branch: string,
  defaultBase: string,
): Promise<{ base: string; target: string }> {
  const trunk = okOr(await git.defaultTrunk()) ?? defaultBase;
  await git.fetch("origin", branch);
  await git.fetch("origin", trunk.replace(/^[^/]+\//, ""));
  const remote = `origin/${branch}`;
  const target = (await git.revParse(remote)).kind === "ok" ? remote : branch;
  const base = okOr(await git.mergeBase(trunk, target));
  return { base: base ?? trunk, target };
}

export async function openBranchSpec(
  git: Git,
  branch: string,
  defaultBase: string,
): Promise<OpenSpec> {
  const r = await resolveBranch(git, branch, defaultBase);
  return {
    base: revBase(r.base),
    target: { kind: "ref", ref: r.target },
    storageBranch: branch,
    identifier: branch,
  };
}

export function rangeIdentifier(base: string, target: Target): string {
  return `${base}..${target.kind === "worktree" ? "dirty" : target.ref}`;
}

/** Display-only: a full 40-hex oid shows as its first 8 chars. */
export function abbrevRef(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 8) : ref;
}

export function reviewTitle(
  repoRoot: string,
  id: string,
  spec: OpenSpec,
  base: string,
): string {
  const repo = basename(repoRoot);
  const range = rangeIdentifier(base, spec.target);
  const identifier = spec.identifier ?? range;
  const short = rangeIdentifier(
    abbrevRef(base),
    spec.target.kind === "worktree"
      ? spec.target
      : { kind: "ref", ref: abbrevRef(spec.target.ref) },
  );
  // Slashes would read as path separators in filename-tail displays.
  const display = (s: string) => s.replaceAll("/", "∕");
  if (identifier === range) return `Glean:${id} ${repo} ${display(short)}`;
  return `Glean:${id} ${repo} ${display(abbrevRef(identifier))} [${display(short)}]`;
}

/** `(repo, base, target)`: reopening the same key reuses the review. */
export function reviewKey(repoRoot: string, spec: OpenSpec): string {
  const t = spec.target.kind === "worktree" ? "WORKTREE" : spec.target.ref;
  const b = spec.base.kind === "rev" ? spec.base.rev : "ROOT";
  return [repoRoot, b, t].join("\0");
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fail(`invalid \`${what}\` response`);
  }
}

// ---- log view ----

export type ListHighlight = { row: number; endCol: number | "eol" };
export type ListFrame = {
  lines: string[];
  highlights: ListHighlight[];
  /** Row → selectable index (log: 0 = work tree, i = commits[i-1]). */
  rowMap: Map<number, number>;
};

export const LOG_PAGE_SIZE = 200;

export function renderLog(
  repoRoot: string,
  commits: readonly LogCommit[],
  hasMore: boolean,
): ListFrame {
  const lines = [
    `Glean log — ${basename(repoRoot)}`,
    "dirty     uncommitted changes",
  ];
  const rowMap = new Map<number, number>([[1, 0]]);
  const highlights: ListHighlight[] = [
    { row: 0, endCol: "eol" },
    { row: 1, endCol: 5 },
  ];
  commits.forEach((c, i) => {
    rowMap.set(lines.length, i + 1);
    highlights.push({ row: lines.length, endCol: c.shortSha.length });
    lines.push(`${c.shortSha}  ${c.summary}`);
  });
  if (hasMore) lines.push("…         press ]p to load more history");
  return { lines, highlights, rowMap };
}

export type LogSelection = { kind: "none" } | { kind: "open"; spec: OpenSpec };

/** The review a log selection opens: the work tree row makes the target the
 * work tree; the base is the oldest selected commit's first parent. */
export function logSelection(
  commits: readonly LogCommit[],
  rowMap: ReadonlyMap<number, number>,
  srow: number,
  erow: number,
): LogSelection {
  const [lo, hi] = srow <= erow ? [srow, erow] : [erow, srow];
  let first: number | undefined;
  let last: number | undefined;
  for (let row = lo; row <= hi; row++) {
    const idx = rowMap.get(row);
    if (idx === undefined) continue;
    first = Math.min(first ?? idx, idx);
    last = Math.max(last ?? idx, idx);
  }
  if (first === undefined || last === undefined) return { kind: "none" };
  const dirty = first === 0;
  const newest = dirty ? undefined : commits[first - 1];
  const oldest = last >= 1 ? commits[last - 1] : undefined;
  const newestId = newest ? newest.shortSha : "dirty";
  const identifier =
    oldest && oldest !== newest ? `${oldest.shortSha}..${newestId}` : newestId;
  const target: Target = newest
    ? { kind: "ref", ref: newest.sha }
    : { kind: "worktree" };
  const parent = oldest ? oldest.parents[0] : "HEAD";
  return {
    kind: "open",
    spec: {
      base: parent === undefined ? { kind: "root" } : revBase(parent),
      target,
      identifier,
    },
  };
}

// ---- PR list view ----

export type PrListEntry = {
  number: number;
  title: string;
  author: string | undefined;
  baseRefName: string;
  headRefName: string;
  isDraft: boolean;
};
export const PR_PAGE_SIZE = 50;
export const PR_LIST_ARGS = [
  "pr",
  "list",
  "--state",
  "open",
  "--limit",
  "1000",
  "--json",
  "number,title,author,headRefName,baseRefName,isDraft",
];

export function parsePrList(stdout: string): PrListEntry[] {
  const raw = parseJson(stdout, "gh pr list");
  if (!Array.isArray(raw)) return fail("invalid `gh pr list` response");
  return raw.flatMap((p: Record<string, unknown>) => {
    if (typeof p?.number !== "number") return [];
    const author = p.author as { login?: unknown } | undefined;
    return [
      {
        number: p.number,
        title: String(p.title ?? ""),
        author: typeof author?.login === "string" ? author.login : undefined,
        baseRefName: String(p.baseRefName ?? ""),
        headRefName: String(p.headRefName ?? ""),
        isDraft: p.isDraft === true,
      },
    ];
  });
}

export function prPageCount(n: number, pageSize: number): number {
  return Math.max(1, Math.ceil(n / pageSize));
}
export function clampPage(page: number, n: number, pageSize: number): number {
  return Math.max(1, Math.min(page, prPageCount(n, pageSize)));
}

/** `page` must already be clamped; rowMap values index into `prs`. */
export function renderPrs(
  repoRoot: string,
  prs: readonly PrListEntry[],
  page: number,
  pageSize: number,
): ListFrame {
  const lines = [
    `Glean prs — ${basename(repoRoot)} — page ${page}/${prPageCount(prs.length, pageSize)}`,
  ];
  const highlights: ListHighlight[] = [{ row: 0, endCol: "eol" }];
  const rowMap = new Map<number, number>();
  const first = (page - 1) * pageSize;
  const last = Math.min(prs.length, first + pageSize);
  for (let i = first; i < last; i++) {
    const pr = prs[i];
    if (!pr) continue;
    rowMap.set(lines.length, i);
    highlights.push({
      row: lines.length,
      endCol: String(pr.number).length + 1,
    });
    lines.push(
      `#${pr.number}  ${pr.author ?? "unknown"}  ${pr.baseRefName} ← ${pr.headRefName}  ${pr.title}${pr.isDraft ? " [draft]" : ""}`,
    );
  }
  if (prs.length === 0) lines.push("No open pull requests");
  return { lines, highlights, rowMap };
}
