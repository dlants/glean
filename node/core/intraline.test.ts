import { describe, expect, it } from "vitest";
import {
  align,
  buildPairs,
  pairLines,
  refine,
  type Segment,
  type Token,
  tokenize,
} from "./intraline.ts";

const toks = (t: Token[]) =>
  t.map((x) => `${x.text}@${x.col}+${x.len}`).join("|");
const segs = (s: readonly Segment[]) =>
  s.map((x) => `${x.startCol}:${x.endCol}`).join("|");
const pairsStr = (p: { di: number; ai: number }[]) =>
  p.map((x) => `${x.di + 1}-${x.ai + 1}`).join("|");

describe("tokenize", () => {
  it("coalesces word runs; punctuation and space are single tokens", () => {
    expect(toks(tokenize("foo_bar(x) = 1"))).toBe(
      "foo_bar@0+7|(@7+1|x@8+1|)@9+1| @10+1|=@11+1| @12+1|1@13+1",
    );
  });
  it("empty", () => expect(tokenize("")).toEqual([]));
  it("alnum run", () =>
    expect(tokenize("abc123")).toEqual([{ text: "abc123", col: 0, len: 6 }]));
  it("punctuation", () =>
    expect(toks(tokenize("->;"))).toBe("-@0+1|>@1+1|;@2+1"));
  it("multibyte code points use byte offsets", () =>
    expect(toks(tokenize("é=a"))).toBe("é@0+2|=@2+1|a@3+1"));
});

describe("align", () => {
  it("one-token substitution", () => {
    const r = align("value = 1", "value = 2")!;
    expect(segs(r.aSegs)).toBe("8:9");
    expect(segs(r.bSegs)).toBe("8:9");
  });
  it("insertion is one contiguous segment", () => {
    const r = align("f(x)", "f(x, y)")!;
    expect(segs(r.aSegs)).toBe("");
    expect(segs(r.bSegs)).toBe("3:6");
  });
  it("dissimilar lines terminate", () =>
    expect(align("import os", "return None")).toBeUndefined());
  it("identical lines have no segments", () =>
    expect(align("same line", "same line")).toEqual({ aSegs: [], bSegs: [] }));
});

describe("pairLines", () => {
  it("similar lines pair in order", () => {
    const r = pairLines(
      ["value = 1", "name = foo", "flag = true"],
      ["value = 2", "name = bar", "flag = false"],
    );
    expect(pairsStr(r.pairs)).toBe("1-1|2-2|3-3");
    expect(r.delUnpaired).toEqual([]);
    expect(r.addUnpaired).toEqual([]);
  });
  it("a buried change pairs with its true match", () => {
    const r = pairLines(
      ["total = count + 1"],
      ["import os", "total = count + 2", "return None"],
    );
    expect(pairsStr(r.pairs)).toBe("1-2");
    expect(r.delUnpaired).toEqual([]);
    expect(r.addUnpaired).toEqual([0, 2]);
  });
  it("never crosses", () => {
    const r = pairLines(["alpha = 1", "beta = 2"], ["beta = 3", "alpha = 4"]);
    expect(r.pairs.length).toBeLessThanOrEqual(1);
  });
  it("dissimilar runs stay unpaired", () => {
    const r = pairLines(["import os"], ["return None"]);
    expect(r).toEqual({ pairs: [], delUnpaired: [0], addUnpaired: [0] });
  });
  it("empty", () =>
    expect(pairLines([], [])).toEqual({
      pairs: [],
      delUnpaired: [],
      addUnpaired: [],
    }));
});

describe("buildPairs", () => {
  it("carries rows and texts, drops surplus", () => {
    expect(
      buildPairs(
        [
          { row: 10, text: "value = 1" },
          { row: 12, text: "extra" },
        ],
        [{ row: 20, text: "value = 2" }],
      ),
    ).toEqual([
      { delRow: 10, addRow: 20, delText: "value = 1", addText: "value = 2" },
    ]);
  });
  it("no adds, no work", () =>
    expect(buildPairs([{ row: 1, text: "a" }], [])).toEqual([]));

  it("a changed line among insertions pairs with its match", () => {
    const work = buildPairs(
      [{ row: 4, text: "      emit(marker .. dl.text," }],
      [
        { row: 3, text: "    local dels, adds = {}, {}" },
        { row: 6, text: "      local row = emit(marker .. dl.text," },
        { row: 7, text: '      if dl.kind == "del" then' },
        {
          row: 8,
          text: "        dels[#dels + 1] = { row = row, text = dl.text }",
        },
        { row: 9, text: '      elseif dl.kind == "add" then' },
        {
          row: 10,
          text: "        adds[#adds + 1] = { row = row, text = dl.text }",
        },
        {
          row: 13,
          text: "    for _, w in ipairs(intraline.build_pairs(dels, adds)) do",
        },
        { row: 14, text: "      intra_work[#intra_work + 1] = w" },
      ],
    );
    expect(work.length).toBe(1);
    expect(work[0]!.addText).toBe("      local row = emit(marker .. dl.text,");
    const r = align(work[0]!.delText, work[0]!.addText)!;
    expect(segs(r.aSegs)).toBe("");
    expect(segs(r.bSegs)).toBe("5:17");
  });
});

// Mirrors the renderer: unpaired → full-line, paired with spans → emph, paired
// without spans → plain text.
function decisions(count: number, byIndex: Map<number, Segment[]>): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const s = byIndex.get(i);
    out.push(
      `${i + 1}: ${s === undefined ? "full" : s.length > 0 ? `emph ${segs(s)}` : "text"}`,
    );
  }
  return out.join("\n");
}

describe("refine", () => {
  it("planCandidates refactor hunk", () => {
    const dels = [
      "  const planParamAbs = path.isAbsolute(params.plan)",
      "    ? params.plan",
      "    : path.join(params.repo, params.plan);",
      "  if (!existsSync(planParamAbs)) {",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: diff line text
      "    throw new Error(`Plan file not found: ${planParamAbs}`);",
    ];
    const adds = [
      "  const planCandidates = path.isAbsolute(params.plan)",
      '    ? [params.plan, path.join(params.repo, params.plan.replace(/^\\/+/, ""))]',
      "    : [path.join(params.repo, params.plan), params.plan];",
      "  const planParamAbs = planCandidates.find((p) => existsSync(p));",
      "  if (!planParamAbs) {",
      "    throw new Error(",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: diff line text
      '      `Plan file not found. Tried: ${planCandidates.join(", ")}`,',
      "    );",
      "  }",
    ];
    const refined = refine(dels, adds);
    expect(pairsStr(refined)).toBe("1-1|3-3|4-5");
    const d = new Map(refined.map((r) => [r.di, r.aSegs]));
    const a = new Map(refined.map((r) => [r.ai, r.bSegs]));
    expect(decisions(dels.length, d)).toBe(
      [
        "1: emph 8:20",
        "2: full",
        "3: text",
        "4: emph 7:18|30:31",
        "5: full",
      ].join("\n"),
    );
    expect(decisions(adds.length, a)).toBe(
      [
        "1: emph 8:22",
        "2: full",
        "3: emph 6:7|42:56",
        "4: full",
        "5: text",
        "6: full",
        "7: full",
        "8: full",
        "9: full",
      ].join("\n"),
    );
  });

  it("a 2000×2000 block of long lines is bounded and still pairs", () => {
    const dels: string[] = [];
    const adds: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const body = `const value_${i} = compute(alpha_${i}, beta_${i}, gamma, delta, "${"x".repeat(40)}");`;
      dels.push(body);
      adds.push(body.replace("compute", "recompute"));
    }
    const start = performance.now();
    const refined = refine(dels, adds);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
    expect(refined.length).toBe(2000);
    expect(refined.every((r) => r.di === r.ai)).toBe(true);
  });

  it("a 2000×2000 block of unrelated long lines is bounded", () => {
    const line = (i: number, tag: string) =>
      Array.from({ length: 30 }, (_, k) => `${tag}${(i * 31 + k) % 97}`).join(
        " ",
      );
    const dels = Array.from({ length: 2000 }, (_, i) => line(i, "a"));
    const adds = Array.from({ length: 2000 }, (_, i) => line(i, "b"));
    const start = performance.now();
    refine(dels, adds);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("a huge single line pair is capped", () => {
    const a = Array.from({ length: 5000 }, (_, i) => `t${i}`).join(" ");
    const start = performance.now();
    expect(align(a, `${a} x`)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(50);
  });
});
