---
applyTo: "**/*.ts"
---

# General TypeScript Review

- Do not use dynamic `import()` expressions. Use static `import` statements at
  the top of the file instead.
- We only want to use a single bottom value, so use `undefined` whenever you can
  and avoid `null`. When external libraries use `null`, only use `null` at the
  boundary, and convert to `undefined` as early as possible, so the internals of
  the plugin only use `undefined`.
