/**
 * Undo/redo for actions taken in an ordinary file buffer that change no text
 * (seen-marks). The stack sits on top of the buffer's own undo tree: the Lua
 * `u` spends it first and falls through to text undo; `<C-r>` is the mirror.
 *
 * `seq` is the buffer's `undotree().seq_last` when the stack was last touched.
 * It grows only on a novel edit, which wipes the stacks: an undo interleaved
 * with text rewritten since would act on lines that no longer mean the same.
 */
export type UndoDepth = { undo: number; redo: number; seq: number };

export class BufUndo<A> {
  private readonly stacks = new Map<
    number,
    { undo: A[]; redo: A[]; seq: number }
  >();

  private stack(buf: number, seq: number) {
    let s = this.stacks.get(buf);
    if (!s || s.seq !== seq) {
      s = { undo: [], redo: [], seq };
      this.stacks.set(buf, s);
    }
    return s;
  }

  /** Record an action that has already been applied. */
  push(buf: number, seq: number, a: A) {
    const s = this.stack(buf, seq);
    s.undo.push(a);
    s.redo = [];
  }

  /** Pop for undo; the action moves to the redo stack. */
  undo(buf: number, seq: number): A | undefined {
    const s = this.stack(buf, seq);
    const a = s.undo.pop();
    if (a !== undefined) s.redo.push(a);
    return a;
  }

  redo(buf: number, seq: number): A | undefined {
    const s = this.stack(buf, seq);
    const a = s.redo.pop();
    if (a !== undefined) s.undo.push(a);
    return a;
  }

  depth(buf: number): UndoDepth | undefined {
    const s = this.stacks.get(buf);
    return s && { undo: s.undo.length, redo: s.redo.length, seq: s.seq };
  }

  drop(buf: number) {
    this.stacks.delete(buf);
  }
}
