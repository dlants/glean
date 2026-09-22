import { describe, expect, it } from "vitest";
import { type DiffLine, mapLnum, parse } from "./diff.ts";

const j = (...l: string[]) => l.join("\n");
const oldOf = (l: DiffLine) => (l.kind === "add" ? undefined : l.oldLnum);

describe("diff.parse", () => {
  it("modify: one hunk replacing a line", () => {
    const files = parse(
      j(
        "diff --git a/foo.txt b/foo.txt",
        "index 1111111..2222222 100644",
        "--- a/foo.txt",
        "+++ b/foo.txt",
        "@@ -1,3 +1,3 @@",
        " one",
        "-two",
        "+TWO",
        " three",
      ),
    );
    expect(files.length).toBe(1);
    const f = files[0]!;
    expect(f.path).toBe("foo.txt");
    expect(f.kind).toBe("modify");
    expect(f.hunks.length).toBe(1);
    const lines = f.hunks[0]!.lines;
    expect(lines.length).toBe(4);
    expect(lines[0]).toMatchObject({ kind: "context", newLnum: 1, oldLnum: 1 });
    // A deletion occupies the post-image slot it sat immediately before.
    expect(lines[1]).toMatchObject({ kind: "del", oldLnum: 2, newLnum: 2 });
    expect(lines[2]!.kind).toBe("add");
    expect(lines[2]!.newLnum).toBe(2);
    expect(oldOf(lines[2]!)).toBeUndefined();
    expect(lines[3]!.newLnum).toBe(3);
  });

  it("del run shares one post-image slot", () => {
    const lines = parse(
      j(
        "diff --git a/foo.txt b/foo.txt",
        "--- a/foo.txt",
        "+++ b/foo.txt",
        "@@ -1,4 +1,2 @@",
        " one",
        "-two",
        "-three",
        " four",
      ),
    )[0]!.hunks[0]!.lines;
    expect(lines.slice(1).map((l) => l.newLnum)).toEqual([2, 2, 2]);
  });

  it("added file", () => {
    const files = parse(
      j(
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "index 0000000..3333333",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1,2 @@",
        "+alpha",
        "+beta",
      ),
    );
    expect(files[0]!.kind).toBe("add");
    expect(files[0]!.hunks[0]!.lines.map((l) => l.newLnum)).toEqual([1, 2]);
  });

  it("deleted file", () => {
    const files = parse(
      j(
        "diff --git a/gone.txt b/gone.txt",
        "deleted file mode 100644",
        "index 4444444..0000000",
        "--- a/gone.txt",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-x",
        "-y",
      ),
    );
    expect(files[0]!.kind).toBe("delete");
    expect(files[0]!.path).toBe("gone.txt");
    expect(oldOf(files[0]!.hunks[0]!.lines[0]!)).toBe(1);
  });

  it("multi-hunk, multi-file", () => {
    const files = parse(
      j(
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1,2 +1,2 @@",
        " a1",
        "+a-added",
        "-a2",
        "@@ -10,2 +10,3 @@",
        " a10",
        "+a-added2",
        " a11",
        "diff --git a/b.txt b/b.txt",
        "--- a/b.txt",
        "+++ b/b.txt",
        "@@ -5,1 +5,1 @@",
        "-b5",
        "+B5",
      ),
    );
    expect(files.length).toBe(2);
    expect(files[0]!.hunks.length).toBe(2);
    const hunk2 = files[0]!.hunks[1]!;
    expect(hunk2.newStart).toBe(10);
    expect(hunk2.lines.map((l) => l.newLnum)).toEqual([10, 11, 12]);
    expect(files[1]!.path).toBe("b.txt");
    expect(files[1]!.hunks[0]!.lines[1]!.newLnum).toBe(5);
  });

  it("no newline marker is decoration; default counts", () => {
    const files = parse(
      j(
        "diff --git a/c.txt b/c.txt",
        "--- a/c.txt",
        "+++ b/c.txt",
        "@@ -1 +1 @@",
        "-old",
        "\\ No newline at end of file",
        "+new",
        "\\ No newline at end of file",
      ),
    );
    const lines = files[0]!.hunks[0]!.lines;
    expect(lines.map((l) => l.kind)).toEqual(["del", "add"]);
    expect(lines[1]!.newLnum).toBe(1);
    expect(files[0]!.hunks[0]!.oldCount).toBe(1);
  });

  it("is stable across parses", () => {
    const text = j(
      "diff --git a/d.txt b/d.txt",
      "--- a/d.txt",
      "+++ b/d.txt",
      "@@ -1,1 +1,2 @@",
      " keep",
      "+extra",
    );
    expect(parse(text)).toEqual(parse(text));
  });

  it("treats --- / +++ inside a hunk as content", () => {
    const files = parse(
      j(
        "diff --git a/schema.sql b/schema.sql",
        "--- a/schema.sql",
        "+++ b/schema.sql",
        "@@ -1,2 +1,2 @@",
        "--- Name: old; Type: FUNCTION",
        "+++ Name: new; Type: FUNCTION",
        " tail",
      ),
    );
    expect(files.length).toBe(1);
    expect(files[0]!.path).toBe("schema.sql");
    const lines = files[0]!.hunks[0]!.lines;
    expect(lines.length).toBe(3);
    expect(lines[0]).toMatchObject({
      kind: "del",
      text: "-- Name: old; Type: FUNCTION",
      oldLnum: 1,
    });
    expect(lines[1]).toMatchObject({
      kind: "add",
      text: "++ Name: new; Type: FUNCTION",
    });
  });
});

describe("diff.mapLnum", () => {
  it("follows pre-image lines to the post-image", () => {
    const hunks = parse(
      j(
        "diff --git a/e.txt b/e.txt",
        "--- a/e.txt",
        "+++ b/e.txt",
        "@@ -3,3 +3,4 @@",
        " c",
        "-d",
        "+D",
        "+D2",
        " e",
        "@@ -10,2 +11,1 @@",
        "-j",
        " k",
      ),
    )[0]!.hunks;
    expect(mapLnum(hunks, 1)).toBe(1);
    expect(mapLnum(hunks, 3)).toBe(3);
    expect(mapLnum(hunks, 4)).toBeUndefined();
    expect(mapLnum(hunks, 5)).toBe(6);
    expect(mapLnum(hunks, 8)).toBe(9);
    expect(mapLnum(hunks, 10)).toBeUndefined();
    expect(mapLnum(hunks, 11)).toBe(11);
    expect(mapLnum(hunks, 20)).toBe(20);
    expect(mapLnum([], 7)).toBe(7);
  });
});
