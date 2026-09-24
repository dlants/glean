/** Hermetic throwaway git repos for tests (port of testutil.make_repo). */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sha } from "../core/types.ts";

export type CommitSpec = {
  msg?: string;
  files?: Record<string, string>;
  delete?: string[];
  rename?: Record<string, string>;
  empty?: boolean;
  branch?: string;
  merge?: string;
};

export type TestRepo = {
  root: string;
  run: (args: readonly string[]) => string;
  shas: Sha[];
  env: NodeJS.ProcessEnv;
};

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Glean Test",
  GIT_AUTHOR_EMAIL: "glean@example.com",
  GIT_COMMITTER_NAME: "Glean Test",
  GIT_COMMITTER_EMAIL: "glean@example.com",
  GIT_AUTHOR_DATE: "2020-01-01T00:00:00 +0000",
  GIT_COMMITTER_DATE: "2020-01-01T00:00:00 +0000",
};

type Tree = Map<string, string>;

/** Builds the whole history with one `git fast-import` (each git spawn costs
 * tens of ms, so per-file add/commit made fixture setup dominate test time).
 * Merges are resolved per path against the merge base, which suffices for the
 * non-conflicting fixtures tests use. */
export function makeRepo(spec: readonly CommitSpec[]): TestRepo {
  const root = mkdtempSync(join(tmpdir(), "glean-repo-"));
  const repoEnv = { ...env, HOME: root };
  const run = (args: readonly string[], input?: string) =>
    execFileSync("git", args, {
      cwd: root,
      env: repoEnv,
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    }).replace(/\s+$/, "");
  run(["init", "-q", "-b", "main"]);

  const heads = new Map<string, number>();
  const trees: Tree[] = [];
  const parents: number[][] = [];
  let current = "main";
  const stream: string[] = [];
  const time = "1577836800 +0000";
  const blob = (s: string) => `data ${Buffer.byteLength(s)}\n${s}\n`;

  spec.forEach((c, i) => {
    let tree: Tree;
    let ps: number[];
    if (c.branch) {
      const from = heads.get(current);
      if (from !== undefined) heads.set(c.branch, from);
      current = c.branch;
    }
    if (c.merge) {
      current = "main";
      const ours = heads.get("main");
      const theirs = heads.get(c.merge);
      if (ours === undefined || theirs === undefined)
        throw new Error(`makeRepo: cannot merge ${c.merge}`);
      tree = mergeTrees(trees, parents, ours, theirs);
      ps = [ours, theirs];
    } else {
      const head = heads.get(current);
      tree = new Map(head === undefined ? [] : trees[head]);
      for (const [from, to] of Object.entries(c.rename ?? {})) {
        const content = tree.get(from);
        if (content === undefined) throw new Error(`makeRepo: no ${from}`);
        tree.delete(from);
        tree.set(to, content);
      }
      for (const p of c.delete ?? []) tree.delete(p);
      for (const [p, content] of Object.entries(c.files ?? {}))
        tree.set(p, content);
      ps = head === undefined ? [] : [head];
    }
    trees.push(tree);
    parents.push(ps);
    heads.set(current, i);
    stream.push(
      `commit refs/heads/${current}\nmark :${i + 1}\n`,
      `author Glean Test <glean@example.com> ${time}\n`,
      `committer Glean Test <glean@example.com> ${time}\n`,
      blob(c.msg ?? (c.merge ? "merge" : "commit")),
      ...ps.map((p, k) => `${k === 0 ? "from" : "merge"} :${p + 1}\n`),
      "deleteall\n",
      ...[...tree].map(([p, s]) => `M 100644 inline ${p}\n${blob(s)}`),
      "\n",
    );
  });

  const marks = join(root, ".git", "glean-marks");
  run(["fast-import", "--quiet", `--export-marks=${marks}`], stream.join(""));
  const shaOf = new Map(
    readFileSync(marks, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [m, sha] = l.split(" ");
        return [Number(m?.slice(1)), sha as Sha] as const;
      }),
  );
  const shas = spec.map((_, i) => shaOf.get(i + 1) as Sha);
  if (shas.length > 0) run(["checkout", "-q", "-f", current]);
  else run(["symbolic-ref", "HEAD", `refs/heads/${current}`]);
  return { root, run, shas, env: repoEnv };
}

function ancestors(parents: number[][], c: number): Set<number> {
  const seen = new Set<number>();
  const stack = [c];
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(parents[n] ?? []));
  }
  return seen;
}

function mergeTrees(
  trees: Tree[],
  parents: number[][],
  ours: number,
  theirs: number,
): Tree {
  const mine = ancestors(parents, ours);
  const base = [...ancestors(parents, theirs)]
    .filter((n) => mine.has(n))
    .reduce((a, b) => Math.max(a, b), -1);
  const b = trees[base] ?? new Map<string, string>();
  const o = trees[ours] ?? new Map<string, string>();
  const t = trees[theirs] ?? new Map<string, string>();
  const out: Tree = new Map();
  for (const p of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
    const [bv, ov, tv] = [b.get(p), o.get(p), t.get(p)];
    const v = ov === bv ? tv : tv === bv || tv === ov ? ov : undefined;
    if (v === undefined && ov !== bv && tv !== bv && ov !== tv)
      throw new Error(`makeRepo: merge conflict on ${p}`);
    if (v !== undefined) out.set(p, v);
  }
  return out;
}
