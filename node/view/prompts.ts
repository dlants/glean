import type { Brand } from "../core/types.ts";

export type PromptToken = Brand<number, "PromptToken">;

/**
 * Pending Lua prompts (comment editor, picker) awaiting their result. Each kind
 * has its own table, so a result of one kind can never resolve a prompt of the
 * other; a token is consumed by its first result. A dismissed prompt reports
 * back without a value and resolves `undefined`.
 */
export class Prompts {
  private next = 1;
  private readonly editors = new Map<
    PromptToken,
    (text: string | undefined) => void
  >();
  private readonly picks = new Map<
    PromptToken,
    (index: number | undefined) => void
  >();
  editor(): { token: PromptToken; result: Promise<string | undefined> } {
    const token = this.next++ as PromptToken;
    const result = new Promise<string | undefined>((r) =>
      this.editors.set(token, r),
    );
    return { token, result };
  }
  pick(): { token: PromptToken; result: Promise<number | undefined> } {
    const token = this.next++ as PromptToken;
    const result = new Promise<number | undefined>((r) =>
      this.picks.set(token, r),
    );
    return { token, result };
  }
  /** Resolves the prompt for `token`; false when it is unknown or of another kind. */
  submit(
    r:
      | { kind: "editor-submit"; token: number; text: string | undefined }
      | { kind: "pick"; token: number; index: number | undefined },
  ): boolean {
    const token = r.token as PromptToken;
    if (r.kind === "editor-submit") {
      const fn = this.editors.get(token);
      this.editors.delete(token);
      fn?.(r.text);
      return fn !== undefined;
    }
    const fn = this.picks.get(token);
    this.picks.delete(token);
    fn?.(r.index);
    return fn !== undefined;
  }
}
