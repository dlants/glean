import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRelative } from "./app.ts";

describe("repoRelative", () => {
  const root = mkdtempSync(join(tmpdir(), "glean-rel-"));
  mkdirSync(join(root, "sub"));
  it("rejects empty and scheme names", async () => {
    expect(await repoRelative(root, "")).toBeUndefined();
    expect(await repoRelative(root, "glean://x/y")).toBeUndefined();
  });
  it("resolves symlinks on either side (/tmp vs /private/tmp)", async () => {
    const real = realpathSync(root);
    expect(await repoRelative(root, join(real, "sub", "a.txt"))).toBe(
      "sub/a.txt",
    );
    const link = join(mkdtempSync(join(tmpdir(), "glean-link-")), "r");
    symlinkSync(real, link);
    expect(await repoRelative(real, join(link, "sub"))).toBe("sub");
  });
  it("rejects the root itself and paths outside it", async () => {
    expect(await repoRelative(root, root)).toBeUndefined();
    expect(
      await repoRelative(join(root, "sub"), join(root, "x")),
    ).toBeUndefined();
  });
});
