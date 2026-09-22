import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, load } from "./ignore.ts";
import type { RepoPath } from "./types.ts";

function check(text: string, cases: Record<string, boolean>) {
  const m = compile(text)!;
  for (const [path, want] of Object.entries(cases)) {
    expect([path, m.match(path as RepoPath)]).toEqual([path, want]);
  }
}

describe("ignore", () => {
  it("bare name matches at any depth", () =>
    check("*.pb.go\n", {
      "api.pb.go": true,
      "src/gen/api.pb.go": true,
      "src/api.go": false,
    }));
  it("interior slash anchors at the root", () =>
    check("gen/*.ts\n", { "gen/api.ts": true, "src/gen/api.ts": false }));
  it("leading slash anchors too", () =>
    check("/dist\n", { dist: true, "dist/app.js": true, "sub/dist": false }));
  it("directory-only rule ignores the subtree", () =>
    check("build/\n", {
      "build/out.js": true,
      "src/build/out.js": true,
      build: false,
    }));
  it("last matching rule wins", () =>
    check("*.lock\n!Cargo.lock\n", { "yarn.lock": true, "Cargo.lock": false }));
  it("an ignored directory cannot be re-included", () =>
    check("gen/\n!gen/keep.ts\n", { "gen/keep.ts": true }));
  it("double star spans directories", () =>
    check("src/**/snap/*.json\n", {
      "src/snap/a.json": true,
      "src/a/b/snap/a.json": true,
      "other/snap/a.json": false,
    }));
  it("trailing double star matches the subtree", () =>
    check("vendor/**\n", { "vendor/a/b.go": true, vendor: false }));
  it("single star does not cross a slash", () =>
    check("gen/*.go\n", { "gen/a.go": true, "gen/sub/a.go": false }));
  it("comments and blanks are not rules", () =>
    check("# *.go\n\n*.js\n", { "a.go": false, "a.js": true }));
  it("character classes and ?", () =>
    check("snap?/[ab].txt\n", { "snap1/a.txt": true, "snap1/c.txt": false }));
  it("dots are literal", () => check("a.b\n", { "a.b": true, axb: false }));
  it("ruleless text compiles to undefined", () =>
    expect(compile("\n# only a comment\n")).toBeUndefined());
  it("load reads the file, undefined when absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "glean-ignore-"));
    expect(await load(dir)).toBeUndefined();
    await writeFile(join(dir, ".gleanignore"), "*.gen\n");
    expect((await load(dir))!.match("x.gen" as RepoPath)).toBe(true);
  });
});
