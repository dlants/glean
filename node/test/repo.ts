/** Hermetic throwaway git repos for tests (port of testutil.make_repo). */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

export function makeRepo(spec: readonly CommitSpec[]): TestRepo {
  const root = mkdtempSync(join(tmpdir(), "glean-repo-"));
  const run = (args: readonly string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: { ...env, HOME: root },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/\s+$/, "");
  run(["init", "-q", "-b", "main"]);
  const shas: Sha[] = [];
  for (const c of spec) {
    if (c.branch) run(["checkout", "-q", "-b", c.branch]);
    if (c.merge) {
      run(["checkout", "-q", "main"]);
      run(["merge", "-q", "--no-ff", "-m", c.msg ?? "merge", c.merge]);
    } else {
      for (const [from, to] of Object.entries(c.rename ?? {})) {
        mkdirSync(dirname(join(root, to)), { recursive: true });
        run(["mv", "--", from, to]);
      }
      for (const p of c.delete ?? []) run(["rm", "-q", "--", p]);
      for (const [p, content] of Object.entries(c.files ?? {})) {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        writeFileSync(join(root, p), content);
        run(["add", "--", p]);
      }
      const args = ["commit", "-q", "-m", c.msg ?? "commit"];
      if (c.empty) args.push("--allow-empty");
      run(args);
    }
    shas.push(run(["rev-parse", "HEAD"]) as Sha);
  }
  return { root, run, shas };
}
