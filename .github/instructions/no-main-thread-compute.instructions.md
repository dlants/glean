---
applyTo: "**/*.{ts,lua}"
---

# No Main-Thread Compute Review

## Purpose

Glean must be safe to run in any nvim session: a slow repo, a huge hunk, or a hung git process must never freeze the editor. All work happens in the node process; nvim only dispatches events and applies render output. Within node, the event loop must stay responsive so RPC requests are answered promptly.

## Flag in Lua

- Any Lua code path that does more than constant work plus a `rpcnotify`/`rpcrequest`: loops over diff lines, string diffing, `vim.diff`, JSON encoding of large state, parsing.
- Any `vim.system(...):wait()`, `vim.fn.system`, `io.popen`, or other synchronous process/file IO.
- `vim.rpcrequest` handlers on the node side that await git or fresh computation; rpcrequest blocks nvim until node replies, so they must answer from in-memory state.

## Flag in TypeScript

- Synchronous superlinear work on the node main thread without a size cap (e.g. an m·n alignment over unbounded inputs). Superlinear algorithms must have an explicit cap and fall back to a cheap result above it.
- Long batches of work that don't yield (`setImmediate`/`await`) between units, and results applied without checking they are still current (generation counter).
- `*Sync` fs or child_process calls outside startup/tests.
- Git or other subprocess calls without a timeout, and polls that can overlap themselves.
- Unbounded render batches sent to nvim in a single call; batches must be bounded in size.
