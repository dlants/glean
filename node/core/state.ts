/**
 * The persisted ReviewStore. Keyed by commit sha, sharded one JSON file per
 * commit (`<dir>/<sha>.json`), plus one always-loaded worktree shard holding
 * comments, sticky overrides and the per-path uncommitted records.
 *
 * The on-disk JSON shape is the one the Lua implementation wrote; shards are
 * validated into the types below at load time and serialized back to the same
 * shape.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RangeSet } from "./ranges.ts";
import * as ranges from "./ranges.ts";
import type {
  ContentHash,
  HeadLnum,
  LineId,
  PostLnum,
  PreLnum,
  RepoPath,
} from "./types.ts";

export const COMMENTS_ID = "WORKTREE";

export function lineHash(text: string): ContentHash {
  return createHash("sha256").update(text).digest("hex") as ContentHash;
}

/** The baseline anchor: hash of a whole file's lines. */
export function contentHash(lines: readonly string[]): ContentHash {
  return lineHash(lines.join("\n"));
}

/**
 * Start index (0-based) of the consecutive run of `needles` in `haystack`
 * closest to `anchor`, measured in `lnumOf` space (default: 1-based index).
 * Ties pick the lower index. All-or-nothing.
 */
export function resolve(
  needles: readonly string[],
  haystack: readonly string[],
  lnumOf: (i: number) => number | undefined = (i) => i + 1,
  anchor = 0,
): number | undefined {
  const n = needles.length;
  if (n === 0) return undefined;
  let best: number | undefined;
  let bestDist = Infinity;
  for (let i = 0; i + n <= haystack.length; i++) {
    let match = true;
    for (let j = 0; j < n; j++) {
      if (haystack[i + j] !== needles[j]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    const l = lnumOf(i);
    const dist = l === undefined ? Infinity : Math.abs(l - anchor);
    if (best === undefined || dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

// ── records ───────────────────────────────────────────────────────────────

export type CommentEntry =
  | { kind: "context" | "add"; text: string }
  | { kind: "del"; text: string; oldLnum: number };

export type CommentOrigin = { sha: string; dirty: boolean };

export type CommentRecord = {
  id: number;
  /** Post-image authoring line: a tiebreak/fallback hint, never a coordinate. */
  lnum: number;
  content: CommentEntry[];
  text: string;
  reply: string | undefined;
  origin: CommentOrigin | undefined;
};

/** How a caller names an existing record: by id, or by its authored fields. */
export type CommentKey =
  | { id: number }
  | { lnum: number; text: string; content: readonly CommentEntry[] };

/** The uncommitted seen record for one path. */
export type WorktreeRecord = {
  /** Anchor: hash of H's content. */
  head: ContentHash;
  /** The reviewed baseline R, when it differs from H. Invariant: diff(H, R) is add-only. */
  lines: readonly string[] | undefined;
  dels: RangeSet<HeadLnum>;
};

type CommitFile = { seen: RangeSet<PostLnum>; seenDel: RangeSet<PreLnum> };
type CommitShard = { files: Map<RepoPath, CommitFile> };
type WorktreeShard = {
  comments: Map<RepoPath, CommentRecord[]>;
  commentSeq: number;
  sticky: Map<RepoPath, Set<ContentHash>>;
  baselines: Map<RepoPath, WorktreeRecord>;
};

// ── validation (the load boundary) ────────────────────────────────────────

type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** Lua's encoder writes an empty table as `[]`, so an empty map may be an array. */
function entries(v: Json): [string, Json][] {
  return isObj(v) ? Object.entries(v) : [];
}
const isInt = (v: Json): v is number =>
  typeof v === "number" && Number.isInteger(v);

function parseRanges<L extends number>(v: Json): RangeSet<L> {
  if (!Array.isArray(v)) return [];
  const out: [L, L][] = [];
  for (const r of v) {
    if (Array.isArray(r) && isInt(r[0]) && isInt(r[1]))
      out.push([r[0] as L, r[1] as L]);
  }
  return ranges.merge(out);
}

function parseEntry(v: Json): CommentEntry | undefined {
  // Pre-annotation records stored bare strings.
  if (typeof v === "string") return { kind: "add", text: v };
  if (!isObj(v) || typeof v.text !== "string") return undefined;
  if (v.kind === "del") {
    return isInt(v.old_lnum)
      ? { kind: "del", text: v.text, oldLnum: v.old_lnum }
      : undefined;
  }
  return { kind: v.kind === "context" ? "context" : "add", text: v.text };
}

/** Records without an id get one assigned by `parseWorktreeShard`. */
function parseComment(
  v: Json,
): (Omit<CommentRecord, "id"> & { id: number | undefined }) | undefined {
  if (!isObj(v) || typeof v.text !== "string") return undefined;
  const content = (Array.isArray(v.content) ? v.content : [])
    .map(parseEntry)
    .filter((e): e is CommentEntry => e !== undefined);
  const lnum = isInt(v.lnum) ? v.lnum : isInt(v.anchor) ? v.anchor : 0;
  const o = v.origin;
  return {
    id: isInt(v.id) ? v.id : undefined,
    lnum,
    content,
    text: v.text,
    reply: typeof v.reply === "string" ? v.reply : undefined,
    origin:
      isObj(o) && typeof o.sha === "string"
        ? { sha: o.sha, dirty: o.dirty === true }
        : undefined,
  };
}

function parseCommitShard(v: Json): CommitShard {
  const files = new Map<RepoPath, CommitFile>();
  if (isObj(v)) {
    for (const [path, f] of entries(v.files)) {
      if (!isObj(f)) continue;
      const rec = {
        seen: parseRanges<PostLnum>(f.seen),
        seenDel: parseRanges<PreLnum>(f.seen_del),
      };
      if (rec.seen.length > 0 || rec.seenDel.length > 0)
        files.set(path as RepoPath, rec);
    }
  }
  return { files };
}

/**
 * Legacy content-hash `seen` sets, block `seen_marks` and per-file `files`
 * records are abandoned: they can't be folded into a baseline without the
 * H/W content the store never sees. Comment ids missing from pre-id shards are
 * backfilled in (path, authoring) order.
 */
function parseWorktreeShard(v: Json): WorktreeShard {
  const shard = emptyWorktree();
  if (!isObj(v)) return shard;
  const pending: [RepoPath, NonNullable<ReturnType<typeof parseComment>>[]][] =
    entries(v.comments)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, list]) => [
        path as RepoPath,
        (Array.isArray(list) ? list : [])
          .map(parseComment)
          .filter((c): c is NonNullable<typeof c> => c !== undefined),
      ]);
  let seq = isInt(v.comment_seq) ? v.comment_seq : 0;
  for (const [, list] of pending)
    for (const c of list) if (c.id !== undefined) seq = Math.max(seq, c.id);
  for (const [path, list] of pending) {
    shard.comments.set(
      path,
      list.map((c) => ({ ...c, id: c.id ?? ++seq })),
    );
  }
  shard.commentSeq = seq;
  for (const [path, set] of entries(v.sticky)) {
    const hashes = entries(set)
      .filter(([, on]) => on === true)
      .map(([h]) => h as ContentHash);
    if (hashes.length > 0) shard.sticky.set(path as RepoPath, new Set(hashes));
  }
  for (const [path, rec] of entries(v.baselines)) {
    if (!isObj(rec) || typeof rec.head !== "string") continue;
    const lines =
      Array.isArray(rec.lines) && rec.lines.every((l) => typeof l === "string")
        ? (rec.lines as string[])
        : undefined;
    shard.baselines.set(path as RepoPath, {
      head: rec.head as ContentHash,
      lines,
      dels: parseRanges<HeadLnum>(rec.dels),
    });
  }
  return shard;
}

function emptyWorktree(): WorktreeShard {
  return {
    comments: new Map(),
    commentSeq: 0,
    sticky: new Map(),
    baselines: new Map(),
  };
}

// ── serialization (the save boundary; same shape as the Lua writer) ───────

function serializeCommit(c: CommitShard): Json {
  const files: Record<string, Json> = {};
  for (const [path, f] of c.files) {
    const out: Record<string, Json> = {};
    if (f.seen.length > 0) out.seen = f.seen;
    if (f.seenDel.length > 0) out.seen_del = f.seenDel;
    files[path] = out;
  }
  return { files };
}

function serializeEntry(e: CommentEntry): Json {
  return e.kind === "del"
    ? { text: e.text, kind: e.kind, old_lnum: e.oldLnum }
    : { text: e.text, kind: e.kind };
}

function serializeWorktree(w: WorktreeShard): Json {
  const out: Record<string, Json> = { worktree: true };
  const comments: Record<string, Json> = {};
  for (const [path, list] of w.comments) {
    if (list.length === 0) continue;
    comments[path] = list.map((r) => ({
      id: r.id,
      lnum: r.lnum,
      content: r.content.map(serializeEntry),
      text: r.text,
      ...(r.reply !== undefined ? { reply: r.reply } : {}),
      ...(r.origin !== undefined ? { origin: r.origin } : {}),
    }));
  }
  if (Object.keys(comments).length > 0) out.comments = comments;
  if (w.commentSeq > 0) out.comment_seq = w.commentSeq;
  if (w.sticky.size > 0) {
    out.sticky = Object.fromEntries(
      [...w.sticky].map(([p, s]) => [
        p,
        Object.fromEntries([...s].map((h) => [h, true])),
      ]),
    );
  }
  if (w.baselines.size > 0) {
    out.baselines = Object.fromEntries(
      [...w.baselines].map(([p, r]) => [
        p,
        {
          head: r.head,
          ...(r.lines !== undefined ? { lines: r.lines } : {}),
          ...(r.dels.length > 0 ? { dels: r.dels } : {}),
        },
      ]),
    );
  }
  return out;
}

function commentMatches(r: CommentRecord, key: CommentKey): boolean {
  if ("id" in key) return r.id === key.id;
  return (
    r.lnum === key.lnum &&
    r.text === key.text &&
    r.content.length === key.content.length &&
    r.content.every((e, i) => {
      const o = key.content[i]!;
      return (
        e.text === o.text &&
        e.kind === o.kind &&
        (e.kind === "del" ? o.kind === "del" && e.oldLnum === o.oldLnum : true)
      );
    })
  );
}

export type NewComment = Omit<CommentRecord, "id"> & { id?: number };

// ── the store ─────────────────────────────────────────────────────────────

export class Store {
  private commits = new Map<string, CommitShard>();
  private wt: WorktreeShard = emptyWorktree();

  constructor(
    readonly dir: string,
    /** Worktree shard id; branch-anchored shards look like `WORKTREE/<branch>`. */
    readonly wtShard: string = COMMENTS_ID,
  ) {}

  /** Filesystem-safe, reversible: bytes outside [A-Za-z0-9._-] are %XX-encoded. */
  shardPath(id: string): string {
    let safe = "";
    for (const b of Buffer.from(id)) {
      const ch = String.fromCharCode(b);
      safe += /[A-Za-z0-9._-]/.test(ch)
        ? ch
        : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    return join(this.dir, `${safe}.json`);
  }

  private async readJson(id: string): Promise<Json | undefined> {
    try {
      return JSON.parse(await readFile(this.shardPath(id), "utf8"));
    } catch {
      return undefined;
    }
  }

  /**
   * Replace in-memory data with the given commit shards plus the worktree
   * shard (always loaded: comments are global per path and content).
   * Missing or corrupt shards read as empty.
   */
  async load(shas: readonly string[]): Promise<void> {
    this.commits = new Map();
    const wanted = shas.filter((s) => s !== this.wtShard);
    const [wt, ...commits] = await Promise.all([
      this.readJson(this.wtShard),
      ...wanted.map((s) => this.readJson(s)),
    ]);
    this.wt = parseWorktreeShard(wt);
    wanted.forEach((sha, i) => {
      if (commits[i] !== undefined)
        this.commits.set(sha, parseCommitShard(commits[i]));
    });
  }

  /** Persist one shard: a commit sha, or `wtShard`. */
  async save(id: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.shardPath(id), JSON.stringify(this.serialize(id)));
  }

  /** The JSON a `save(id)` would write. */
  serialize(id: string): Json {
    if (id === this.wtShard) return serializeWorktree(this.wt);
    return serializeCommit(this.commits.get(id) ?? { files: new Map() });
  }

  // ── committed seen ranges

  private file(sha: string, path: RepoPath): CommitFile {
    let c = this.commits.get(sha);
    if (!c) {
      c = { files: new Map() };
      this.commits.set(sha, c);
    }
    let f = c.files.get(path);
    if (!f) {
      f = { seen: [], seenDel: [] };
      c.files.set(path, f);
    }
    return f;
  }

  /** Drop an emptied file record so mark+unmark restores identical JSON. */
  private prune(sha: string, path: RepoPath): void {
    const c = this.commits.get(sha);
    const f = c?.files.get(path);
    if (c && f && f.seen.length === 0 && f.seenDel.length === 0)
      c.files.delete(path);
  }

  seenRanges(sha: string, path: RepoPath): RangeSet<PostLnum> {
    return this.commits.get(sha)?.files.get(path)?.seen ?? [];
  }

  seenDelRanges(sha: string, path: RepoPath): RangeSet<PreLnum> {
    return this.commits.get(sha)?.files.get(path)?.seenDel ?? [];
  }

  markSeen(sha: string, path: RepoPath, r: ranges.Range<PostLnum>): void {
    const f = this.file(sha, path);
    f.seen = ranges.add(f.seen, r);
  }

  unmarkSeen(sha: string, path: RepoPath, r: ranges.Range<PostLnum>): void {
    const f = this.file(sha, path);
    f.seen = ranges.remove(f.seen, r);
    this.prune(sha, path);
  }

  markSeenDel(sha: string, path: RepoPath, r: ranges.Range<PreLnum>): void {
    const f = this.file(sha, path);
    f.seenDel = ranges.add(f.seenDel, r);
  }

  unmarkSeenDel(sha: string, path: RepoPath, r: ranges.Range<PreLnum>): void {
    const f = this.file(sha, path);
    f.seenDel = ranges.remove(f.seenDel, r);
    this.prune(sha, path);
  }

  // ── unified identity API

  /**
   * Worktree identities are decided against the path's baseline, which needs
   * H and W contents the store has no view of, so they are never seen here.
   */
  isSeen(id: LineId): boolean {
    switch (id.kind) {
      case "committed-add":
        return ranges.covers(this.seenRanges(id.sha, id.path), id.lnum);
      case "committed-del":
        return ranges.covers(
          this.seenDelRanges(id.removerSha, id.path),
          id.lnum,
        );
      case "worktree-add":
      case "worktree-del":
        return false;
    }
  }

  allSeen(ids: readonly LineId[]): boolean {
    return ids.every((id) => this.isSeen(id));
  }

  /** Worktree identities are written by the session as baseline edits. */
  mark(ids: readonly LineId[]): void {
    for (const id of ids) {
      if (id.kind === "committed-add")
        this.markSeen(id.sha, id.path, [id.lnum, id.lnum]);
      else if (id.kind === "committed-del")
        this.markSeenDel(id.removerSha, id.path, [id.lnum, id.lnum]);
    }
  }

  unmark(ids: readonly LineId[]): void {
    for (const id of ids) {
      if (id.kind === "committed-add")
        this.unmarkSeen(id.sha, id.path, [id.lnum, id.lnum]);
      else if (id.kind === "committed-del")
        this.unmarkSeenDel(id.removerSha, id.path, [id.lnum, id.lnum]);
    }
  }

  // ── uncommitted records

  /** Any record for `path`, whatever its anchor. None means nothing approved. */
  hasBaseline(path: RepoPath): boolean {
    return this.wt.baselines.has(path);
  }

  /** The record for `path` if anchored at `head`; a stale record is kept, not returned. */
  baseline(path: RepoPath, head: ContentHash): WorktreeRecord | undefined {
    const rec = this.wt.baselines.get(path);
    return rec?.head === head ? rec : undefined;
  }

  /**
   * Store `path`'s record. Nothing reviewed on either side (R absent or equal
   * to H, no dels) prunes it, so a fully undone mark restores identical JSON.
   */
  setBaseline(
    path: RepoPath,
    head: ContentHash,
    lines: readonly string[] | undefined,
    dels: RangeSet<HeadLnum> = [],
  ): void {
    const merged = ranges.merge(dels);
    const r =
      lines !== undefined && contentHash(lines) !== head ? lines : undefined;
    if (r === undefined && merged.length === 0) this.wt.baselines.delete(path);
    else this.wt.baselines.set(path, { head, lines: r, dels: merged });
  }

  // ── sticky demotion overrides (content-addressed)

  addSticky(path: RepoPath, text: string): void {
    let set = this.wt.sticky.get(path);
    if (!set) {
      set = new Set();
      this.wt.sticky.set(path, set);
    }
    set.add(lineHash(text));
  }

  removeSticky(path: RepoPath, text: string): void {
    const set = this.wt.sticky.get(path);
    if (!set) return;
    set.delete(lineHash(text));
    if (set.size === 0) this.wt.sticky.delete(path);
  }

  isSticky(path: RepoPath, text: string): boolean {
    return this.wt.sticky.get(path)?.has(lineHash(text)) ?? false;
  }

  // ── comments

  /** Monotonic and persisted, so an id names a conversation across restarts. */
  nextCommentId(): number {
    return ++this.wt.commentSeq;
  }

  addCommentRecord(path: RepoPath, record: NewComment): CommentRecord {
    const stored: CommentRecord = {
      id: record.id ?? this.nextCommentId(),
      lnum: record.lnum,
      content: record.content,
      text: record.text,
      reply: record.reply,
      origin: record.origin,
    };
    const list = this.wt.comments.get(path) ?? [];
    list.push(stored);
    this.wt.comments.set(path, list);
    return stored;
  }

  /** Remove the last matching record; no-op when none match. */
  removeCommentRecord(path: RepoPath, key: CommentKey): void {
    const list = this.wt.comments.get(path);
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) {
      if (commentMatches(list[i]!, key)) {
        list.splice(i, 1);
        if (list.length === 0) this.wt.comments.delete(path);
        return;
      }
    }
  }

  /** Set or clear the reply on the last matching record. */
  setCommentReply(
    path: RepoPath,
    key: CommentKey,
    reply: string | undefined,
  ): CommentRecord | undefined {
    const list = this.wt.comments.get(path) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i]!;
      if (commentMatches(r, key)) {
        r.reply = reply;
        return r;
      }
    }
    return undefined;
  }

  commentPaths(): RepoPath[] {
    return [...this.wt.comments]
      .filter(([, l]) => l.length > 0)
      .map(([p]) => p)
      .sort();
  }

  commentsFor(path: RepoPath): readonly CommentRecord[] {
    return this.wt.comments.get(path) ?? [];
  }
}
