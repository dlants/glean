/**
 * The comment overlay in ordinary file buffers (port of `overlay.lua`), driven
 * by `gleanOverlay` notifies from `lua/glean/overlay.lua`. Records live in
 * the repo's store (shared with repo-mode api calls and any live review), which
 * is re-read per event. Comment changes ride the file buffer's glean undo
 * stack held by the gutter, so `u`/`<C-r>` spend marks and comments alike.
 * Events are handled one at a time, in order.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommentRecord, NewComment, Store } from "../core/state.ts";
import {
  type BufNr,
  type RepoPath,
  type Sha,
  toSha,
  WORKTREE,
  type WorktreeLnum,
} from "../core/types.ts";
import type { Git } from "../git/git.ts";
import type { FileUndo } from "../gutter/fileGutter.ts";
import { splitLines } from "../session/model.ts";
import type { NotifyLevel } from "../view/review.ts";
import {
  type BodyLine,
  firstLine,
  floatLines,
  jumpLnum,
  type QuickfixItem,
  quickfixItems,
  recordsAt,
  resolveOverlay,
  type Stamp,
  stamps,
} from "./project.ts";

export type OverlayEvent =
  | { kind: "refresh" | "toggle" | "wipe"; buf: BufNr }
  | {
      kind: "show" | "edit" | "delete" | "reply";
      buf: BufNr;
      lnum: WorktreeLnum;
    }
  | { kind: "add"; buf: BufNr; line1: WorktreeLnum; line2: WorktreeLnum }
  | { kind: "jump"; buf: BufNr; lnum: number; dir: 1 | -1 }
  | { kind: "quickfix"; buf: BufNr };
export function parseOverlayEvent(v: unknown): OverlayEvent | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const num = (k: string) => (typeof o[k] === "number" ? o[k] : undefined);
  const buf = num("buf") as BufNr | undefined;
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
      const lnum = num("lnum") as WorktreeLnum | undefined;
      return lnum === undefined ? undefined : { kind: o.kind, buf, lnum };
    }
    case "add": {
      const line1 = num("line1");
      const line2 = num("line2") ?? line1;
      if (line1 === undefined || line2 === undefined) return undefined;
      return {
        kind: "add",
        buf,
        line1: Math.min(line1, line2) as WorktreeLnum,
        line2: Math.max(line1, line2) as WorktreeLnum,
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
  pushUndo(buf: BufNr, seq: number, a: FileUndo): Promise<void>;
  /** Another surface (a live review) must re-read the store. */
  afterWrite(root: string): void;
};

export type BufFacts = {
  name: string;
  buftype: string;
  modified: boolean;
  seq: number;
};
/** What the overlay needs from the editor, in glean's own terms. */
export type OverlayUi = {
  /** Loaded, named, ordinary file buffers. */
  fileBuffers(): Promise<BufNr[]>;
  facts(buf: BufNr): Promise<BufFacts | undefined>;
  allLines(buf: BufNr): Promise<string[]>;
  /** Lines `from..to`, inclusive. */
  range(
    buf: BufNr,
    r: { from: WorktreeLnum; to: WorktreeLnum },
  ): Promise<string[]>;
  cwd(): Promise<string>;
  /** Replace `buf`'s stamps. */
  stamp(buf: BufNr, stamps: Stamp[]): Promise<void>;
  /** Hand the buffer's `u`/`<C-r>` to the glean undo stack. */
  activateUndo(buf: BufNr): Promise<void>;
  /** Move the cursor to `lnum` if `buf` is current. */
  park(buf: BufNr, lnum: WorktreeLnum): Promise<void>;
  float(lines: BodyLine[]): Promise<void>;
  quickfix(items: QuickfixItem[]): Promise<void>;
  notify(msg: string, level: NotifyLevel): Promise<void>;
  /** Resolves with the submitted text, `undefined` when dismissed. */
  editor(initial: string[]): Promise<string | undefined>;
  pick(items: string[], title: string): Promise<number | undefined>;
  logError(err: unknown): void;
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
  private readonly inline = new Set<number>();
  /** Buffers whose `u`/`<C-r>` have been handed to the glean stack. */
  private readonly active = new Set<number>();
  private chain: Promise<void> = Promise.resolve();
  private allGen = 0;

  constructor(
    private readonly ui: OverlayUi,
    private readonly host: OverlayHost,
  ) {}

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn).catch((err: unknown) => {
      this.ui.logError(err);
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
      const bufs = await this.ui.fileBuffers();
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
        if (lnum !== undefined)
          await this.ui.park(ev.buf, lnum as WorktreeLnum);
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
    }
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

  /** Resolve `buf`'s records against its lines, persisting any that moved. */
  private async resolve(buf: BufNr) {
    const f = await this.ui.facts(buf);
    const t = f && (await this.target(f));
    if (!f || !t) return undefined;
    const records = t.repo.store.commentsFor(t.path);
    if (records.length === 0) return { f, t, groups: [], lines: [] };
    const lines = await this.ui.allLines(buf);
    const { groups, moved } = resolveOverlay(records, lines);
    if (moved) {
      await t.repo.store.save(t.repo.store.wtShard);
      this.host.afterWrite(t.repo.root);
    }
    return { f, t, groups, lines };
  }

  /** Cheap no-op for a buffer with no comments: no marks, state or maps. */
  private async refresh(buf: BufNr) {
    const r = await this.resolve(buf);
    if (!r) return;
    const marks =
      r.groups.length > 0
        ? stamps(r.groups, this.inline.has(buf), r.lines.length)
        : [];
    if (r.groups.length > 0 && !this.active.has(buf)) {
      this.active.add(buf);
      await this.ui.activateUndo(buf);
    }
    await this.ui.stamp(buf, marks);
  }

  private async show(buf: BufNr, lnum: number) {
    const r = await this.resolve(buf);
    const records = r ? recordsAt(r.groups, lnum) : [];
    if (records.length === 0) return;
    await this.ui.float(floatLines(records));
  }

  private async openEditor(
    initial: string[],
    fn: (text: string) => Promise<void>,
  ) {
    // The answer arrives as its own event; act on it in the chain after it.
    void this.ui
      .editor(initial)
      .then((t) => (t === undefined ? undefined : this.enqueue(() => fn(t))))
      .catch((err: unknown) => this.ui.logError(err));
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
  private async add(buf: BufNr, line1: WorktreeLnum, line2: WorktreeLnum) {
    const f = await this.ui.facts(buf);
    const t = f && (await this.target(f));
    if (!f || !t) return void (await this.ui.notify(NOT_A_REPO, "warn"));
    const got = await this.ui.range(buf, {
      from: line1,
      to: line2 as WorktreeLnum,
    });
    if (got.length === 0) return;
    const content = got.map((text) => ({
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
    buf: BufNr,
    path: RepoPath,
    op: CommentOp,
    cursor: WorktreeLnum,
  ) {
    const applied = await this.apply(buf, path, op, false);
    if (!applied) return;
    const f = await this.ui.facts(buf);
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
    buf: BufNr,
    path: RepoPath,
    op: CommentOp,
    reverse: boolean,
  ): Promise<CommentOp | undefined> {
    const f = await this.ui.facts(buf);
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
    buf: BufNr,
    lnum: WorktreeLnum,
    kind: "delete" | "edit" | "reply",
  ) {
    const r = await this.resolve(buf);
    if (!r) return;
    const records = recordsAt(r.groups, lnum);
    if (records.length === 0)
      return void (await this.ui.notify(
        "glean: no comment on this line",
        "info",
      ));
    const act = (record: CommentRecord) =>
      this.act(buf, r.t.path, lnum, kind, record);
    const [only, ...rest] = records;
    if (only && rest.length === 0) return act(only);
    void this.ui
      .pick(
        records.map((x) => firstLine(x.text)),
        `glean: ${kind} comment`,
      )
      .then((i) => {
        const rec = i === undefined ? undefined : records[i];
        return rec && this.enqueue(() => act(rec));
      })
      .catch((err: unknown) => this.ui.logError(err));
  }

  private async act(
    buf: BufNr,
    path: RepoPath,
    lnum: WorktreeLnum,
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
  private async quickfix(buf: BufNr) {
    const f = await this.ui.facts(buf);
    const cwd = await this.ui.cwd();
    const dir =
      f && f.buftype === "" && f.name !== "" && !/^\w+:\/\//.test(f.name)
        ? dirname(f.name)
        : cwd;
    let repo: OverlayRepo;
    try {
      repo = await this.host.repoContext(dir);
    } catch {
      return void (await this.ui.notify(NOT_A_REPO, "warn"));
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
    await this.ui.quickfix(items);
  }
}
