import { describe, expect, it } from "vitest";
import { align, markAdds, unmarkAdds, unseenAdds } from "./baseline.ts";
import type { WorktreeLnum } from "./types.ts";

const lines = (s: string) => s.split("\n");
const wl = (...n: number[]) => n as WorktreeLnum[];

function render(base: string[], reviewed: string[], wt: string[]): string {
  const unseen = unseenAdds(reviewed, wt);
  return align(base, wt)
    .flatMap((op) =>
      op.kind === "add"
        ? [
            `+${op.bLnum}:${unseen.has(op.bLnum as WorktreeLnum) ? "unseen" : "seen"}`,
          ]
        : [],
    )
    .join(" ");
}

function allAdds(base: string[], wt: string[]): WorktreeLnum[] {
  return align(base, wt).flatMap((op) =>
    op.kind === "add" ? [op.bLnum as WorktreeLnum] : [],
  );
}

function expectAddOnly(head: string[], reviewed: string[]) {
  expect(align(head, reviewed).filter((op) => op.kind === "del")).toEqual([]);
}

const base = lines("a\nb\nc\nd\ne");

describe("baseline", () => {
  it.each([
    ["first line of run", 3, "X"],
    ["middle of run", 4, "Y"],
    ["last line of run", 5, "Z"],
  ])("editing the %s makes only it unseen", (_, idx, text) => {
    const wt = lines("a\nb\nx\ny\nz\nc\nd\ne");
    const reviewed = markAdds(base, wt, allAdds(base, wt));
    expect(reviewed).toEqual(wt);
    expect(render(base, reviewed, wt)).toBe("+3:seen +4:seen +5:seen");
    const wt2 = [...wt];
    wt2[idx - 1] = text;
    const s = (k: number) => (k === idx ? "unseen" : "seen");
    expect(render(base, reviewed, wt2)).toBe(
      `+3:${s(3)} +4:${s(4)} +5:${s(5)}`,
    );
    expect(render(base, reviewed, wt)).toBe("+3:seen +4:seen +5:seen");
  });

  it("insert into a marked run", () => {
    const wt = lines("a\nb\nx\ny\nz\nc\nd\ne");
    const reviewed = markAdds(base, wt, allAdds(base, wt));
    expect(render(base, reviewed, lines("a\nb\nx\nNEW\ny\nz\nc\nd\ne"))).toBe(
      "+3:seen +4:unseen +5:seen +6:seen",
    );
  });

  it("a shifted marked region stays seen", () => {
    const wt = lines("a\nb\nx\ny\nc\nd\ne");
    const reviewed = markAdds(base, wt, allAdds(base, wt));
    expect(render(base, reviewed, lines("a\nNEW\nb\nx\ny\nc\nd\ne"))).toBe(
      "+2:unseen +4:seen +5:seen",
    );
  });

  it("duplicate lines far apart", () => {
    const wt = lines("a\ndup\nb\nc\nd\ndup\ne");
    expect(render(base, markAdds(base, wt, wl(2)), wt)).toBe(
      "+2:seen +6:unseen",
    );
  });

  it("deletions leave R untouched", () => {
    const wt = lines("a\nb\nd\ne");
    const reviewed = markAdds(base, wt, allAdds(base, wt));
    expect(reviewed).toEqual(base);
    expectAddOnly(base, reviewed);
  });

  it("duplicate-heavy fixture never shrinks R", () => {
    const head = lines(
      "$$;\n\n--\n-- Name: A\n--\n\nBODY A\n\n--\n-- Name: B\n--\n\nBODY B",
    );
    const wt = lines("$$;\n\n--\n-- Name: B\n--\n\nBODY B\nNEW");
    const reviewed = markAdds(head, wt, allAdds(head, wt));
    expect(reviewed.length).toBeGreaterThanOrEqual(head.length);
    expectAddOnly(head, reviewed);
    expect(render(head, reviewed, wt)).toBe("+8:seen");
  });

  it("partial selection", () => {
    const wt = lines("a\nP\nb\nc\nd\ne\nQ");
    expect(render(base, markAdds(base, wt, wl(7)), wt)).toBe(
      "+2:unseen +7:seen",
    );
  });

  it("mark is idempotent and unmark inverts it", () => {
    const wt = lines("a\nP\nc\nd\ne\nQ");
    const sel = allAdds(base, wt);
    const r1 = markAdds(base, wt, sel);
    expect(markAdds(r1, wt, sel)).toEqual(r1);
    expectAddOnly(base, r1);
    const undone = unmarkAdds(base, r1, wt, sel);
    expect(undone).toEqual(base);
    expect(render(base, undone, wt)).toBe(render(base, base, wt));
    const p1 = markAdds(base, wt, wl(2));
    expect(markAdds(p1, wt, wl(2))).toEqual(p1);
    expect(unmarkAdds(base, p1, wt, wl(2))).toEqual(base);
  });

  it("empty files at either endpoint", () => {
    const wt = lines("a\nb");
    const reviewed = markAdds([], wt, allAdds([], wt));
    expect(reviewed).toEqual(wt);
    expect(render([], reviewed, wt)).toBe("+1:seen +2:seen");
    expect(markAdds(base, [], allAdds(base, []))).toEqual(base);
  });
});

describe("align (Myers)", () => {
  function lcs(a: string[], b: string[]): number {
    const dp = Array.from({ length: a.length + 1 }, () =>
      new Array<number>(b.length + 1).fill(0),
    );
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        dp[i]![j] =
          a[i - 1] === b[j - 1]
            ? dp[i - 1]![j - 1]! + 1
            : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    return dp[a.length]![b.length]!;
  }

  it("reconstructs both sides with a minimal script", () => {
    let seed = 7;
    const rnd = (k: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % k;
    };
    for (let t = 0; t < 300; t++) {
      const a = Array.from({ length: rnd(12) }, () => "abc"[rnd(3)]!);
      const b = Array.from({ length: rnd(12) }, () => "abc"[rnd(3)]!);
      const ops = align(a, b);
      expect(ops.flatMap((o) => (o.kind === "add" ? [] : [o.text]))).toEqual(a);
      expect(ops.flatMap((o) => (o.kind === "del" ? [] : [o.text]))).toEqual(b);
      expect(ops.filter((o) => o.kind === "context").length).toBe(lcs(a, b));
    }
  });
});

describe("linediff cap", () => {
  it("falls back to del-then-add for wholesale rewrites quickly", async () => {
    const { alignLines } = await import("./linediff.ts");
    const a = Array.from({ length: 20000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 20000 }, (_, i) => `b${i}`);
    const t = Date.now();
    const ops = alignLines(a, b);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(ops.filter((o) => o.kind === "del").length).toBe(20000);
    expect(ops[20000]?.kind).toBe("add");
  });
});
