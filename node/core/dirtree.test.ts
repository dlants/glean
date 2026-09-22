import { describe, expect, it } from "vitest";
import { dirLayout } from "./dirtree.ts";

describe("dirLayout", () => {
  it("preorder shape", () => {
    const l = dirLayout(["top.txt", "a/one.txt", "a/b/two.txt", "c/three.txt"]);
    expect(l.map((n) => `${n.kind}:${n.depth}:${n.name}`).join(" ")).toBe(
      "file:0:top.txt dir:0:a file:1:one.txt file:1:b/two.txt file:0:c/three.txt",
    );
    expect(l[1]).toMatchObject({ kind: "dir", prefix: "a", files: [1, 2] });
  });

  it("collapses single-child chains", () => {
    const l = dirLayout(["a/b/c/one.txt", "a/b/c/two.txt"]);
    expect(l.length).toBe(3);
    expect(l[0]).toMatchObject({
      name: "a/b/c",
      prefix: "a/b/c",
      files: [0, 1],
    });
    expect(l[1]!.depth).toBe(1);
    expect(dirLayout(["a/b/c/one.txt"])).toEqual([
      { kind: "file", depth: 0, index: 0, name: "a/b/c/one.txt" },
    ]);
    expect(
      dirLayout(["a/b/one.txt", "a/x/two.txt"])
        .map((n) => `${n.kind}:${n.name}`)
        .join(" "),
    ).toBe("dir:a file:b/one.txt file:x/two.txt");
  });

  it("unsorted input reopens a directory", () => {
    const l = dirLayout([
      "a/one.txt",
      "a/two.txt",
      "z/x.txt",
      "z/y.txt",
      "a/three.txt",
      "a/four.txt",
    ]);
    expect(l.filter((n) => n.kind === "dir").length).toBe(3);
  });
});
