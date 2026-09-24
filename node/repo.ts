/** Repo mode: store access for the api and overlay, with or without a live review. */
import { ApiError } from "./api/api.ts";
import { type App, storeLocation } from "./app.ts";
import { readNvimConfig } from "./config.ts";
import { Store } from "./core/state.ts";
import { Git, spawnRunner } from "./git/git.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";

/** Resolved `rev-parse --show-toplevel` per probe path, so repeat repo-mode calls skip git. */
const repoRoots = new Map<string, string>();
/** The store of the repo containing `path` (default: nvim's cwd). The store is
 * re-read each call: live sessions write the same shards. */
export async function repoContext(nvim: Nvim, path: string | undefined) {
  const { root: cwd, dataDir, stateOverride } = await readNvimConfig(nvim);
  const probePath = path ?? cwd;
  let root = repoRoots.get(probePath);
  if (root === undefined) {
    const probe = new Git({ repoRoot: probePath, runner: spawnRunner() });
    const top = await probe.run(["rev-parse", "--show-toplevel"]);
    if (top.kind !== "ok")
      throw new ApiError(`glean: ${probePath} is not inside a git repository`);
    root = top.value.trim();
    repoRoots.set(probePath, root);
  }
  const git = new Git({ repoRoot: root, runner: spawnRunner() });
  const loc = await storeLocation(git, dataDir, stateOverride);
  const store = new Store(loc.stateDir, loc.wtShard);
  await store.load([]);
  return { root, git, store };
}
/** A store write from repo mode (api, overlay): live reviews of the repo re-read it. */
export function afterRepoWrite(app: App, root: string) {
  void Promise.all(
    app.reviews
      .filter((r) => r.session.repoRoot === root)
      .map((r) => r.session.refresh()),
  ).catch(() => undefined);
}
