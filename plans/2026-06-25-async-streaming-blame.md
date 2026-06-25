# Objective and Context

User request (verbatim):

> let's move the blame/reverse_blame into a serial / async code.
>
> We should process files/hunks in the background and stream them into the
> display buffer as we complete processing.

## What we're building and why

Combined-scope startup for a large diff (~5k LOC, hundreds of files) is slow and
chuggy because per-file ownership is resolved by **synchronous** `git blame -p`
(`Session:provenance`) and `git blame -p --reverse` (`Session:del_attribution`),
each blocking the UI thread inside the synchronous `Session:build()` render. With
hundreds of files that is hundreds of blocking subprocess spawns before the
buffer is usable.

We want the buffer to appear immediately and then **fill in ownership-dependent
state in the background**, re-rendering as each file's blame completes, so the
user can start reading/scrolling right away.

## Key insight that makes this tractable

Ownership only affects *seen-resolution* (which `line_identity` a changed line
maps to → whether a hunk lands in the seen section and which marks apply). It
does **not** affect the displayed diff text. So for a file whose blame has not
yet completed, we can render its hunks immediately as "ownership pending"
(treated as unseen, identity nil) and the visible text is already correct; only
seen/unseen *placement* and mark interaction need ownership, and those settle
once blame lands.

Ownership is consumed in exactly two contexts, which we treat differently:

- **Rendering** (`Session:build` via the `combined_owner` closure → `provenance`
  / `del_attribution`): may tolerate "pending" (no sync blame; identity nil).
- **Actions** (`Session:target_identities`, `Session:row_identity`, marking):
  must always get a correct answer, so they keep the *synchronous compute-on-
  demand* path for the single path being acted on (cheap: one file).

## Key entities / files

- `lua/glean/git.lua` — `Git:run` (sync `vim.system():wait()`). Add an async
  runner. `Git:blame` / `Git:reverse_blame` produce porcelain.
- `lua/glean/init.lua`:
  - `Session:provenance(path)` / `Session:del_attribution(path)` — per-path
    cached blame maps (`self._prov`, `self._del_attr`).
  - `Session:combined_owner(path)` — closure mapping a diff line → (sha, lnum);
    the sole rendering consumer of the caches.
  - `Session:blame_ranges(path)` — already restricts blame to hunk line spans.
  - `Session:build` / `Session:render` — synchronous pure projection.
  - `Session:reload`, `Session:set_scope`/`toggle_scope`, `Session:start_live` —
    lifecycle points that reset caches and must (re)kick the prefetcher.
- `lua/glean/provenance.lua` — `parse_blame` (pure; unchanged).
- Tests: `git_test.lua`, `init_test.lua`, `dirty_combined_test.lua`. All inject a
  fake synchronous runner via `opts.run`.

# Design

## The ownership cache (the new source of truth for ownership)

Introduce an explicit per-session **ownership cache** that owns all
blame-derived state. Conceptually it is keyed per file path (one `git blame`
resolves every hunk in a file, and reverse blame is per path), and each entry
carries a status:

- `loading` — a blame job has been queued/started but not finished.
- `loaded` — forward provenance map and (if the file has del lines) del
  attribution map are both resolved and stored.

The render layer and the action layer both read **only** from this cache; the
raw `git blame` calls feed it and nothing else. This replaces the implicit
"`self._prov[path] == nil`" sentinel with an explicit, inspectable status.

Status granularity note: the user framed this as per-hunk; ownership actually
resolves per file (one blame covers all of a file's hunks), so the cache is
keyed per path and a hunk's load-state is its file's load-state. The plan keeps
the per-path key but exposes a `hunk_loaded(target)` predicate so call sites
read naturally.

## Components

1. **Async git runner** (`git.lua`). `Git:run_async(args, cb)`:
   - With an injected `self._run` (tests): call it and invoke `cb` synchronously
     — deterministic, no real processes.
   - Otherwise `vim.system(cmd, opts, cb)` with no `:wait()`, `cb` scheduled on
     the main loop; signature mirrors `run` (`stdout_or_nil, err`).

2. **Ownership cache + accessors** (`init.lua`). The cache subsumes today's
   `self._prov` / `self._del_attr`:
   - `owner_status(path)` → `nil` (never requested) | `"loading"` | `"loaded"`.
   - `combined_owner(path)` is built only for `loaded` files; the renderer never
     asks for an owner of a non-loaded file.
   - Rendering a non-loaded file emits its hunks in a **pending** presentation
     (treated as unseen, identity nil, visually a normal unmarked diff) — the
     diff text is already correct; only seen placement is deferred.

3. **Background loader** (`init.lua`, combined scope only). A serial async queue
   that walks displayed combined files in document order: set entry `loading`,
   `run_async` forward blame (+ reverse blame when the file has dels), parse,
   store maps, mark `loaded`, then request a coalesced re-render. Serial = one
   job in flight (satisfies "serial / async", bounds process count).

4. **Coalesced streaming re-render**. Each `loaded` transition marks the session
   dirty; a single re-armed throttle (`vim.defer_fn`, ~50–80ms) calls
   `Session:render()`, which rebuilds `lines`/`row_map`/highlights wholesale and
   preserves the cursor. Loaded files stream into their settled seen/unseen
   placement; a final render fires when the queue drains. Throttling keeps total
   re-render cost bounded rather than O(N^2).

5. **FS watcher integration**. The live work-tree poll (`start_live` /
   `reload`) already rebuilds the model on change. Under this design, a reload
   resets the ownership cache for changed paths and re-enqueues them on the
   background loader, so the watcher "processes hunks in the background and
   updates the cache" exactly like the initial open. Unchanged paths keep their
   `loaded` entries (subject to the commit-set rule for del attribution).

## Pending hunks are inert; the load assertion is a backstop

Pending (non-`loaded`) hunks are **not wired to any action in the first place**:
they render as non-actionable rows (no markable identity in `row_map`), so the
UI never offers mark / comment / collapse-seen on them. The action layer
(`target_identities`, `row_identity`, `toggle_seen`, marker / comment-on-line
actions) reads ownership from the cache and **asserts** the target file is
`loaded`. Reaching that assertion is a programming error — a UI that violated
the "pending hunks are inert" invariant — so it should fail loudly (hard
error / `assert`), not degrade gracefully. It is a backstop, not an expected
user-facing path, and removes any need for a synchronous on-demand blame
fallback — the cache is the only loader.

## Why this approach (alternatives rejected)

- **Implicit peek/sentinel ownership** (prior draft): rejected in favor of an
  explicit load-state cache — easier to reason about, testable status, and a
  single read path for both render and actions.
- **Synchronous on-demand blame for actions**: rejected; with the hard-error
  rule the cache is the sole loader, keeping one code path and avoiding
  surprise UI stalls.
- **Literal incremental row append**: rejected; seen placement reorders hunks
  within a file, so a completed file can't be appended — it must replace its
  region. Coalesced full re-render preserves the pure-projection invariant.
- **Parallel blame (concurrency > 1)**: deferred; serial first per request.

## Invariants

- The buffer is a pure projection of `(model, store, ownership cache)`. Render
  reads ownership only via the cache; as entries become `loaded`, re-render
  reflects them.
- Render never triggers blame; only the background loader does. The first
  synchronous paint issues zero blame calls.
- Pending hunks expose no actionable target, so actions never reach them; the
  action layer additionally asserts `loaded` as a loud backstop (a tripped
  assert means a UI invariant was violated).
- A `loaded` file with a known-empty provenance map (untracked/worktree add)
  still routes to WORKTREE and is markable — "loaded-empty" is distinct from
  "not loaded".
- Generation guard: each loader job and throttle captures a model generation;
  results/renders from a superseded model (reload, scope switch, commit-set
  change) are dropped. Buffer/window validity is re-checked inside every async
  callback.
- For a fresh review with no marks, the first paint is visually identical to the
  fully-loaded buffer (ownership only changes seen placement, which is empty
  when nothing is marked).
- Cache + loader reset together on `reload`/scope-switch; del attribution is
  retained across content-only reloads per the existing commit-set rule.

# Stages

## Stage 1 — Async git runner  ✅ DONE

- Goal: `Git:run_async(args, cb)` exists; synchronous under an injected runner,
  non-blocking otherwise. No callers yet.
- Implemented `Git:run_async` in `git.lua`: injected runner path invokes `cb`
  synchronously (`cb(stdout)` / `cb(nil, stderr)`); otherwise `vim.system` with
  no `:wait()`, `cb` scheduled on the main loop. Signature mirrors `run`.
- Tests added to `git_test.lua`: injected-runner async matches sync blame +
  error path nil; real-repo (`run=nil`) async completes via `vim.wait`.
- Full suite green (git_test 50 passed; all suites passed). No stylua/luacheck
  config in repo; code follows existing 2-space style.
- Verification (unit, `git_test.lua`):
  - Behavior: async runner yields the same stdout as sync `run` for a blame, and
    `nil` on the error path.
  - Setup: fixture repo + injected fake runner; one real-repo case.
  - Actions: call `run_async`, capture the callback args.
  - Expected: stdout matches sync `blame`; error → `nil`.
- Before moving on: full suite, type/lint checks pass.

## Stage 2 — Ownership cache + render-from-cache  ✅ DONE

- Goal: per-file ownership state lives in the explicit cache with
  `loading`/`loaded` status (keyed per file path; a hunk's load-state is its
  file's); `combined_owner` is derived from cache entries; `build()` renders
  non-loaded files in the pending (unseen) presentation and issues no blame.
- Verification (unit, `init_test.lua`, spy runner counting blames):
  - Behavior A: rendering a combined file with no cache entry issues zero blame
    calls and renders its hunks as unseen.
  - Behavior B: after the cache is populated for a path (directly, in-test), a
    re-render places that file's previously-seen hunk into the seen section.
  - Behavior C: a `loaded` file with an empty provenance map (untracked add)
    routes to WORKTREE and is markable.
  - Setup: combined-scope session; store pre-seeded with one seen hunk.
  - Expected: call counts and seen placement as described.
- Before moving on: full suite, type/lint checks pass.

Implementation notes (Stage 2):
- Added an explicit per-path ownership cache `self._owner[path]` carrying a
  status: `"loading"` (transient, set inside `load_owner`) → `"loaded"` with
  `{prov, del_attr}` maps. New accessors: `owner_status(path)`,
  `hunk_loaded(target)` (per-file load-state predicate exposed for Stage 3),
  `load_owner(path)` (idempotent sync loader), `load_combined_owners()`
  (loads every displayed combined file).
- `combined_owner(path)` now reads ONLY the cache: a non-`loaded` file returns a
  pending closure `function() return nil end`, so its hunks resolve identity-nil
  → unseen and `build()` issues zero blame. `provenance(path)` is now a thin
  accessor over `load_owner`; the raw blame moved to `compute_provenance(path)`
  (no caching). Del attribution stays in `self._del_attr` (retained across
  content-only reloads per the commit-set rule) and is folded into the loaded
  entry by `load_owner`.
- Deviation from the "build never blames in normal use" end-state: since the
  async background loader doesn't exist until Stage 4, `M.open`, `reload`, and
  `set_scope` call `load_combined_owners()` synchronously right before `render`
  so the first painted buffer matches the fully-loaded result and all existing
  combined tests stay green. `build()` itself is pure/blame-free (verified by
  the new zero-blame test); Stage 4 replaces these sync calls with the async
  queue feeding the same cache.
- `reload` resets `self._owner = nil` (was `self._prov`); `_del_attr`/`_del_child`
  retention logic unchanged.
- Tests (init_test.lua): Behavior A (pending render issues zero blame; no seen
  section; body shown; `owner_status` nil), Behavior B (after
  `load_combined_owners` the pre-seen hunk migrates into the seen section;
  `owner_status` "loaded"), Behavior C (untracked worktree add is loaded-empty:
  status "loaded", empty provenance map, routes to WORKTREE and is markable).
- Full suite green (init_test 313 passed; all suites passed). No enforced
  stylua/luacheck config; code follows existing 2-space style.

## Stage 3 — Pending hunks inert + load assertion backstop

- Goal: pending (non-`loaded`) hunks render as non-actionable rows (no markable
  identity exposed through `row_map`), so no action targets them. The action
  layer (`target_identities`/`row_identity`/`toggle_seen`/marker actions)
  asserts its target file is `loaded`; tripping the assert fails loudly.
- Verification (unit, `init_test.lua`):
  - Behavior A: rows of a non-loaded file expose no markable target — `m` on
    such a row is a no-op at the UI level (no action dispatched).
  - Behavior B: once the file is `loaded`, the same row marks correctly.
  - Behavior C: directly invoking the action on a non-loaded target trips the
    assertion (backstop) — verifies the invariant is enforced, not user-facing.
  - Setup: session with a not-loaded file and a loaded file.
  - Expected: no dispatch / no mutation in A; correct mark in B; assertion in C.
- Before moving on: full suite, type/lint checks pass.

## Stage 4 — Background loader + coalesced re-render + FS watcher

- Goal: opening a combined review paints immediately with pending files, then a
  serial async queue loads each file's ownership and a throttled re-render
  settles seen placement; the queue drains to a final render. Wired into
  open / reload / scope-switch / live-poll with generation + validity guards.
- Verification:
  - Behavior A (integration, async-capable fake runner): after open, every
    displayed combined file is loaded exactly once, in order; a pre-seen hunk
    migrates into the seen section only after its file loads.
  - Behavior B: reload / scope toggle mid-flight drops stale jobs (no render
    from the old generation; no error on an invalidated buffer).
  - Behavior C: closing the buffer mid-flight aborts cleanly (callbacks no-op).
  - Behavior D: a live-poll change re-enqueues only changed paths; unchanged
    paths keep their `loaded` entries.
  - Setup: fake runner able to defer callbacks to simulate async ordering; a
    store pre-seeded with one seen hunk.
  - Expected: single load per file, correct eventual placement, no superseded-
    generation renders.
- Before moving on: full suite, type/lint checks pass; manual smoke on a large
  real diff (immediate paint + background settle).

## Stage 5 — Tuning + polish

- Goal: tune throttle interval; skip no-op re-renders; ensure `_blame_ranges`
  resets alongside the cache.
- Verification: confirm the first paint excludes blame and that the steady-state
  buffer matches the all-sync render for a fresh review; regression-test mark-
  during-load (hard error) and mark-after-load (success).
- Before moving on: full suite, type/lint checks pass.

# Out of scope

- Commits-scope lazy `commit_diff` per-commit subprocesses (`lazy_commit_files`).
- The intra-line phase (already async/chunked) — unchanged.

# Followup project — incremental, line-segmented rendering

Today `Session:render` is a **full repaint**: `build()` regenerates the whole
`lines`/`row_map`/`highlights` array, then `nvim_buf_set_lines(buf, 0, -1, ...)`
replaces every line and `nvim_buf_clear_namespace(buf, 0, -1)` tears down and
recreates every extmark. Every action — mark, collapse, undo, scope switch, live
reload, and (under this plan) every throttled streaming tick — pays for the
entire buffer regardless of how little changed. At hundreds of files this
whole-buffer churn is itself a source of the chuggy feel, independent of blame.

Because the renderer already knows exactly what it draws and on which rows, we
can make re-render **incremental**: diff the newly-built `lines`/highlights
against the previous render and apply only the changed line ranges
(`nvim_buf_set_lines` over a narrow span) and re-stamp only the affected
extmarks, instead of replacing the whole buffer. The coalesced streaming
re-render in this plan would then update just the rows of the file(s) that
became `loaded` since the last paint, rather than every row.

This is deliberately **out of scope here** (it fights the current
"replace-everything" projection and needs its own design — stable region keying,
a render diff, extmark reconciliation, cursor/fold preservation across partial
updates). Captured as a separate followup so the async-blame work can land
first against the existing full-repaint path, then this optimization can replace
that path underneath it without changing the cache/loader design.
