import { describe, expect, it } from "vitest";
import { Prompts } from "./prompts.ts";

describe("Prompts", () => {
  it("runs a callback once, only for a result of its own kind", async () => {
    const p = new Prompts();
    const got: unknown[] = [];
    const e = p.editor(async (t) => void got.push(t));
    const k = p.pick(async (i) => void got.push(i));
    expect(await p.submit({ kind: "pick", token: e, index: 0 })).toBe(false);
    expect(await p.submit({ kind: "editor-submit", token: k, text: "x" })).toBe(
      false,
    );
    expect(
      await p.submit({ kind: "editor-submit", token: e, text: "hi" }),
    ).toBe(true);
    expect(
      await p.submit({ kind: "editor-submit", token: e, text: "again" }),
    ).toBe(false);
    expect(await p.submit({ kind: "pick", token: 999, index: 1 })).toBe(false);
    expect(await p.submit({ kind: "pick", token: k, index: 2 })).toBe(true);
    expect(got).toEqual(["hi", 2]);
  });
});
