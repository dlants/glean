/**
 * The comment overlay in ordinary file buffers (port of `overlay.lua`), driven
 * by `gleanOverlay` notifies from `lua/glean/node_overlay.lua`. Records live in
 * the repo's store (shared with repo-mode api calls and any live review), which
 * is re-read per event. Comment changes ride the file buffer's glean undo
 * stack held by the gutter, so `u`/`<C-r>` spend marks and comments alike.
 * Events are handled one at a time, in order.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommentRecord, NewComment, Store } from "../core/state.ts";
import { type RepoPath, type Sha, toSha, WORKTREE } from "../core/types.ts";
import type { Git } from "../git/git.ts";
import type { FileUndo } from "../gutter/fileGutter.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { splitLines } from "../session/model.ts";
import { type PromptResult, Prompts, toPromptToken } from "../view/prompts.ts";
import { MAX_BATCH_CALLS } from "../view/view.ts";
import {
  firstLine,
  floatLines,
  jumpLnum,
  type QuickfixItem,
  quickfixItems,
  recordsAt,
  resolveOverlay,
  stamps,
} from "./project.ts";

export type OverlayEvent =
  | { kind: "refresh" | "toggle" | "wipe"; buf: number }
  | { kind: "show" | "edit" | "delete" | "reply"; buf: number; lnum: number }
  | { kind: "add"; buf: number; line1: number; line2: number }
  | { kind: "jump"; buf: number; lnum: number; dir: 1 | -1 }
  | { kind: "quickfix"; buf: number }
  | PromptResult;

export function parseOverlayEvent(v: unknown): OverlayEvent | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const num = (k: string) => (typeof o[k] === "number" ? o[k] : undefined);
  const buf = num("buf");
  switch (o.kind) {
    case "editor-submit": {
      const token = num("token");
      return token === undefined
        ? undefined
        : {
            kind: o.kind,
            token: toPromptToken(token),
            text: typeof o.text === "string" ? o.text : undefined,
          };
    }
    case "pick": {
      const token = num("token");
      const index = num("index");
      return token === undefined
        ? undefined
        : { kind: o.kind, token: toPromptToken(token), index };
    }
  }
  if (buf === undefined) return undefined;
  switch (o.kind) {
    case "refresh":
    case "toggle":
    case "wipe":
    case "quickfix":
      return { kind: o.kind, buf };
    case "show":
    case "edit":
    case "delete":
    case "reply": {
      const lnum = num("lnum");
      return lnum === undefined ? undefined : { kind: o.kind, buf, lnum };
    }
    case "add": {
      const line1 = num("line1");
      const line2 = num("line2") ?? line1;
      if (line1 === undefined || line2 === undefined) return undefined;
      return {
        kind: "add",
        buf,
        line1: Math.min(line1, line2),
        line2: Math.max(line1, line2),
      };
    }
    case "jump": {
      const lnum = num("lnum");
      const dir = o.dir === -1 ? -1 : o.dir === 1 ? 1 : undefined;
      return lnum === undefined || dir === undefined
        ? undefined
        : { kind: "jump", buf, lnum, dir };
    }
  }
  return undefined;
}

export type OverlayRepo = {
  root: string;
  git: Git;
  store: Store;
};
export type OverlayHost = {
  /** The repo containing `dir`, store freshly loaded; throws outside a repo. */
  repoContext(dir: string): Promise<OverlayRepo>;
  repoRelative(root: string, name: string): Promise<RepoPath | undefined>;
  /** Push onto the file buffer's glean undo stack. */
  pushUndo(buf: number, seq: number, a: FileUndo): Promise<void>;
  /** Another surface (a live review) must re-read the store. */
  afterWrite(root: string): void;
};

type BufFacts = {
  name: string;
  buftype: string;
  modified: boolean;
  seq: number;
};
type Target = { repo: OverlayRepo; path: RepoPath };
type CommentOp =
  | { op: "add"; record: NewComment }
  | { op: "remove"; record: CommentRecord }
  | { op: "edit"; before: CommentRecord; after: CommentRecord }
  | {
      op: "reply";
      record: CommentRecord;
      reply: string | undefined;
      before: string | undefined;
    };

/** Without a HEAD the selection can only be work-tree content, hence dirty. */
type FileOrigin =
  | { sha: Sha; dirty: boolean }
  | { sha: typeof WORKTREE; dirty: true };
const NOT_A_REPO = "glean: not inside a git repository";

export class Overlay {
  private ns = 0;
  private readonly inline = new Set<number>();
  /** Buffers whose `u`/`<C-r>` have been handed to the glean stack. */
  private readonly active = new Set<number>();
  private readonly prompts = new Prompts();
  private chain: Promise<void> = Promise.resolve();
  private allGen = 0;

  constructor(
    private readonly nvim: Nvim,
    private readonly host: OverlayHost,
  ) {}

  async init() {
    this.ns = await this.nvim.call("nvim_create_namespace", ["glean_overlay"]);
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn).catch((err: unknown) => {
      this.nvim.logger.error(err instanceof Error ? err : String(err));
    });
    return this.chain;
  }

  handle(ev: OverlayEvent): Promise<void> {
    return this.enqueue(() => this.run(ev));
  }

  /** Re-stamp every loaded file buffer (the store may have changed). */
  refreshAll(): Promise<void> {
    const gen = ++this.allGen;
    return this.enqueue(async () => {
      if (gen !== this.allGen) return;
      const bufs = (await this.nvim.call("nvim_exec_lua", [
        `local out = {}
for _, b in ipairs(vim.api.nvim_list_bufs()) do
  if vim.api.nvim_buf_is_loaded(b) and vim.bo[b].buftype == "" and vim.api.nvim_buf_get_name(b) ~= "" then
    out[#out + 1] = b
  end
end
return out`,
        [],
      ])) as number[];
      for (const b of bufs) {
        if (gen !== this.allGen) return;
        await this.refresh(b);
      }
    });
  }

  private async run(ev: OverlayEvent): Promise<void> {
    switch (ev.kind) {
      case "refresh":
        return this.refresh(ev.buf);
      case "toggle":
        if (this.inline.has(ev.buf)) this.inline.delete(ev.buf);
        else this.inline.add(ev.buf);
        return this.refresh(ev.buf);
      case "wipe":
        this.inline.delete(ev.buf);
        this.active.delete(ev.buf);
        return;
      case "show":
        return this.show(ev.buf, ev.lnum);
      case "jump": {
        const r = await this.resolve(ev.buf);
        const lnum = r && jumpLnum(r.groups, ev.lnum, ev.dir);
        if (lnum !== undefined) await this.park(ev.buf, lnum);
        return;
      }
      case "add":
        return this.add(ev.buf, ev.line1, ev.line2);
      case "delete":
      case "edit":
      case "reply":
        return this.withRecord(ev.buf, ev.lnum, ev.kind);
      case "quickfix":
        return this.quickfix(ev.buf);
      case "editor-submit":
      case "pick":
        this.prompts.submit(ev);
        return;
    }
  }

  private async facts(buf: number): Promise<BufFacts | undefined> {
    const r = (await this.nvim.call("nvim_exec_lua", [
      `local b = ...
if not vim.api.nvim_buf_is_loaded(b) then return vim.NIL end
return { vim.api.nvim_buf_get_name(b), vim.bo[b].buftype, vim.bo[b].modified,
  vim.api.nvim_buf_call(b, function() return vim.fn.undotree().seq_last end) }`,
      [buf],
    ])) as unknown;
    if (!Array.isArray(r)) return undefined;
    const [name, buftype, modified, seq] = r as unknown[];
    return typeof name === "string" &&
      typeof buftype === "string" &&
      typeof modified === "boolean" &&
      typeof seq === "number"
      ? { name, buftype, modified, seq }
      : undefined;
  }

  /** The repo and repo-relative path of a file buffer, if it is one. */
  private async target(f: BufFacts): Promise<Target | undefined> {
    if (f.buftype !== "" || f.name === "" || /^\w+:\/\//.test(f.name))
      return undefined;
    let repo: OverlayRepo;
    try {
      repo = await this.host.repoContext(dirname(f.name));
    } catch {
      return undefined;
    }
    const path = await this.host.repoRelative(repo.root, f.name);
    return path === undefined ? undefined : { repo, path };
  }

  private async lines(buf: number): Promise<string[]> {
    const l = await this.nvim.call("nvim_buf_get_lines", [buf, 0, -1, false]);
    return Array.isArray(l) ? (l as string[]) : [];
  }

  /** Resolve `buf`'s records against its lines, persisting any that moved. */
  private async resolve(buf: number) {
    const f = await this.facts(buf);
    const t = f && (await this.target(f));
    if (!f || !t) return undefined;
    const records = t.repo.store.commentsFor(t.path);
    if (records.length === 0) return { f, t, groups: [], lines: [] };
    const lines = await this.lines(buf);
    const { groups, moved } = resolveOverlay(records, lines);
    if (moved) {
      await t.repo.store.save(t.repo.store.wtShard);
      this.host.afterWrite(t.repo.root);
    }
    return { f, t, groups, lines };
  }

  /** Cheap no-op for a buffer with no comments: no marks, state or maps. */
  private async refresh(buf: number) {
    const r = await this.resolve(buf);
    if (!r) return;
    const calls: unknown[] = [
      ["nvim_buf_clear_namespace", [buf, this.ns, 0, -1]],
    ];
    if (r.groups.length > 0) {
      if (!this.active.has(buf)) {
        this.active.add(buf);
        calls.push([
          "nvim_exec_lua",
          [`require("glean.node_gutter").activate_undo(..., "overlay")`, [buf]],
        ]);
      }
      for (const s of stamps(r.groups, this.inline.has(buf), r.lines.length))
        calls.push(["nvim_buf_set_extmark", [buf, this.ns, s.row, 0, s.opts]]);
    }
    for (let i = 0; i < calls.length; i += MAX_BATCH_CALLS)
      await this.nvim.call("nvim_call_atomic", [
        calls.slice(i, i + MAX_BATCH_CALLS),
      ]);
  }

  private async show(buf: number, lnum: number) {
    const r = await this.resolve(buf);
    const records = r ? recordsAt(r.groups, lnum) : [];
    if (records.length === 0) return;
    const lines = floatLines(records);
    await this.nvim.call("nvim_exec_lua", [
      `return require("glean.node_overlay").float(...)`,
      [lines.map((l) => l.text), lines.map((l) => l.hl)],
    ]);
  }

  private notify(msg: string, level: number) {
    return this.nvim.call("nvim_notify", [msg, level, {}]);
  }

  private park(buf: number, lnum: number) {
    return this.nvim.call("nvim_exec_lua", [
      `local buf, row = ...
if vim.api.nvim_get_current_buf() ~= buf then return end
vim.api.nvim_win_set_cursor(0, { math.min(row, vim.api.nvim_buf_line_count(buf)), 0 })`,
      [buf, lnum],
    ]);
  }

  private async openEditor(
    initial: string[],
    fn: (text: string) => Promise<void>,
  ) {
    const { token, result } = this.prompts.editor();
    // The answer arrives as its own event; act on it in the chain after it.
    void result.then((t) =>
      t === undefined ? undefined : this.enqueue(() => fn(t)),
    );
    await this.nvim.call("nvim_exec_lua", [
      `return require("glean.node").comment_editor("overlay", 0, ...)`,
      [initial, token],
    ]);
  }

  /**
   * Provenance of a file-buffer selection: HEAD, flagged dirty when the work
   * tree (or the buffer) has diverged from it.
   */
  private async origin(git: Git, path: RepoPath, modified: boolean) {
    const [head, status] = await Promise.all([
      git.run(["rev-parse", "HEAD"]),
      git.run(["status", "--porcelain", "--", path]),
    ]);
    const sha = head.kind === "ok" ? toSha(head.value.trim()) : undefined;
    const origin: FileOrigin = sha
      ? {
          sha,
          dirty: modified || (status.kind === "ok" && /\S/.test(status.value)),
        }
      : { sha: WORKTREE, dirty: true };
    return origin;
  }

  /** A file view never sees a deletion: the run is captured as post-image lines. */
  private async add(buf: number, line1: number, line2: number) {
    const f = await this.facts(buf);
    const t = f && (await this.target(f));
    if (!f || !t) return void (await this.notify(NOT_A_REPO, 3));
    const got = await this.nvim.call("nvim_buf_get_lines", [
      buf,
      line1 - 1,
      line2,
      false,
    ]);
    if (!Array.isArray(got) || got.length === 0) return;
    const content = got
      .filter((text): text is string => typeof text === "string")
      .map((text) => ({
        kind: "add" as const,
        text,
      }));
    const origin = await this.origin(t.repo.git, t.path, f.modified);
    await this.openEditor([], async (text) => {
      const record: NewComment = {
        lnum: line1,
        content,
        text,
        reply: undefined,
        origin,
      };
      await this.perform(buf, t.path, { op: "add", record }, line1);
    });
  }

  /** Run a comment op now, and push it onto `buf`'s glean undo stack. */
  private async perform(
    buf: number,
    path: RepoPath,
    op: CommentOp,
    cursor: number,
  ) {
    const applied = await this.apply(buf, path, op, false);
    if (!applied) return;
    const f = await this.facts(buf);
    if (!f) return;
    await this.host.pushUndo(buf, f.seq, {
      kind: "comment",
      cursor,
      run: (reverse) =>
        this.enqueue(async () => {
          await this.apply(buf, path, applied, reverse);
        }),
    });
  }

  /**
   * Apply (or reverse) `op` against a fresh read of the store and re-stamp.
   * Returns the op with the store-assigned id of an added record, so undo and
   * redo name the same record.
   */
  private async apply(
    buf: number,
    path: RepoPath,
    op: CommentOp,
    reverse: boolean,
  ): Promise<CommentOp | undefined> {
    const f = await this.facts(buf);
    const t = f && (await this.target(f));
    if (!t) return undefined;
    const { store } = t.repo;
    let out = op;
    const put = (r: NewComment) => store.addCommentRecord(path, { ...r });
    const drop = (r: NewComment) => {
      // An add is only reversed after apply() stamped its store id.
      if (r.id !== undefined) store.removeCommentRecord(path, { id: r.id });
    };
    switch (op.op) {
      case "add":
        if (reverse) drop(op.record);
        else out = { op: "add", record: put(op.record) };
        break;
      case "remove":
        if (reverse) put(op.record);
        else drop(op.record);
        break;
      case "edit":
        drop(reverse ? op.after : op.before);
        put(reverse ? op.before : op.after);
        break;
      case "reply":
        store.setCommentReply(
          path,
          { id: op.record.id },
          reverse ? op.before : op.reply,
        );
        break;
    }
    await store.save(store.wtShard);
    this.host.afterWrite(t.repo.root);
    await this.refresh(buf);
    return out;
  }

  /** Run `kind` on the line's comment, asking which one when several resolve there. */
  private async withRecord(
    buf: number,
    lnum: number,
    kind: "delete" | "edit" | "reply",
  ) {
    const r = await this.resolve(buf);
    if (!r) return;
    const records = recordsAt(r.groups, lnum);
    if (records.length === 0)
      return void (await this.notify("glean: no comment on this line", 2));
    const act = (record: CommentRecord) =>
      this.act(buf, r.t.path, lnum, kind, record);
    const [only, ...rest] = records;
    if (only && rest.length === 0) return act(only);
    const { token, result } = this.prompts.pick();
    void result.then((i) => {
      const rec = i === undefined ? undefined : records[i];
      return rec && this.enqueue(() => act(rec));
    });
    await this.nvim.call("nvim_exec_lua", [
      `return require("glean.node").pick_comment("overlay", ...)`,
      [records.map((x) => firstLine(x.text)), token, `glean: ${kind} comment`],
    ]);
  }

  private async act(
    buf: number,
    path: RepoPath,
    lnum: number,
    kind: "delete" | "edit" | "reply",
    record: CommentRecord,
  ) {
    const snap = { ...record };
    if (kind === "delete")
      return this.perform(buf, path, { op: "remove", record: snap }, lnum);
    if (kind === "edit")
      return this.openEditor(snap.text.split("\n"), async (text) => {
        if (text === snap.text) return;
        await this.perform(
          buf,
          path,
          { op: "edit", before: snap, after: { ...snap, text } },
          lnum,
        );
      });
    // Replies live in the slot the agent writes to, so replying twice replaces.
    return this.openEditor((snap.reply ?? "").split("\n"), async (text) => {
      await this.perform(
        buf,
        path,
        { op: "reply", record: snap, reply: text, before: snap.reply },
        lnum,
      );
    });
  }

  /** `:Glean comments`: every comment in the repo as a quickfix list. */
  private async quickfix(buf: number) {
    const f = await this.facts(buf);
    const cwd = (await this.nvim.call("nvim_exec_lua", [
      `return vim.fn.getcwd()`,
      [],
    ])) as string;
    const dir =
      f && f.buftype === "" && f.name !== "" && !/^\w+:\/\//.test(f.name)
        ? dirname(f.name)
        : cwd;
    let repo: OverlayRepo;
    try {
      repo = await this.host.repoContext(dir);
    } catch {
      return void (await this.notify(NOT_A_REPO, 3));
    }
    const files = await Promise.all(
      repo.store.commentPaths().map(async (path) => ({
        path,
        records: repo.store.commentsFor(path),
        lines: await readFile(join(repo.root, path), "utf8").then(
          splitLines,
          () => undefined,
        ),
      })),
    );
    const items: QuickfixItem[] = [];
    for (const file of files) {
      items.push(...quickfixItems(repo.root, [file]));
      // Yield between files so a large comment set never blocks the loop.
      await new Promise((r) => setImmediate(r));
    }
    await this.nvim.call("nvim_exec_lua", [
      `vim.fn.setqflist({}, " ", { title = "glean comments", items = ... })
vim.cmd("copen")`,
      [items],
    ]);
  }
}
