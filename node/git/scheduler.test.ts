import { describe, expect, it } from "vitest";
import {
  GenerationGuard,
  RefineCache,
  runRefine,
  yieldToLoop,
} from "./scheduler.ts";

const words = (i: number, salt: string) =>
  Array.from({ length: 40 }, (_, k) => `w${(i * 7 + k) % 97}${salt}`).join(" ");

function bigBlocks(n: number) {
  return Array.from({ length: n }, (_, b) => ({
    id: b,
    dels: Array.from({ length: 20 }, (_, i) => words(i + b, "a")),
    adds: Array.from({ length: 20 }, (_, i) => words(i + b, "b")),
  }));
}

describe("runRefine", () => {
  it("lets a concurrent request be answered before a large refine finishes", async () => {
    const guard = new GenerationGuard();
    const gen = guard.bump();
    const events: string[] = [];
    const refining = runRefine(guard, gen, bigBlocks(5), () => {
      events.push("block");
    }).then(() => events.push("refine-done"));
    // Stand-in for an RPC request arriving mid-refine: it is a fresh macrotask.
    const request = new Promise<void>((r) => setTimeout(r, 0)).then(() =>
      events.push("request"),
    );
    await Promise.all([refining, request]);
    const req = events.indexOf("request");
    expect(req).toBeGreaterThanOrEqual(0);
    expect(req).toBeLessThan(events.indexOf("refine-done"));
    expect(events.filter((e) => e === "block").length).toBe(5);
  });

  it("stops and applies nothing further once the generation moves on", async () => {
    const guard = new GenerationGuard();
    const gen = guard.bump();
    const applied: number[] = [];
    const run = runRefine(guard, gen, bigBlocks(5), (b) => {
      applied.push(b.id);
      if (b.id === 2) guard.bump();
    });
    expect(await run).toBe("stale");
    expect(applied).toEqual([0, 1, 2]);
  });

  it("applies refinements that pair similar lines", async () => {
    const guard = new GenerationGuard();
    const out: number[] = [];
    await runRefine(
      guard,
      guard.bump(),
      [{ dels: ["let x = 1"], adds: ["let x = 2"] }],
      (_b, r) => out.push(r.length),
    );
    expect(out).toEqual([1]);
  });
});

describe("GenerationGuard.settle", () => {
  it("drops a response that lands after invalidation", async () => {
    const guard = new GenerationGuard();
    const gen = guard.bump();
    let release!: (v: string) => void;
    const slow = new Promise<string>((r) => {
      release = r;
    });
    const seen: string[] = [];
    const pending = guard.settle(gen, slow, (v) => seen.push(v));
    const fresh = guard.bump();
    release("old");
    expect(await pending).toBe("stale");
    expect(
      await guard.settle(fresh, Promise.resolve("new"), (v) => seen.push(v)),
    ).toBe("applied");
    await yieldToLoop();
    expect(seen).toEqual(["new"]);
  });
});

describe("RefineCache", () => {
  it("reuses a refinement for identical block text and evicts past its bound", () => {
    const cache = new RefineCache(2);
    const a = { dels: ["let x = 1"], adds: ["let x = 2"] };
    const first = cache.refine(a);
    expect(cache.refine({ dels: [...a.dels], adds: [...a.adds] })).toBe(first);
    cache.refine({ dels: ["b"], adds: ["c"] });
    cache.refine({ dels: ["d"], adds: ["e"] });
    expect(cache.size).toBe(2);
    expect(cache.refine(a)).not.toBe(first);
  });
});
