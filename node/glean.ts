/** Wiring: build the cores behind their nvim adapters and register every RPC handler. */
import { Api } from "./api/api.ts";
import { App, parseListEvent, repoRelative } from "./app.ts";
import { handleCommand, parseCommand } from "./command.ts";
import { spawnRunner } from "./git/git.ts";
import { FileGutter, parseGutterEvent } from "./gutter/fileGutter.ts";
import { NvimGutterUi } from "./gutter/nvimGutterUi.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import { nvimAppUi } from "./nvimAppUi.ts";
import { NvimOverlayUi } from "./overlay/nvimOverlayUi.ts";
import { Overlay, parseOverlayEvent } from "./overlay/overlay.ts";
import { afterRepoWrite, repoContext } from "./repo.ts";
import {
  GLEAN_API,
  GLEAN_COMMAND,
  GLEAN_GUTTER,
  GLEAN_LIST,
  GLEAN_OVERLAY,
  GLEAN_PROMPT,
  GLEAN_REVIEW,
  GLEAN_REVIEW_QUERY,
} from "./rpc.ts";
import { spawnGhRunner, TargetError } from "./targets.ts";
import { Prompts, parsePromptResult } from "./view/prompts.ts";
import { parseAction, parseQuery } from "./view/view.ts";

async function notifyError(nvim: Nvim, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  await nvim.call("nvim_notify", [msg, 4, {}]);
}

/** User-facing failures become error notifications; anything else is logged. */
async function reported(nvim: Nvim, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof TargetError) await notifyError(nvim, err);
    else nvim.logger.error(err instanceof Error ? err : String(err));
  }
}

export async function startGlean(nvim: Nvim): Promise<void> {
  // One prompt table for review buffers and the overlay: results carry only a token.
  const prompts = new Prompts();
  // The model hook refers forward to the gutter/overlay built below.
  let gutter: FileGutter | undefined;
  let overlay: Overlay | undefined;
  const app = new App(nvimAppUi(nvim, prompts), {
    runner: spawnRunner(),
    gh: (root) => spawnGhRunner(root),
    onModel: ({ gutter: g, overlay: o }) => {
      if (g) void gutter?.refreshAll();
      if (o) void overlay?.refreshAll();
    },
  });
  const gutterUi = new NvimGutterUi(nvim);
  await gutterUi.init();
  const g = new FileGutter(gutterUi, () => app.liveSession);
  gutter = g;
  const overlayUi = new NvimOverlayUi(nvim, prompts);
  await overlayUi.init();
  const o = new Overlay(overlayUi, {
    repoContext: (dir) => repoContext(nvim, dir),
    repoRelative,
    pushUndo: (buf, seq, a) => g.push(buf, seq, a),
    afterWrite: (root) => afterRepoWrite(app, root),
  });
  overlay = o;
  const api = new Api({
    reviews: () => app.reviews,
    repoContext: (path) => repoContext(nvim, path),
    afterRepoWrite: (root) => {
      afterRepoWrite(app, root);
      void o.refreshAll();
    },
  });

  // Handlers go in before the bridge so no notification can arrive unhandled.
  nvim.onNotification(GLEAN_COMMAND, async (args: unknown[]) => {
    await reported(nvim, () =>
      handleCommand({ nvim, app, gutter: g }, parseCommand(args[0])),
    );
  });
  nvim.onNotification(GLEAN_LIST, async (args: unknown[]) => {
    const ev = parseListEvent(args[0]);
    if (ev) await reported(nvim, () => app.list(ev));
  });
  nvim.onNotification(GLEAN_PROMPT, async (args: unknown[]) => {
    const r = parsePromptResult(args[0]);
    if (r) prompts.submit(r);
  });
  nvim.onNotification(GLEAN_GUTTER, async (args: unknown[]) => {
    const ev = parseGutterEvent(args[0]);
    if (ev) await g.handle(ev);
  });
  nvim.onNotification(GLEAN_OVERLAY, async (args: unknown[]) => {
    const ev = parseOverlayEvent(args[0]);
    if (ev) await o.handle(ev);
  });
  nvim.onNotification(GLEAN_REVIEW, async (args: unknown[]) => {
    try {
      const bufnr = args[0];
      const action = parseAction(args[1]);
      if (typeof bufnr !== "number" || !action) return;
      await app.action(bufnr, action);
    } catch (err) {
      nvim.logger.error(err instanceof Error ? err : String(err));
    }
  });
  nvim.onRequest(GLEAN_REVIEW_QUERY, async (args: unknown[]) => {
    const q = parseQuery(args[1]);
    const view = typeof args[0] === "number" ? app.view(args[0]) : undefined;
    return (q && view?.query(q)) ?? null;
  });
  // Errors travel back as the rpcrequest error, so the Lua caller sees them raised.
  nvim.onRequest(GLEAN_API, async (args: unknown[]) => {
    const out = await api.call(args[0], args[1]);
    return out === undefined ? null : out;
  });
  await nvim.call("nvim_exec_lua", [
    `require("glean.rpc-bridge").bridge(...)`,
    [nvim.channelId],
  ]);
}
