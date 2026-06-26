# Objective and Context

User request (verbatim):

> We implented this plan. I want to plan out the followup now. Let's keep track
> of the line ranges of the things we've rendered. When we re-render, only
> replace the line ranges that are affected.
>
> Let's come up with a strategy for how we will decide whether the section needs
> to be re-rendered or not. Deep comparison? Incrementing a dirty counter on
> edit?

## What we're building and why

`Session:render` is a whole-buffer repaint. Every render rebuilds the full
`lines`/`row_map`/`highlights` from `build()`, then `nvim_buf_set_lines(buf,
0, -1, ...)` replaces every line, `nvim_buf_clear_namespace(buf, NS, 0, -1)`
tears down every extmark, and the loop re-stamps them all. `apply_intraline`
likewise clears `NS_INTRA` wholesale. Every mark, collapse, undo, scope switch,
live reload, and (since the async-blame work) every throttled streaming tick
pays for the entire buffer no matter how little changed. At hundreds of files
that whole-buffer churn is the chuggy cost.

The fix: track the buffer line range each rendered **section** occupies, and on
re-render apply nvim mutations only to the sections whose projection actually
changed. The diff text and the model stay exactly as they are; this only changes
*how* the projection is pushed into the buffer.

## The strategy question (deep comparison vs. dirty counter)

The user asks how we decide a section is stale. **Recommendation: per-section
content signature comparison (cheap "deep comparison"), not a dirty counter.**

Reasoning, grounded in this codebase's core invariant — *the model is the source
of truth, the buffer is a pure projection*:

- A **dirty counter** stamped on edits makes the buffer's freshness depend on a
  side-channel that every mutator must remember to bump correctly. A section's
  render depends on many inputs: diff content (reload), seen/del ranges and
  comments in the store, collapse view-state, and the ownership cache's
  `loaded` transition (streaming). Missing a single bump silently paints a
  stale buffer — exactly the class of bug the pure-projection invariant exists
  to make impossible. It also couples the action layer to render internals
  (each action must know which section it dirtied).

- A **content signature** keeps `build()` fully pure and recomputed every render
  (it is cheap Lua string assembly — the expensive blame is already async, and
  intra-line is already chunked). We hash each section's emitted lines +
  highlight tuples into a short signature, compare against the signature from the
  last paint, and only touch nvim for sections whose signature differs. Staleness
  is structurally impossible because the comparison is recomputed from the model
  every time. This mirrors the existing whole-buffer `render_sig` no-op skip and
  the content-addressable `_intra_cache` (keyed by text, never by a manual flag).

So `build()` does *not* change its contract; the incremental logic lives entirely
in the render/apply layer. We pay one full pure rebuild per render (already true
today) and save the nvim API churn (set_lines + extmark teardown), which is the
actual cost.

## Key entities / files

- `lua/glean/init.lua`:
  - `Session:build()` — pure projection; today returns `lines, row_map,
    highlights, intra_blocks`. We extend it to also emit **section boundaries**
    (ordered list of `{ key, lines, highlights, intra }` or, minimally, a list of
    `{ key, start_row, end_row }` markers alongside the flat arrays).
  - `Session:render()` — becomes the section-diff + minimal-apply driver.
  - `Session:render_sig` — the existing whole-buffer no-op skip; subsumed by /
    reused as the per-section signature primitive.
  - `Session:apply_intraline` — scope its `NS_INTRA` clear + re-refine to the
    changed span.
  - `Session:streaming_render` / `schedule_streaming_render` — unchanged callers;
    they benefit automatically once `render()` is incremental.
  - `M.compute_ancestry`, `self.row_map`, `self.row_hl`, `highlight_cursor_hunk`,
    `update_sticky` — row-keyed derived state, recomputed fully each render.
- Tests: `init_test.lua` (render/seen-placement/streaming), `dirty_combined_test.lua`.

# Design

## Sections

A **section** is a contiguous run of buffer rows produced by one top-level
`build()` unit, with a **stable key** independent of its row position:

- combined scope: one section per `combined_files` entry, key = `"cf:" .. path`.
- commits scope: one section per commit header *and* one per file under it, keyed
  by `"commit:" .. sha` and `"file:" .. sha .. ":" .. path`. (Granularity can
  start coarser — one section per commit including its files — and be refined
  later; per-file is the natural streaming unit.)
- the mode header line: key `"header"`.
- the trailing comments summary: key `"comments"`.

Keys must be **stable across renders** (so a section can be matched to its prior
paint) and **order-stable** (sections appear in the same document order every
render unless the model reorders them). Seen/unseen placement reorders *hunks
within* a file section, which is fine — that just changes that section's content
signature; it does not move the section relative to others.

## What `build()` emits

`build()` keeps producing the same flat `lines`/`row_map`/`highlights`/`intra`
it does today (so `row_map`, ancestry, and `row_hl` continue to be derived
wholesale and nothing downstream of row-keying changes). It *additionally*
records, as it `emit`s, the `[start_row, end_row)` span and key of each section —
a side list `sections = { { key, lo, hi }, ... }` in document order. This is a
trivial bookkeeping addition around the existing `emit` calls (push a boundary
when a new top-level unit starts).

## Per-section signature

For each section, compute a signature over its slice of `lines` plus its
highlight tuples (`row-lo`, `hl_group`) and its `pending` rows — i.e. everything
that determines the visible result for those rows. This is the existing
`render_sig` idea applied to a row sub-range. Store `self._sections` from the
last paint as `key -> { sig, lo, hi }`.

## The render diff + minimal apply

`render()`:

1. `build()` → new `lines`, `row_map`, `highlights`, `intra`, `sections`.
2. Recompute `row_map`, `ancestry`, `row_hl` wholesale (cheap, pure) — these stay
   absolute-row-keyed and always reflect the new layout.
3. Compute the new per-section signatures. Compare each against
   `self._sections[key]`. A section is **dirty** if its key is new, gone, or its
   signature changed. (A section whose only change is row offset — because a
   section above it grew/shrank — is **not** dirty; its text and extmarks shift
   automatically.)
4. If no section is dirty → return (this replaces today's whole-buffer
   `render_sig` early-out).
5. Apply each dirty section as its **own edit**, processed **bottom-to-top** in
   document order, using the section's **old** `[lo, hi)` range for the
   `nvim_buf_set_lines` position. Processing descending means each edit only
   shifts rows *below* it, which have already been applied, so earlier (higher)
   sections' old ranges stay valid as we go up — no cumulative-delta bookkeeping.
   For each dirty section: `set_lines(old_lo, old_hi, new_section_lines)`, then
   clear `NS`/`NS_INTRA` over the new range and re-stamp extmarks (and
   `_line_marks`) only for those rows. New/removed sections are handled the same
   way (an empty old range = pure insert at that row; an empty new slice =
   deletion). Untouched sections keep their text and extmarks; nvim shifts them
   automatically.

   After the edits, recompute `self._sections` (the `key -> { sig, lo, hi }`
   mapping) from this render's **new** layout. The new `[lo, hi)` ranges are
   already known directly from `build()`'s `sections` side list, so there is no
   need to derive them from the applied deltas: the per-edit *old* ranges drive
   *where* we write; the *new* `build()` ranges are *what we record* for the next
   diff.
6. Re-stamp `self._sections = { key -> { sig, lo, hi } }` from the new layout.
7. Preserve cursor (already simple since we no longer wipe the whole buffer),
   `highlight_cursor_hunk`, `update_sticky`.

## Intra-line under incremental render

`apply_intraline` currently clears `NS_INTRA` over the whole buffer and re-walks
all blocks. Scope both to the dirty sections: clear `NS_INTRA` only over their
rows and only re-refine intra blocks whose rows fall in them. Blocks outside
keep their emphasis extmarks (auto-shifted). The `_intra_cache` is already
content-addressable, so refinement of a re-entered block is free; this change
only avoids the extmark teardown for untouched rows. The generation guard
(`_intra_gen`) is unchanged.

## Invariants

- The buffer remains a pure projection of `(model, store, ownership cache)`.
  Incremental apply must produce a buffer **byte- and extmark-identical** to a
  full repaint of the same state — the diff is an optimization, never a
  divergence. (This is directly testable: run a sequence of mutations
  incrementally and assert the buffer + extmarks equal a from-scratch render.)
- `build()` stays pure and side-effect free; no mutator bumps any render state.
  Staleness cannot occur because signatures are recomputed from `build()` output
  every render.
- `row_map`, `ancestry`, `row_hl` are always rebuilt to the new absolute layout,
  so all action/navigation code (which reads `row_map[row]`) is unaffected.
- Section keys are stable and order-stable across renders; a section that only
  shifts position (not content) is never repainted.
- Extmarks outside the dirty sections are never cleared, so they shift with their
  text automatically and keep their identities.
- Cursor, folds, and sticky float survive a partial update.
- All existing generation/validity guards (`_load_gen`, `_render_gen`,
  `_intra_gen`, `nvim_buf_is_valid`) are preserved.

# Stages

> **Stage 1 status: DONE.** `build()` now returns a 5th value `sections` (an
> ordered `{key, lo, hi}` list) recorded via a local `section(key, fn)` wrapper
> around the existing top-level `emit` units. Keys: `"header"`, per combined
> file `"cf:"..path`, per commit `"commit:"..sha` (coarser per-commit
> granularity, including its files — allowed by the plan; per-file refinement
> deferred to later stages), and `"comments"`. `render()` ignores the new value
> (still full repaint). Coverage is gapless: every emitted row falls inside one
> section. Added an `init_test.lua` case asserting contiguous tiling
> (lo[1]==0, hi[last]==#lines, each lo==prev hi), stable keys across two
> builds, correct counts, and both scopes. Full suite green (366 init / all
> suites). Note: `stylua --check` fails repo-wide (project uses 2-space indent,
> not stylua tab default) — pre-existing, not introduced here.

## Stage 1 — Section boundaries in `build()` (no behavior change)

- Goal: `build()` additionally returns an ordered `sections` list of
  `{ key, lo, hi }` covering every row, with stable keys; `render()` ignores it
  for now (still full repaint).
- Verification (unit, `init_test.lua`):
  - Behavior: sections tile the buffer with no gaps/overlaps and cover `[0,
    #lines)`; keys are unique and stable across two renders of the same state.
  - Setup: combined-scope session with a few files; commits-scope session.
  - Actions: call `build()` twice; inspect `sections`.
  - Expected: contiguous coverage, stable keys, correct count (files + header +
    comments).
- Before moving on: full suite, type/lint checks pass.

> **Stage 2 status: DONE.** `render()` now captures `build()`'s 5th value and
> calls `Session:section_sigs(lines, row_map, highlights, sections)` to fold each
> section's slice of `lines` + its in-range highlight tuples + its `pending` rows
> into one signature string (`render_sig` applied to a row sub-range). It stores
> `self._sections = { key -> {sig, lo, hi} }` and computes `self._dirty` via the
> local `dirty_sections(prev, cur)` (new/gone/changed keys). The old whole-buffer
> `render_sig` early-out is re-expressed as `if next(dirty) == nil then return`;
> `self._render_sig` is still updated (kept for any external readers) but no
> longer gates the return. Apply is unchanged (still whole-buffer set_lines +
> extmark teardown) — that is Stage 3. Added an `init_test.lua` case (commits
> scope, 3-commit repo): identical re-render yields empty dirty set; marking one
> commit's hunk dirties only that commit's section, leaving header and the other
> commit clean. Full suite green (372 init / all suites).

## Stage 2 — Per-section signatures + dirty detection (still full apply)

- Goal: `render()` computes per-section signatures, stores `self._sections`, and
  computes the dirty set, but still applies via the current whole-buffer path.
  The existing whole-buffer `render_sig` no-op early-out is re-expressed as
  "no dirty sections".
- Verification (unit):
  - Behavior A: re-rendering identical state yields an empty dirty set.
  - Behavior B: marking one hunk in one file marks exactly that file's section
    dirty (and `comments`/header clean); a streaming `loaded` transition for one
    file marks only that file's section dirty.
  - Setup: store pre-seeded; combined session; spy on the computed dirty set.
  - Expected: dirty set matches the changed section(s) only.
- Before moving on: full suite, type/lint checks pass.

## Stage 3 — Minimal apply over dirty sections

- Goal: `render()` applies per-dirty-section `set_lines` + scoped extmark
  re-stamp (bottom-to-top, off old ranges) instead of the whole buffer;
  `apply_intraline` scoped to the changed rows.
- Verification (unit/integration):
  - Behavior A (equivalence — the load-bearing test): for a scripted sequence
    (open → mark → collapse → streaming loads → reload → scope toggle), the
    incrementally-rendered buffer text **and** the `NS`/`NS_INTRA` extmark set
    are identical to a fresh full render of the same final state.
  - Behavior B: after a single-file change, rows of untouched files retain their
    original extmark ids (proves they were not re-stamped).
  - Behavior C: a change that grows/shrinks a section keeps following sections
    correct (cursor on a trailing line stays on the same semantic row).
  - Setup: helper that snapshots buffer lines + extmarks; fake runner for
    streaming.
  - Expected: byte/extmark equivalence; untouched extmark ids stable; layout
    correct after height changes.
- Before moving on: full suite, type/lint checks pass; manual smoke on a large
  real diff (mark/collapse/scroll feel snappy; streaming settles without churn).

# Out of scope

- Any change to `build()`'s projection content, the ownership cache/loader, or
  the intra-line refinement algorithm.
- Sub-file (per-hunk) section granularity; sections are per file/commit.
