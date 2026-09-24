import type { Brand } from "../core/types.ts";

export type PromptToken = Brand<number, "PromptToken">;
export type PromptResult =
  | { kind: "editor-submit"; token: PromptToken; text: string | undefined }
  | { kind: "pick"; token: PromptToken; index: number | undefined };
/** Brands a token read off the wire (the action parsers are the only boundary). */
export const toPromptToken = (n: number) => n as PromptToken;
export function parsePromptResult(v: unknown): PromptResult | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const num = (k: string) => (typeof o[k] === "number" ? o[k] : undefined);
  const token = num("token");
  if (token === undefined) return undefined;
  switch (o.kind) {
    case "editor-submit":
      return {
        kind: "editor-submit",
        token: toPromptToken(token),
        text: typeof o.text === "string" ? o.text : undefined,
      };
    case "pick":
      return { kind: "pick", token: toPromptToken(token), index: num("index") };
  }
  return undefined;
}

/**
 * Pending Lua prompts (comment editor, picker) awaiting their result, shared by
 * the review buffers and the overlay so every result arrives on `gleanPrompt`.
 * Each kind
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
  submit(r: PromptResult): boolean {
    const token = r.token;
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
