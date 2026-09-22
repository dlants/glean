/**
 * Generation-guarded, yielding execution of block-sized work on the node main
 * thread. Each block runs in its own macrotask so RPC requests interleave, and
 * a result computed under an outdated generation is dropped, never applied.
 */
import { type Refinement, refine } from "../core/intraline.ts";

export const yieldToLoop = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

export type Generation = number & { readonly __brand: "Generation" };

export class GenerationGuard {
  private current = 0 as Generation;

  /** Invalidate all outstanding work; returns the new generation. */
  bump(): Generation {
    this.current = (this.current + 1) as Generation;
    return this.current;
  }

  get value(): Generation {
    return this.current;
  }

  isCurrent(gen: Generation): boolean {
    return gen === this.current;
  }

  /** Await `p` and apply its result only if `gen` is still current. */
  async settle<T>(
    gen: Generation,
    p: Promise<T>,
    apply: (value: T) => void,
  ): Promise<"applied" | "stale"> {
    const value = await p;
    if (!this.isCurrent(gen)) return "stale";
    apply(value);
    return "applied";
  }
}

export type RefineBlock = { dels: readonly string[]; adds: readonly string[] };

/**
 * Refine `blocks` one per macrotask under `gen`. Stops as soon as the
 * generation moves on; each block's result is applied immediately so the view
 * upgrades progressively.
 */
export async function runRefine<B extends RefineBlock>(
  guard: GenerationGuard,
  gen: Generation,
  blocks: readonly B[],
  apply: (block: B, refined: Refinement[]) => void,
): Promise<"done" | "stale"> {
  for (const block of blocks) {
    await yieldToLoop();
    if (!guard.isCurrent(gen)) return "stale";
    // `refine` bounds its own work per block (MAX_PAIR_CELLS banding,
    // MAX_BLOCK_ALIGN_CELLS budget, MAX_TOKEN_PRODUCT per pair), so one
    // macrotask is bounded regardless of block size.
    apply(block, refine(block.dels, block.adds));
  }
  return "done";
}
