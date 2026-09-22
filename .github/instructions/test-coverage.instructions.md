---
applyTo: "**/*.ts"
---

# Test Coverage Review

## Purpose

Evaluate whether the changes in this PR carry adequate test coverage. The goal
is confidence in correctness, not a coverage percentage.

## Guidance

- Take an 80/20 approach. Aim to cover the load-bearing parts of the change with
  a small number of high-value tests. Do NOT push for 100% coverage — exhaustive
  tests for trivial code waste time to write and run and add little value.
- Focus on the parts of the change that are most likely to break or be misused:
  - **Invariants** the code relies on or establishes.
  - **Edge cases** that are realistically likely to occur (empty inputs,
    boundary values, error/failure paths, concurrent or out-of-order events,
    undefined/optional fields).
  - **Branching logic** where a wrong branch would produce incorrect behavior.
- Flag load-bearing logic that is introduced or modified but left untested.
- Do NOT request tests for trivial glue code, simple pass-throughs, or behavior
  that is already exercised indirectly by existing tests.
- Prefer pointing at the specific untested scenario ("the failure branch in
  `foo()` when the request aborts is not covered") rather than asking for
  "more tests" generically.
- Match the project's testing conventions (vitest):
  prefer unit tests for core logic that doesn't need neovim, and integration
  tests via `withNvim()` in `node/test/driver.ts` for UX/neovim interactions.
