# Objective and Context

> We have a bunch of off-by-one errors in our rendering code. Seems like mostly around highlights: the way that the lines are being highlighted and stylized isn't exactly accurate everywhere. I want to do an audit of everywhere where we're talking about line numbers and I want to introduce nominal types for zero-indexed and one-indexed line indices and column indices. Then type all line coordinates accordingly, and use the type system to verify.

Existing coordinate types (two parallel, unrelated sets):
- `node/core/types.ts`: `BufRow` (0-based glean buffer row, used only in `render/sticky.ts`), and the 1-based line-identity lnums `HeadLnum`, `WorktreeLnum`, `PostLnum`, `PreLnum`, all `Brand<number, "...">` sharing the `__brand` key (so they cannot be intersected with a second brand).
- `node/nvim/window.ts` (copied from magenta, largely unused by glean code): `Row0Indexed`, `Row1Indexed`, `ByteIdx`, `ByteIdx1Indexed`, `StringIdx`, `Position0Indexed`/`Position1Indexed`, `pos0to1`/`pos1to0`.
- `node/nvim/nvim-node/neovim-api.types.ts`: the typed `nvim.call` signatures. Every row/col parameter is plain `number`; `nvim_call_atomic` and `nvim_exec_lua` take `unknown[]`. Almost all glean nvim traffic goes through raw `nvim.call` / `nvim_call_atomic` / Lua snippets, not through `NvimBuffer`/`NvimWindow`, so today nothing checks coordinates at the nvim boundary.

Audit findings (unbranded coordinate sites, by layer):
- core: `DiffLine.oldLnum/newLnum`, `Hunk.oldStart/newStart` (`core/diff.ts`), `LineOp.aLnum/bLnum` (`core/linediff.ts`, built as `ai + 1`), `mapForward/mapBack` (`core/baseline.ts`), `Origin.base`, `splice(at)` (`core/lineage.ts`), `Range<L>` (`core/ranges.ts`, 1-based inclusive), `resolve/locate` `lnumOf: (i: number) => number` (`core/state.ts`, `core/comments.ts`), `CommentRecord.lnum`, `CommentEntry.oldLnum`, `Token.col/len`, `Segment.startCol/endCol` (`core/intraline.ts`, utf-8 bytes).
- render: `Highlight.row/startCol/endCol`, `IntraBlock.{dels,adds}[].row`, `Section.lo/hi`, `emit()`/`span()` (`render/render.ts`); `srow/erow/row` params across `actions.ts`, `commentActions.ts`, `nav.ts`, `anchor.ts` (`restoreAnchor` return), `sticky.ts` (`w0`); `MarkerRun.lo/hi` (`markers.ts`).
- view: `CursorInfo.row/top` (0-based, Lua does `- 1`), `setCursor(row)` → `row + 1`, highlight/intra/indent/active-hunk/sticky extmarks in `view/view.ts`; `Action` `row/srow/erow/col` in `view/review.ts`; `liveLnum/diskLine` and `col` passthrough in `view/jump.ts`.
- other nvim adapters: `nvimAppUi.ts` (list cursor `row + 1`, list highlights `[row, endCol]` tuples into Lua), `gutter/nvimGutterUi.ts` (`lnum - 1`), `overlay/project.ts` stamps (`lnum - 1`), `overlay/nvimOverlayUi.ts` (`get_lines(r.from - 1, r.to)`), `api/api.ts` excerpt (`frame.rows[row - 1]`, 1-based `row` loop var), `targets.ts` list `rowMap`.
- lua: `review-buffer.lua` sends 0-based rows (`util.row0`) and 0-based byte `col`; `gutter.lua` and `overlay.lua` send 1-based rows under the name `row`; `overlay.lua` float highlight `(i - 1, end_row = i)`; `review-buffer.lua` `set_cursor_clamped` clamps col to `#text - 1`.

Byte-vs-utf16 spots that are correct only because the text is ASCII today: `tokenize` word tokens use `text.length` (WORD is `[A-Za-z0-9_]`), comment tags `[id]` use `tag.length`, add/del counts use `a.length`. These must become explicit byte computations so the type system covers them.

No concrete off-by-one was confirmed by reading alone; the stages below make every conversion explicit so the remaining bugs surface as type errors or in the new highlight driver tests.

Files:
- `node/core/types.ts` — single home for all coordinate brands and conversions.
- `node/nvim/window.ts`, `node/nvim/buffer.ts` — magenta-derived wrappers; switch to the core brands.
- `node/nvim/nvim-node/neovim-api.types.ts` — typed nvim API; tighten row/col params.
- `node/nvim/atomic.ts` (new, small) — typed builder for `nvim_call_atomic` entries.
- `node/core/{diff,linediff,baseline,lineage,ranges,state,comments,intraline}.ts` — 1-based lnums and byte cols.
- `node/render/*.ts` — frame rows and highlight cols.
- `node/view/{view,review,jump}.ts`, `node/nvimAppUi.ts`, `node/gutter/*`, `node/overlay/*`, `node/api/api.ts`, `node/targets.ts` — nvim boundary and RPC parsing.
- `lua/glean/{review-buffer,gutter,overlay}.lua` — field naming on the wire.

# Design

One set of coordinate brands in `core/types.ts`, using a distinct brand key per axis so a space-specific lnum can also carry its index base:

- The index base is its own nominal key, so `PostLnum` is a `Lnum` (1-based) and assignable wherever any 1-based line is expected, but never to `Row`.
- Conversions are the only place `+ 1`/`- 1` between bases appear. A grep for `\+ 1|- 1` next to row/lnum names after the refactor should hit only these helpers, lineage/range arithmetic within one base, and array offset arithmetic that the types make explicit.
- Columns: nvim extmarks and cursors use 0-based utf-8 byte columns; JS strings index in utf-16. `ByteCol` is produced only by `byteLen(s)`/`byteCol(prefix)` or arithmetic on other `ByteCol`s via `addBytes`.
- The nvim boundary is typed at `neovim-api.types.ts`, so raw `nvim.call` sites are checked without rewriting them through `NvimBuffer`. `nvim_call_atomic` gets a typed builder (`atomic(["nvim_buf_set_extmark", [...]])`) that reuses the same param table. Extmark opts get a typed `end_row: Row`, `end_col: ByteCol`.
- Lua snippets executed via `nvim_exec_lua` cannot be type checked; each such snippet that takes a coordinate gets its argument passed with a name suffix stating the base (`row0`, `lnum1`) and the conversion happens on the node side so the Lua does none. Same convention for RPC payloads from `lua/glean/*.lua`: fields are named `row` (0-based) or `lnum` (1-based), never ambiguous; parsers in node brand them at the one boundary.

## Interfaces

```ts
// node/core/types.ts
declare const rowBase: unique symbol;
declare const colBase: unique symbol;
/** 0-based line index: buffer rows, nvim_buf_* line args, extmark rows, array indices into a file's lines. */
export type Row = number & { readonly [rowBase]: 0 };
/** 1-based line number: cursor rows, git hunk/line numbers, user-facing lnums. */
export type Lnum = number & { readonly [rowBase]: 1 };
/** 0-based utf-8 byte column (nvim extmark/cursor col). Exclusive when used as an end. */
export type ByteCol = number & { readonly [colBase]: "byte0" };
/** 0-based utf-16 index into a JS string. */
export type StrIdx = number & { readonly [colBase]: "utf16" };

export type HeadLnum = Lnum & Brand<number, "HeadLnum">;
export type WorktreeLnum = Lnum & Brand<number, "WorktreeLnum">;
export type PostLnum = Lnum & Brand<number, "PostLnum">;
export type PreLnum = Lnum & Brand<number, "PreLnum">;

export function toRow(l: Lnum): Row;      // l - 1
export function toLnum(r: Row): Lnum;     // r + 1
export function rowAt(i: number): Row;    // brand an array index / count-derived row
export function lnumAt(n: number): Lnum;  // brand a parsed 1-based number (hunk header, RPC)
export function byteLen(s: string): ByteCol;
export function addBytes(a: ByteCol, b: ByteCol): ByteCol;
export function lineAt<T>(lines: readonly T[], l: Lnum): T | undefined; // lines[l - 1]
```

`BufRow` is removed in favour of `Row`; `window.ts` brands become aliases of these (`Row0Indexed = Row`, `Row1Indexed = Lnum`, `ByteIdx = ByteCol`, `StringIdx = StrIdx`) and `ByteIdx1Indexed`/`Position1IndexedCol1Indexed` are deleted if unused.

`neovim-api.types.ts` changes (others untouched):
- `nvim_buf_get_lines`/`nvim_buf_set_lines`: `start: Row, end: Row | -1`
- `nvim_buf_set_extmark`: `line: Row, col: ByteCol, opts: ExtmarkOpts` where `ExtmarkOpts` has `end_row?: Row; end_col?: ByteCol`
- `nvim_buf_clear_namespace`: `line_start: Row, line_end: Row | -1`
- `nvim_win_get_cursor`: returns `[Lnum, ByteCol]`; `nvim_win_set_cursor`: `pos: [Lnum, ByteCol]`
- `nvim_buf_get_text`/`set_text`/`set_mark` likewise.

Render:
- `Highlight = { row: Row; startCol: ByteCol; endCol: ByteCol; group }`; `span()` takes `ByteCol`s; tag/count spans use `byteLen`.
- `Frame.rows` index type `Row` everywhere (`srow`, `erow`, `cur`, `Section.lo/hi`, `MarkerRun.lo/hi`, `restoreAnchor`, `computePinned`).
- `Segment.startCol/endCol`, `Token.col/len`: `ByteCol`.

Core:
- `DiffLine.oldLnum/newLnum`, `Hunk.oldStart/newStart`: `Lnum` (callers already cast to `PreLnum`/`PostLnum`; those casts become narrowing from `Lnum`).
- `LineOp.aLnum/bLnum`: `Lnum`; `Range<L extends Lnum>`; `lnumOf: (i: Row) => Lnum | undefined`; `CommentRecord.lnum: Lnum`; `CommentEntry.oldLnum: Lnum`.

## Invariants

- No runtime behaviour change in stages 1–4 other than fixes that the types expose; each such fix is called out in its stage's commit message and gets a regression test.
- Persisted store JSON is unchanged (brands are type-only), so existing shards load.
- RPC payloads from Lua: every coordinate field is named `row` iff 0-based, `lnum` iff 1-based; `col` is always a 0-based byte column. Fields currently named `row` that carry 1-based values (`gutter.lua` `goto-hunk`/`focus`, overlay cursor) are renamed to `lnum` on both sides in the same change.
- Casts to a coordinate brand (`as Row`, `as Lnum`, ...) appear only in `core/types.ts` helpers and the RPC/nvim-return parsing boundary. Enforced by a grep check added to `hooks/checks.mjs`.
- Exclusive end conventions: extmark `end_row`/`end_col` and `nvim_buf_get_lines` end are exclusive; `Range` and `srow..erow` are inclusive. Keep that, and name exclusive ends `end`/`hi` consistently with a doc comment on the type.

# Stages

## core brands and typed nvim API

Status: done.
- Brands/helpers in `core/types.ts`, plus `ROW0`/`COL0` constants for literal zeros. `BufRow` replaced by `Row` (`render/sticky.ts`).
- `window.ts` aliases point at the core brands; `ByteIdx1Indexed`/`Position1IndexedCol1Indexed`/`pos1col1to0` kept because `nvim/nvim.ts` still uses them.
- `neovim-api.types.ts` tightened per Interfaces (`ExtmarkOpts` exported from there; `nvim_buf_set_mark` line is `Lnum`).
- `nvim/atomic.ts` adds `atomic(method, args)`; existing `nvim_call_atomic` call sites (view.ts, nvimGutterUi.ts, nvimOverlayUi.ts) still build untyped arrays — migrate them in stage 4.
- Temporary `rowAt`/`toLnum(rowAt(..))` at the boundary, to revisit in stage 4: `view/view.ts` (set_lines `at/end`, clear_namespace `lo/hi`, `setCursor` `row + 1`), `view/jump.ts` scratch set_lines, `overlay/nvimOverlayUi.ts` `range` (`rowAt(r.to)` exclusive end). Driver tests use `lnumAt(..)`/`COL0`/`ROW0`.
- Type tests in `core/types.typetest.ts`, unit tests in `core/types.test.ts`.
- Review follow-ups: `sticky.ts` uses `rowAt`/`ROW0` and `computePinned(w0: Row)`; `lineEdit` returns `Row`s so view.ts set_lines/clear_namespace are checked without call-site branding; `CursorInfo.top: Row`; `ReviewUi.setCursor(row: Row)` with temporary `rowAt(..)` at the review.ts callers (removed when render rows are typed in stage 3); `ByteIdx1Indexed = ByteCol1` (new 1-based byte brand in core/types.ts); `ExtmarkOpts` is now `ExtmarkOptions` (extmarks.ts, `virt_text_win_col: ByteCol`) plus typed `end_row/end_col`, no index signature. `jump.ts` `rowAt(i)` is the intended array-index use.
- Deferred: tightening `buffer`/`ns_id` params in `neovim-api.types.ts` to `BufNr`/`NsId` (52 sites, out of scope for coordinates; revisit in stage 4 alongside the boundary work).

- Goal: brands and conversion helpers in `core/types.ts`; `window.ts`/`buffer.ts` re-pointed; `neovim-api.types.ts` tightened; typed `atomic()` builder. Call sites made to compile with explicit `rowAt`/`toRow`/`byteLen` at the boundary (temporarily, where upstream values are still `number`, use `rowAt`, and leave a list of them for later stages).
- Tests:
  - A type test file (`core/types.typetest.ts`, checked by `tsc`) with `@ts-expect-error` asserting: `Lnum` not assignable to `Row` and vice versa; `PostLnum` assignable to `Lnum`, not to `PreLnum`; `number` not assignable to `ByteCol`; `nvim.call("nvim_win_set_cursor", [w, [row0, 0]])` with a `Row` is an error; `nvim_buf_set_extmark` with an `Lnum` line is an error.
  - Unit tests for `toRow`/`toLnum`/`lineAt`/`byteLen` with multibyte input.

## core line numbers and byte columns

Status: done.
- `DiffLine`/`Hunk` lnums, `LineOp`, `mapForward/mapBack`, `Range<L extends Lnum>` (private `shiftLnum` for ±1 within a space), `resolve/locate` `lnumOf: (i: Row) => Lnum | undefined` (default `toLnum`), `CommentRecord.lnum`, `CommentEntry.oldLnum`, `Located.lnum`, `Token`/`Segment` as `ByteCol`. `tokenize` uses `byteLen`/`addBytes`.
- Boundary `lnumAt` added in `state.ts` JSON parsing, `git.ts` untracked-file synthetic hunk, `api.ts` comment add, `overlay/project.ts` clamped lnums (stage 4 to revisit the last three).
- Deviation: `lineage.ts` internals (`Origin.base`, `splice(at)`, base-space maps) stay `number`; they are a private base-line coordinate space that consumers only read via `PostLnum`/`PreLnum` attributions. Revisit only if stage 3/4 needs them.
- Tests: fixtures wrap literals with `lnumAt`; new multibyte `align` segment test in `intraline.test.ts`.
- Review follow-ups: `resolve(anchor?: Lnum): Row | undefined` (no 0 sentinel), `Located.index/fallback: Row`. `Hunk.oldStart/newStart` are now raw `number` (git header value; for an empty side it is the line the gap follows, 0 = top, so not a line coordinate); `parse` keeps raw running counters and brands each emitted `DiffLine` lnum. Known: a del in a whole-file deletion (`+0,0`) still gets `newLnum` 0 via that slot rule — left as-is (behaviour change, revisit in stage 5). Load boundary uses new `parseLnum` (positive-int validation); comments without a valid lnum/anchor are dropped instead of becoming line 0; `parseRanges` validates before branding into the key's space. New `clampLnum` replaces the overlay/project.ts clamps. `lineage.ts` private `BaseLnum` brand not done (internal-only space; deferred).

- Goal: `diff`, `linediff`, `baseline`, `lineage`, `ranges`, `state`, `comments`, `intraline` typed per the Interfaces. `tokenize` computes word-token `col/len` via `byteLen` so non-ASCII word chars (if WORD is ever widened) stay correct.
- Tests:
  - Existing core tests pass unchanged.
  - `intraline` test: a line containing multibyte chars before and inside a changed token yields segments whose `startCol/endCol` match `Buffer.byteLength` of the corresponding prefixes.

## render frame rows and highlights

Status: done.
- `Highlight` (`row: Row`, `startCol/endCol: ByteCol`), `Section.lo/hi` (hi exclusive), `IntraBlock` rows, `emit()` returns `Row`. `span(row, at: ByteCol, text, hl)` now takes the highlighted text and computes `endCol = at + byteLen(text)`, so every span (comment id tag, add/del counts, summary tag) is byte-correct by construction.
- Row params typed `Row`: `planVisualMark`, `nextUnseenHunk`, `rowOfHunk`, `reviveDest` (actions), `commentTarget`/`summaryCommentsIn` (commentActions), `navRow`, `hunkRange`, `fileHeaderRow`, `sourceLineRow` (nav), `restoreAnchor` (anchor). `ReviewView.paintHunk(row: Row)`.
- Temporary `rowAt(..)` at `view/review.ts` action/query call sites and `view/view.ts` `paintHunk(frame, rowAt(info.row))`; stage 4 removes them by branding at action parsing / `CursorInfo.row`.
- Deviation: `MarkerRun.lo/hi` stay `number` — they index `hunk.lines` (the `li` space shared with `RowTarget.li`, placement keys), not frame rows.
- Tests: `render.test.ts` wraps `render` with a bounds assertion on every highlight; new multibyte test checks span bytes equal `+2`, `-2`, `[7] ` behind `──`/`💬 (outdated) ` prefixes. No off-by-one found.

- Goal: `render/*.ts` typed: `Highlight`, `IntraBlock`, `Section`, `MarkerRun`, all row params; spans built only from `ByteCol`s.
- Tests:
  - render test: a file whose path / comment body / header contains multibyte chars produces highlights whose byte ranges, applied to `frame.lines[row]` via `Buffer.from(...).subarray(startCol, endCol)`, exactly equal the intended substring (comment id tag, add/del counts, path). This is the generic check for every `span()` and catches any off-by-one in a highlight.
  - Every highlight satisfies `0 <= startCol < endCol <= byteLen(lines[row])` and `row < lines.length` (property-style assertion over all existing render fixtures).

## nvim adapters and RPC boundary

- Goal: `view/view.ts`, `view/jump.ts`, `view/review.ts` action parsing, `nvimAppUi.ts`, `gutter/*`, `overlay/*`, `api/api.ts`, `targets.ts` and the Lua senders typed and renamed per the RPC invariant; all `+ 1`/`- 1` replaced by helpers; Lua snippets receive pre-converted, suffix-named args. Remove the redundant `end_row` alongside `hl_eol` in the list highlight only if the driver test shows identical extmarks.
- Tests:
  - Driver test (`view.driver.test.ts`): open a review over a fixture with multibyte and tab-containing lines, then read back `nvim_buf_get_extmarks(..., {details=true})` for the review namespace and assert each highlight extmark covers exactly the expected text (via `nvim_buf_get_text` over the extmark range), including intraline segments and the active-hunk / indent decor rows.
  - Driver tests for cursor round-trips: `setCursor` to a frame row lands on that row; gutter `]c` from a known lnum lands on the next hunk's first line; overlay cursor jump lands on the comment's lnum; sticky float highlights the rows it pins.

## lint guard and bug fixes

- Goal: `hooks/checks.mjs` fails on `as (Row|Lnum|ByteCol|StrIdx|HeadLnum|WorktreeLnum|PostLnum|PreLnum)\b` outside an allowlist (`core/types.ts`, RPC parsers, nvim return parsing). Fix any off-by-ones the driver tests from earlier stages exposed and record each in the commit.
- Tests: the check script run against a file with a stray cast fails; full `npx tsc -p .`, `npx vitest run`, `npx biome check .` green.
