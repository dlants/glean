import { describe, expect, it } from "vitest";
import { BufUndo } from "./bufUndo.ts";

describe("BufUndo", () => {
  it("undo then redo replays in order", () => {
    const u = new BufUndo<string>();
    u.push(1, 5, "a");
    u.push(1, 5, "b");
    expect(u.undo(1, 5)).toBe("b");
    expect(u.depth(1)).toEqual({ undo: 1, redo: 1, seq: 5 });
    expect(u.redo(1, 5)).toBe("b");
    expect(u.undo(1, 5)).toBe("b");
    expect(u.undo(1, 5)).toBe("a");
    expect(u.undo(1, 5)).toBeUndefined();
  });
  it("a fresh push clears redo", () => {
    const u = new BufUndo<string>();
    u.push(1, 5, "a");
    u.undo(1, 5);
    u.push(1, 5, "b");
    expect(u.redo(1, 5)).toBeUndefined();
  });
  it("a novel edit (seq moved) wipes the stacks", () => {
    const u = new BufUndo<string>();
    u.push(1, 5, "a");
    expect(u.undo(1, 6)).toBeUndefined();
    expect(u.depth(1)).toEqual({ undo: 0, redo: 0, seq: 6 });
  });
  it("buffers are independent", () => {
    const u = new BufUndo<string>();
    u.push(1, 5, "a");
    u.push(2, 5, "b");
    u.drop(1);
    expect(u.depth(1)).toBeUndefined();
    expect(u.undo(2, 5)).toBe("b");
  });
});
