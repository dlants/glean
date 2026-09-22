import { describe, expect, it } from "vitest";
import { withNvim } from "../../test/driver.ts";

describe("attach", () => {
  it("nvim_buf_set_lines with a large file", async () => {
    await withNvim(async (nvim) => {
      const lines = Array.from({ length: 500 }, () => "x".repeat(100));
      await nvim.call("nvim_buf_set_lines", [0, 0, -1, false, lines]);
      expect(await nvim.call("nvim_buf_get_lines", [0, 0, -1, false])).toEqual(
        lines,
      );
    });
  });
});
