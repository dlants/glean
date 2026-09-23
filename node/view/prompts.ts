import type { Brand } from "../core/types.ts";

export type PromptToken = Brand<number, "PromptToken">;

/**
 * Callbacks awaiting a Lua prompt result (comment editor, picker). Each kind
 * has its own table, so a result of one kind can never run a callback of the
 * other; a token is consumed by its first result.
 */
export class Prompts {
  private next = 1;
  private readonly editors = new Map<
    PromptToken,
    (text: string) => Promise<void>
  >();
  private readonly picks = new Map<
    PromptToken,
    (index: number) => Promise<void>
  >();
  editor(fn: (text: string) => Promise<void>): PromptToken {
    const t = this.next++ as PromptToken;
    this.editors.set(t, fn);
    return t;
  }
  pick(fn: (index: number) => Promise<void>): PromptToken {
    const t = this.next++ as PromptToken;
    this.picks.set(t, fn);
    return t;
  }
  /** Runs the callback for `token`; false when it is unknown or of another kind. */
  async submit(
    r:
      | { kind: "editor-submit"; token: number; text: string }
      | { kind: "pick"; token: number; index: number },
  ): Promise<boolean> {
    const token = r.token as PromptToken;
    if (r.kind === "editor-submit") {
      const fn = this.editors.get(token);
      this.editors.delete(token);
      if (!fn) return false;
      await fn(r.text);
    } else {
      const fn = this.picks.get(token);
      this.picks.delete(token);
      if (!fn) return false;
      await fn(r.index);
    }
    return true;
  }
}
