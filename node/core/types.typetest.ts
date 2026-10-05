// Checked by `tsc -p .` only; asserts the coordinate brands don't mix.
import { atomic } from "../nvim/atomic.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type {
  BufNr,
  ByteCol,
  Lnum,
  NsId,
  PostLnum,
  PreLnum,
  Row,
  WinId,
} from "./types.ts";
import { COL0 } from "./types.ts";

declare const row: Row;
declare const lnum: Lnum;
declare const post: PostLnum;
declare const n: number;
declare const nvim: Nvim;
declare const w: WinId;
declare const b: BufNr;
declare const ns: NsId;

// @ts-expect-error Lnum is not a Row
export const r1: Row = lnum;
// @ts-expect-error Row is not an Lnum
export const l1: Lnum = row;
export const l2: Lnum = post;
// @ts-expect-error PostLnum is not a PreLnum
export const p1: PreLnum = post;
// @ts-expect-error number is not a ByteCol
export const c1: ByteCol = n;

export async function calls() {
  await nvim.call("nvim_win_set_cursor", [w, [lnum, COL0]]);
  // @ts-expect-error cursor takes a 1-based Lnum
  await nvim.call("nvim_win_set_cursor", [w, [row, COL0]]);
  await nvim.call("nvim_buf_set_extmark", [b, ns, row, COL0, {}]);
  // @ts-expect-error extmark line is a 0-based Row
  await nvim.call("nvim_buf_set_extmark", [b, ns, lnum, COL0, {}]);
  // @ts-expect-error end_row is a Row
  atomic("nvim_buf_set_extmark", [b, ns, row, COL0, { end_row: lnum }]);
  atomic("nvim_buf_set_extmark", [b, ns, row, COL0, { end_row: row }]);
}
