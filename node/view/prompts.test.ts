import { describe, expect, it } from "vitest";
import { Prompts, parsePromptResult, toPromptToken } from "./prompts.ts";

describe("Prompts", () => {
  it("resolves a prompt once, only for a result of its own kind", async () => {
    const p = new Prompts();
    const e = p.editor();
    const k = p.pick();
    expect(p.submit({ kind: "pick", token: e.token, index: 0 })).toBe(false);
    expect(p.submit({ kind: "editor-submit", token: k.token, text: "x" })).toBe(
      false,
    );
    expect(
      p.submit({ kind: "editor-submit", token: e.token, text: "hi" }),
    ).toBe(true);
    expect(
      p.submit({ kind: "editor-submit", token: e.token, text: "again" }),
    ).toBe(false);
    expect(
      p.submit({ kind: "pick", token: toPromptToken(999), index: 1 }),
    ).toBe(false);
    expect(p.submit({ kind: "pick", token: k.token, index: 2 })).toBe(true);
    expect(await e.result).toBe("hi");
    expect(await k.result).toBe(2);
  });
  it("a dismissed prompt resolves undefined", async () => {
    const p = new Prompts();
    const e = p.editor();
    p.submit({ kind: "editor-submit", token: e.token, text: undefined });
    expect(await e.result).toBeUndefined();
  });
});
describe("parsePromptResult", () => {
  it("maps a missing or mistyped text/index to undefined but needs a token", () => {
    expect(parsePromptResult({ kind: "editor-submit", token: 1 })).toEqual({
      kind: "editor-submit",
      token: 1,
      text: undefined,
    });
    expect(
      parsePromptResult({ kind: "editor-submit", token: 1, text: 3 }),
    ).toEqual({
      kind: "editor-submit",
      token: 1,
      text: undefined,
    });
    expect(parsePromptResult({ kind: "pick", token: 2, index: "x" })).toEqual({
      kind: "pick",
      token: 2,
      index: undefined,
    });
    expect(
      parsePromptResult({ kind: "editor-submit", text: "hi" }),
    ).toBeUndefined();
    expect(parsePromptResult({ kind: "pick", index: 1 })).toBeUndefined();
    expect(parsePromptResult({ kind: "pick", token: 2 })).toEqual({
      kind: "pick",
      token: 2,
      index: undefined,
    });
    expect(parsePromptResult({ kind: "editor-submit" })).toBeUndefined();
  });
});
