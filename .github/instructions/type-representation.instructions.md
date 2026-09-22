---
applyTo: "**/*.ts"
---

# Type Representation Review

## Purpose

Check that the changes leverage the type system to make incorrect usage hard or
impossible. Prefer encoding constraints in types over enforcing them with
runtime checks, comments, or convention.

## Make invalid states non-representable

Flag types where combinations of fields can express states that should never
occur, and recommend a disjoint (discriminated) union instead.

Avoid this — `result` and `error` can both be present or both absent:

```typescript
state: {
  type: "success" | "failure";
  result?: Result;
  error?: string;
}
```

Prefer this — each variant carries exactly the fields it needs:

```typescript
state:
  | { type: "success"; result: Result }
  | { type: "error"; error: string };
```

## Additional guidance

- Prefer precise types over loose ones (avoid `string`/`number` where a literal
  union or branded type captures the real domain).
- **Never** introduce new `any` types.
- Use `undefined` as the single bottom value; avoid `null`. If an external
  library hands back `null`, convert it to `undefined` at the boundary so
  internal types never carry `null`.
- Flag optional fields (`?:`) that are really "present in some variants, absent
  in others" — these are usually a sign a discriminated union is needed.
- Watch for non-null assertions (`!`) and unchecked casts (`as`) that paper over
  a weak type; suggest a representation that removes the need for them.

## Glean examples

- Line identities are a discriminated union, not a bag of optional fields. Avoid `{ sha?: string; path?: string; lnum: number }`; use `LineId` with `committed-add` / `committed-del` / `worktree-add` / `worktree-del` variants, each carrying exactly its coordinates.
- Line numbers in different coordinate systems are branded (`HeadLnum`, `WorktreeLnum`, `PostLnum`, `PreLnum`) so a head-commit line can't be passed where a work-tree line is expected. Flag raw `number` line numbers that cross module boundaries, and `as HeadLnum` casts outside the one place that actually derives the coordinate.
- What a buffer row points at is a `RowTarget` union (`commit-header`, `file-header`, `hunk-header`, `line`, `seen-marker`, `blank`), not a record with nullable `hunk`/`li`/`id` fields.
- Fallible IO returns a result union (e.g. `GitResult = ok | error | timeout`) rather than throwing or returning `undefined` for several distinct failure modes.
- Persisted JSON is parsed into these types by validators at the load boundary; internal code never handles unvalidated shapes.
