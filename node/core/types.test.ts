import { describe, expect, it } from "vitest";
import {
  addBytes,
  byteLen,
  lineAt,
  lnumAt,
  rowAt,
  toLnum,
  toRow,
} from "./types.ts";

describe("coordinate helpers", () => {
  it("converts between rows and lnums", () => {
    expect(toRow(lnumAt(1))).toBe(0);
    expect(toLnum(rowAt(0))).toBe(1);
    expect(toLnum(toRow(lnumAt(7)))).toBe(7);
  });
  it("indexes lines by lnum", () => {
    expect(lineAt(["a", "b"], lnumAt(1))).toBe("a");
    expect(lineAt(["a", "b"], lnumAt(2))).toBe("b");
    expect(lineAt(["a", "b"], lnumAt(3))).toBeUndefined();
  });
  it("measures utf-8 bytes", () => {
    expect(byteLen("abc")).toBe(3);
    expect(byteLen("é")).toBe(2);
    expect(byteLen("→x")).toBe(4);
    expect(byteLen("😀")).toBe(4);
    expect(addBytes(byteLen("é"), byteLen("😀"))).toBe(6);
  });
});
