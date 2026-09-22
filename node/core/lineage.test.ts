import { describe, expect, it } from "vitest";
import { makeRepo, type TestRepo } from "../test/repo.ts";
import { type DiffLine, type FileEntry, parse } from "./diff.ts";
import {
  apply,
  baseState,
  compose,
  expand,
  type Origin,
  type Patch,
  type PathLineage,
  type PathState,
  type Segment,
  splice,
} from "./lineage.ts";
import { type Layer, type RepoPath, type Sha, WORKTREE } from "./types.ts";

const show = (os: readonly Origin[]) =>
  os
    .map((o) => (o.kind === "base" ? `b${o.base}` : `${o.sha}:${o.lnum}`))
    .join(" ");
const seg = (sha: string, lnum: number, n: number): Segment => ({
  kind: "commit",
  sha: sha as Sha,
  lnum,
  n,
});
const base5 = (): Segment[] => [
  { kind: "base", base: 1, n: 5 },
  { kind: "base", base: 6, n: "open" },
];
const P = (p: string) => p as RepoPath;
const S = (s: string) => s as Sha;
const fresh = (): PathState => ({ segs: base5(), delAttr: new Map() });

describe("line arithmetic", () => {
  const cases: [string, number, number, Segment | undefined, number, string][] =
    [
      ["replace in middle", 3, 2, seg("x", 10, 2), 6, "b1 b2 x:10 x:11 b5 b6"],
      [
        "wider replacement",
        3,
        2,
        seg("x", 1, 5),
        9,
        "b1 b2 x:1 x:2 x:3 x:4 x:5 b5 b6",
      ],
      ["narrower replacement", 2, 5, seg("x", 1, 2), 5, "b1 x:1 x:2 b7 b8"],
      ["prepend", 1, 0, seg("x", 1, 1), 4, "x:1 b1 b2 b3"],
      ["insert in middle", 4, 0, seg("x", 4, 1), 6, "b1 b2 b3 x:4 b4 b5"],
      [
        "insert into open tail",
        8,
        0,
        seg("x", 8, 1),
        9,
        "b1 b2 b3 b4 b5 b6 b7 x:8 b8",
      ],
    ];
  it.each(cases)("%s", (_, at, rm, s, n, want) => {
    expect(show(expand(splice(base5(), at, rm, s).segs, n))).toBe(want);
  });

  it("delete-only closes the gap", () => {
    const { segs } = splice(base5(), 2, 2, undefined);
    expect(show(expand(segs, 4))).toBe("b1 b4 b5 b6");
    expect(segs.length).toBe(3);
  });

  it("splice covering a whole segment removes it", () => {
    const { segs } = splice(
      [
        { kind: "base", base: 1, n: 2 },
        seg("x", 1, 3),
        { kind: "base", base: 3, n: "open" },
      ],
      3,
      3,
      undefined,
    );
    expect(segs.length).toBe(2);
    expect(show(expand(segs, 4))).toBe("b1 b2 b3 b4");
  });

  it("multi-segment splice", () => {
    const { segs, displaced } = splice(
      [
        { kind: "base", base: 1, n: 2 },
        seg("x", 1, 2),
        seg("y", 5, 2),
        { kind: "base", base: 3, n: "open" },
      ],
      2,
      5,
      seg("z", 1, 1),
    );
    expect(show(expand(segs, 4))).toBe("b1 z:1 b3 b4");
    expect(show(displaced)).toBe("b2 x:1 x:2 y:5 y:6");
  });

  it("two hunks use pre-image coordinates", () => {
    const file: FileEntry = {
      path: P("f"),
      oldPath: P("f"),
      kind: "modify",
      hunks: [
        {
          oldStart: 2,
          oldCount: 1,
          newStart: 2,
          newCount: 3,
          header: "",
          lines: [
            { kind: "del", text: "b", oldLnum: 2, newLnum: 2 },
            { kind: "add", text: "B1", newLnum: 2 },
            { kind: "add", text: "B2", newLnum: 3 },
            { kind: "add", text: "B3", newLnum: 4 },
          ],
        },
        {
          oldStart: 4,
          oldCount: 1,
          newStart: 6,
          newCount: 1,
          header: "",
          lines: [
            { kind: "del", text: "d", oldLnum: 4, newLnum: 6 },
            { kind: "add", text: "D", newLnum: 6 },
          ],
        },
      ],
    };
    const st = apply(fresh(), S("c1"), file);
    expect(show(expand(st.segs, 7))).toBe("b1 c1:2 c1:3 c1:4 b3 c1:6 b5");
  });

  it("segment count is O(splices)", () => {
    let segs = base5();
    for (let i = 1; i <= 50; i++)
      segs = splice(segs, i, 0, seg("x", i, 1)).segs;
    expect(segs.length).toBeLessThanOrEqual(102);
  });

  it("the open tail stays open after a splice", () => {
    const { segs } = splice(baseState(), 5, 1, seg("c1", 5, 2));
    expect(segs.at(-1)).toEqual({ kind: "base", base: 6, n: "open" });
  });
});

type EntryOpts = {
  at: number;
  dels?: number;
  adds?: number;
  newLnum?: number;
  kind?: FileEntry["kind"];
  oldPath?: string;
};
function entry(path: string, o: EntryOpts): FileEntry {
  const dels = o.dels ?? 0;
  const adds = o.adds ?? 0;
  const lines: DiffLine[] = [];
  for (let i = 0; i < dels; i++)
    lines.push({
      kind: "del",
      text: "-",
      oldLnum: o.at + i,
      newLnum: o.newLnum ?? 1,
    });
  for (let i = 0; i < adds; i++)
    lines.push({ kind: "add", text: "+", newLnum: (o.newLnum ?? 1) + i });
  return {
    path: P(path),
    oldPath: P(o.oldPath ?? path),
    kind: o.kind ?? "modify",
    hunks: [
      {
        oldStart: dels > 0 ? o.at : o.at - 1,
        oldCount: dels,
        newStart: o.newLnum ?? 1,
        newCount: adds,
        header: "",
        lines,
      },
    ],
  };
}

describe("attribution", () => {
  it("add owns its position", () => {
    const st = apply(
      fresh(),
      S("c1"),
      entry("f", { at: 3, adds: 1, newLnum: 3 }),
    );
    expect(show(expand(st.segs, 5))).toBe("b1 b2 c1:3 b3 b4");
  });

  it("lnum is the commit's own number, not the position", () => {
    const st = fresh();
    apply(st, S("c1"), entry("f", { at: 3, adds: 1, newLnum: 3 }));
    apply(st, S("c2"), entry("f", { at: 1, adds: 2, newLnum: 1 }));
    expect(show(expand(st.segs, 6))).toBe("c2:1 c2:2 b1 b2 c1:3 b3");
  });

  it("del keyed by base lnum with the deleter's pre-image lnum", () => {
    const st = fresh();
    apply(st, S("c1"), entry("f", { at: 1, adds: 2, newLnum: 1 }));
    apply(st, S("c2"), entry("f", { at: 5, dels: 1 }));
    expect(st.delAttr.get(3)).toEqual({ sha: "c2", lnum: 5 });
    expect(st.delAttr.get(5)).toBeUndefined();
  });

  it("transient line leaves no trace", () => {
    const st = fresh();
    apply(st, S("c1"), entry("f", { at: 3, adds: 1, newLnum: 3 }));
    apply(st, S("c2"), entry("f", { at: 3, dels: 1 }));
    expect(st.delAttr.size).toBe(0);
    expect(show(expand(st.segs, 5))).toBe("b1 b2 b3 b4 b5");
  });

  it("last writer wins; base survivors named by the base map", () => {
    const f = compose([
      {
        sha: S("c1"),
        files: [entry("f", { at: 3, dels: 1, adds: 1, newLnum: 3 })],
      },
      {
        sha: S("c2"),
        files: [entry("f", { at: 3, dels: 1, adds: 1, newLnum: 3 })],
      },
    ]).get(P("f"))!;
    expect(f.prov.get(3)).toEqual({ sha: "c2", lnum: 3 });
    expect(f.prov.get(1)).toBeUndefined();
    expect(f.base(1)).toBe(1);
    expect(f.base(3)).toBeUndefined();
    expect(f.base(9000)).toBe(9000);
  });

  it("rename carries origins to the new path", () => {
    const out = compose([
      { sha: S("c1"), files: [entry("f", { at: 1, adds: 1, newLnum: 1 })] },
      {
        sha: S("c2"),
        files: [
          entry("g", {
            at: 3,
            dels: 1,
            adds: 1,
            newLnum: 3,
            kind: "rename",
            oldPath: "f",
          }),
        ],
      },
    ]);
    expect(out.get(P("g"))!.prov.get(1)!.sha).toBe("c1");
    expect(out.get(P("f"))).toBeUndefined();
    expect(out.get(P("g"))!.prov.get(3)!.sha).toBe("c2");
  });

  it("delete then re-add", () => {
    const f = compose([
      { sha: S("c1"), files: [entry("f", { at: 1, dels: 5, kind: "delete" })] },
      {
        sha: S("c2"),
        files: [entry("f", { at: 1, adds: 2, newLnum: 1, kind: "add" })],
      },
    ]).get(P("f"))!;
    expect(f.delAttr.get(4)!.sha).toBe("c1");
    expect(f.prov.get(1)!.sha).toBe("c2");
    expect(f.prov.get(3)).toBeUndefined();
  });

  it("the work-tree layer is an ordinary layer", () => {
    const f = compose([
      { sha: WORKTREE, files: [entry("f", { at: 2, adds: 1, newLnum: 2 })] },
    ]).get(P("f"))!;
    expect(f.prov.get(2)!.sha).toBe(WORKTREE);
    expect(f.base(3)).toBe(2);
  });
});

// ------------------------------------------------------------ real histories

function logPatches(repo: TestRepo, base: string, target: string): Patch[] {
  const out = repo.run([
    "log",
    "--first-parent",
    "--reverse",
    "-p",
    "-U0",
    "-M",
    "--no-color",
    "--format=%x00%H",
    `${base}..${target}`,
  ]);
  return out
    .split("\0")
    .slice(1)
    .map((chunk) => {
      const m = /^([0-9a-f]+)\n?([\s\S]*)$/.exec(chunk)!;
      return { sha: S(m[1]!), files: parse(m[2] ?? "") };
    });
}

function blobLine(repo: TestRepo, rev: string, path: string, lnum: number) {
  try {
    return repo.run(["show", `${rev}:${path}`]).split("\n")[lnum - 1];
  } catch {
    return undefined;
  }
}

const empty: PathLineage = {
  prov: new Map(),
  base: () => undefined,
  delAttr: new Map(),
};

/** Every coordinate claimed must hold the claimed text in its blob. */
function check(repo: TestRepo, base: string, target: string) {
  const composed = compose(logPatches(repo, base, target));
  const net = parse(repo.run(["diff", "-M", "--no-color", base, target]));
  const bad: string[] = [];
  for (const file of net) {
    const maps = composed.get(file.path) ?? empty;
    for (const hunk of file.hunks) {
      for (const dl of hunk.lines) {
        if (dl.kind === "add") {
          const o = maps.prov.get(dl.newLnum);
          if (!o) {
            bad.push(`no prov for ${file.path}:${dl.newLnum}`);
            continue;
          }
          const got =
            blobLine(repo, o.sha, file.path, o.lnum) ??
            blobLine(repo, o.sha, file.oldPath, o.lnum);
          if (got !== dl.text)
            bad.push(`prov ${file.path}:${dl.newLnum} is ${got}`);
        } else if (dl.kind === "del") {
          const o = maps.delAttr.get(dl.oldLnum);
          if (!o) {
            bad.push(`no delAttr for ${file.path}:${dl.oldLnum}`);
            continue;
          }
          const got =
            blobLine(repo, `${o.sha}^`, file.oldPath, o.lnum) ??
            blobLine(repo, `${o.sha}^`, file.path, o.lnum);
          if (got !== dl.text)
            bad.push(`delAttr ${file.path}:${dl.oldLnum} is ${got}`);
          if (blobLine(repo, base, file.oldPath, dl.oldLnum) !== dl.text)
            bad.push(`base ${file.oldPath}:${dl.oldLnum}`);
        }
      }
    }
  }
  expect(bad).toEqual([]);
  return (p: string) => composed.get(P(p));
}

const BASE = "one\ntwo\nthree\nfour\nfive\n";

describe("real histories", () => {
  it("single edit", () => {
    const r = makeRepo([
      { files: { "f.txt": BASE } },
      { files: { "f.txt": "one\ntwo\nTHREE\nfour\nfive\n" } },
    ]);
    const c = check(r, r.shas[0]!, r.shas[1]!);
    expect(c("f.txt")!.prov.get(3)).toEqual({ sha: r.shas[1], lnum: 3 });
  });

  it("shifted by a later insert", () => {
    const r = makeRepo([
      { files: { "f.txt": BASE } },
      { files: { "f.txt": "one\ntwo\nTHREE\nfour\nfive\n" } },
      { files: { "f.txt": "a\nb\none\ntwo\nTHREE\nfour\nfive\n" } },
    ]);
    const c = check(r, r.shas[0]!, r.shas[2]!);
    expect(c("f.txt")!.prov.get(5)).toEqual({ sha: r.shas[1], lnum: 3 });
  });

  it("shifted by an earlier insert", () => {
    const r = makeRepo([
      { files: { "f.txt": BASE } },
      { files: { "f.txt": "a\nb\none\ntwo\nthree\nfour\nfive\n" } },
      { files: { "f.txt": "a\nb\none\ntwo\nTHREE\nfour\nfive\n" } },
    ]);
    const c = check(r, r.shas[0]!, r.shas[2]!);
    expect(c("f.txt")!.prov.get(5)).toEqual({ sha: r.shas[2], lnum: 5 });
  });

  it("deletion attribution", () => {
    const r = makeRepo([
      { files: { "f.txt": BASE } },
      { files: { "f.txt": "a\nb\none\ntwo\nthree\nfour\nfive\n" } },
      { files: { "f.txt": "a\nb\none\ntwo\nfour\nfive\n" } },
    ]);
    const c = check(r, r.shas[0]!, r.shas[2]!);
    expect(c("f.txt")!.delAttr.get(3)).toEqual({ sha: r.shas[2], lnum: 5 });
  });

  it("transient line", () => {
    const r = makeRepo([
      { files: { "f.txt": BASE } },
      { files: { "f.txt": "one\ntwo\ntransient\nthree\nfour\nfive\n" } },
      { files: { "f.txt": BASE } },
    ]);
    const c = check(r, r.shas[0]!, r.shas[2]!);
    expect(c("f.txt")!.prov.size).toBe(0);
    expect(c("f.txt")!.delAttr.size).toBe(0);
  });

  it("rewritten twice", () => {
    const r = makeRepo([
      { files: { "f.txt": BASE } },
      { files: { "f.txt": "one\ntwo\nTHREE\nfour\nfive\n" } },
      { files: { "f.txt": "one\ntwo\nTHREE\nfour\nFIVE\n" } },
      { files: { "f.txt": "one\ntwo\nthird\nfour\nFIVE\n" } },
    ]);
    expect(check(r, r.shas[0]!, r.shas[3]!)("f.txt")!.prov.get(3)!.sha).toBe(
      r.shas[3],
    );
  });

  it("pure prepend", () => {
    const r = makeRepo([
      { files: { "f.txt": BASE } },
      { files: { "f.txt": `zero\n${BASE}` } },
    ]);
    const f = check(r, r.shas[0]!, r.shas[1]!)("f.txt")!;
    expect(f.prov.get(1)!.lnum).toBe(1);
    expect(f.prov.get(2)).toBeUndefined();
  });

  it("pure append", () => {
    const r = makeRepo([
      { files: { "f.txt": BASE } },
      { files: { "f.txt": `${BASE}six\n` } },
    ]);
    expect(check(r, r.shas[0]!, r.shas[1]!)("f.txt")!.prov.get(6)!.lnum).toBe(
      6,
    );
  });

  it("adjacent hunks", () => {
    const r = makeRepo([
      { files: { "f.txt": BASE } },
      { files: { "f.txt": "one\nTWO\nTHREE\nX\nfour\nfive\n" } },
    ]);
    check(r, r.shas[0]!, r.shas[1]!);
  });

  it("rename", () => {
    const r = makeRepo([
      { files: { "f.txt": BASE } },
      { files: { "f.txt": "one\nTWO\nthree\nfour\nfive\n" } },
      {
        rename: { "f.txt": "g.txt" },
        files: { "g.txt": "one\nTWO\nthree\nFOUR\nfive\n" },
      },
    ]);
    const c = check(r, r.shas[0]!, r.shas[2]!);
    expect(c("g.txt")!.prov.get(2)!.sha).toBe(r.shas[1]);
    expect(c("f.txt")).toBeUndefined();
    expect(c("g.txt")!.prov.get(4)!.sha).toBe(r.shas[2]);
  });

  it("rename with no content change", () => {
    const r = makeRepo([
      { files: { "f.txt": BASE } },
      { files: { "f.txt": "one\nTWO\nthree\nfour\nfive\n" } },
      { rename: { "f.txt": "g.txt" } },
    ]);
    expect(check(r, r.shas[0]!, r.shas[2]!)("g.txt")!.prov.get(2)!.sha).toBe(
      r.shas[1],
    );
  });

  it("delete then re-add", () => {
    const r = makeRepo([
      { files: { "f.txt": BASE, "k.txt": "k\n" } },
      { delete: ["f.txt"] },
      { files: { "f.txt": "alpha\nbeta\n" } },
    ]);
    const f = check(r, r.shas[0]!, r.shas[2]!)("f.txt")!;
    expect(f.delAttr.get(2)!.sha).toBe(r.shas[1]);
    expect(f.prov.get(1)!.sha).toBe(r.shas[2]);
    expect(f.prov.get(3)).toBeUndefined();
  });

  it("new file", () => {
    const r = makeRepo([
      { files: { "f.txt": BASE } },
      { files: { "n.txt": "a\nb\nc\n" } },
    ]);
    expect(check(r, r.shas[0]!, r.shas[1]!)("n.txt")!.prov.get(3)!.sha).toBe(
      r.shas[1],
    );
  });

  it("empty commit", () => {
    const r = makeRepo([
      { files: { "f.txt": BASE } },
      { empty: true },
      { files: { "f.txt": "one\ntwo\nTHREE\nfour\nfive\n" } },
    ]);
    expect(check(r, r.shas[0]!, r.shas[2]!)("f.txt")!.prov.get(3)!.sha).toBe(
      r.shas[2],
    );
  });

  it("merge", () => {
    const r = makeRepo([
      { files: { "f.txt": BASE } },
      { files: { "f.txt": "ONE\ntwo\nthree\nfour\nfive\n" } },
      { branch: "side", files: { "s.txt": "s1\ns2\n" } },
      { merge: "side" },
    ]);
    const s = check(r, r.shas[0]!, r.shas[3]!)("s.txt")!;
    expect(s.prov.get(1)!.sha).toBe(r.shas[3]);
  });

  function randHistory(seed: number) {
    let x = seed;
    const rnd = (k: number) => {
      x = (x * 1103515245 + 12345) % 2 ** 31;
      return 1 + (x % k);
    };
    const paths = ["a.txt", "b.txt"];
    const content: Record<string, string[]> = {};
    for (const p of paths)
      content[p] = Array.from({ length: 12 }, (_, i) => `${p}-${i + 1}`);
    const snapshot = () =>
      Object.fromEntries(
        paths.map((p) => [
          p,
          content[p]!.length > 0 ? `${content[p]!.join("\n")}\n` : "\n",
        ]),
      );
    const spec = [{ files: snapshot() }];
    let counter = 0;
    for (let c = 0; c < 6; c++) {
      const lines = content[paths[rnd(2) - 1]!]!;
      for (let k = rnd(3); k > 0; k--) {
        const op = rnd(3);
        const at = rnd(Math.max(1, lines.length)) - 1;
        if (op === 1 && lines.length > 1) lines.splice(at, 1);
        else if (op === 2) lines.splice(at, 0, `new-${++counter}`);
        else lines[at] = `mod-${++counter}`;
      }
      spec.push({ files: snapshot(), empty: true } as never);
    }
    return spec;
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("randomized history seed %i", (seed) => {
    const r = makeRepo(randHistory(seed));
    check(r, r.shas[0]!, r.shas.at(-1)!);
  });
});

// ------------------------------------------------- blame-oracle equivalence
// Blame is the independent authority on *which* commit; the content check only
// proves coordinates are real. Merge-free ranges only.

type Want = { sha: Layer; lnum: number };

function parseBlame(text: string): Map<number, { sha: string; orig: number }> {
  const map = new Map<number, { sha: string; orig: number }>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{7,}) (\d+) (\d+)/.exec(line);
    if (m) map.set(Number(m[3]), { sha: m[1]!, orig: Number(m[2]) });
  }
  return map;
}

function oracle(
  repo: TestRepo,
  base: string,
  target: string,
  expected: Record<
    string,
    { add?: Record<number, Want>; del?: Record<number, Want> }
  > = {},
) {
  const patches = logPatches(repo, base, target);
  const composed = compose(patches);
  const net = parse(repo.run(["diff", "-M", "--no-color", base, target]));
  const child = new Map<string, Layer>();
  let prev = repo.run(["rev-parse", base]);
  for (const p of patches) {
    child.set(prev, p.sha);
    prev = p.sha;
  }
  const bad: string[] = [];
  const fmt = (o: Want | undefined) =>
    o ? `${o.sha.slice(0, 7)}:${o.lnum}` : "none";
  for (const file of net) {
    const maps = composed.get(file.path) ?? empty;
    const exp = expected[file.path] ?? {};
    let blame: ReturnType<typeof parseBlame> | undefined;
    let rev: Map<number, Want> | undefined;
    for (const hunk of file.hunks) {
      for (const dl of hunk.lines) {
        if (dl.kind === "add") {
          const got = maps.prov.get(dl.newLnum);
          let want = exp.add?.[dl.newLnum];
          if (!want) {
            blame ??= parseBlame(
              repo.run(["blame", "-p", target, "--", file.path]),
            );
            const b = blame.get(dl.newLnum);
            want = b && { sha: S(b.sha), lnum: b.orig };
          }
          if (got?.sha !== want?.sha || got?.lnum !== want?.lnum)
            bad.push(
              `add ${file.path}:${dl.newLnum} ${fmt(got)} vs ${fmt(want)}`,
            );
        } else if (dl.kind === "del") {
          const got = maps.delAttr.get(dl.oldLnum);
          let want = exp.del?.[dl.oldLnum];
          if (!want) {
            if (!rev) {
              rev = new Map();
              const text = repo.run([
                "blame",
                "-p",
                "--reverse",
                `${base}..${target}`,
                "--",
                file.oldPath,
              ]);
              for (const [final, p] of parseBlame(text)) {
                const deleter = child.get(p.sha);
                if (deleter) rev.set(final, { sha: deleter, lnum: p.orig });
              }
            }
            want = rev.get(dl.oldLnum);
          }
          if (got?.sha !== want?.sha || got?.lnum !== want?.lnum)
            bad.push(
              `del ${file.oldPath}:${dl.oldLnum} ${fmt(got)} vs ${fmt(want)}`,
            );
        }
      }
    }
  }
  expect(bad).toEqual([]);
}

describe("blame oracle", () => {
  it("linear edits", () => {
    const r = makeRepo([
      { files: { "f.txt": BASE } },
      { files: { "f.txt": "zero\none\ntwo\nTHREE\nfour\nfive\n" } },
      { files: { "f.txt": "zero\none\nTHREE\nfour\nfive\nsix\n" } },
      { files: { "f.txt": "zero\nONE\nTHREE\nfour\nfive\nsix\n" } },
    ]);
    oracle(r, r.shas[0]!, r.shas[3]!);
  });

  it("rename", () => {
    const r = makeRepo([
      { files: { "f.txt": `${BASE}six\nseven\neight\nnine\nten\n` } },
      {
        files: {
          "f.txt":
            "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
        },
      },
      {
        rename: { "f.txt": "g.txt" },
        files: {
          "g.txt": "one\nTWO\nthree\nFOUR\nfive\nsix\nseven\nnine\nten\n",
        },
      },
    ]);
    oracle(r, r.shas[0]!, r.shas[2]!);
  });

  it("delete then re-add", () => {
    const r = makeRepo([
      { files: { "f.txt": BASE, "k.txt": "k\n" } },
      { delete: ["f.txt"] },
      { files: { "f.txt": "alpha\nbeta\n" } },
    ]);
    oracle(r, r.shas[0]!, r.shas[2]!);
  });

  it("additions only", () => {
    const r = makeRepo([
      { files: { "f.txt": BASE } },
      { files: { "f.txt": "one\ntwo\nthree\nfour\nfive\nsix\nseven\n" } },
    ]);
    oracle(r, r.shas[0]!, r.shas[1]!);
  });

  it("moved line is credited to the in-range mover, not blame's origin", () => {
    const r = makeRepo([
      { files: { "f.txt": BASE } },
      { files: { "f.txt": "five\none\ntwo\nthree\nfour\n" } },
    ]);
    const mover = r.shas[1]!;
    oracle(r, r.shas[0]!, mover, {
      "f.txt": {
        add: { 1: { sha: mover, lnum: 1 } },
        del: { 5: { sha: mover, lnum: 5 } },
      },
    });
    expect(check(r, r.shas[0]!, mover)("f.txt")!.prov.get(1)!.sha).toBe(mover);
  });
});
