/**
 * `.gleanignore`: the repo's declaration of which files are generated.
 * Generated files are derived-seen rather than marked, so nothing is written to
 * the store and a path leaving the file is unseen again by construction.
 *
 * gitignore syntax, compiled to JS regexes.
 */
import { readFile } from "node:fs/promises";
import type { RepoPath } from "./types.ts";

export const FILE = ".gleanignore";

const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** `*` and `?` never cross a `/`; `**` does, only as a whole path segment. */
function translate(glob: string): string {
  let out = "";
  let i = 0;
  const n = glob.length;
  while (i < n) {
    const c = glob[i]!;
    if (c === "\\" && i < n - 1) {
      out += escapeRe(glob[i + 1]!);
      i += 2;
    } else if (glob.startsWith("**/", i) && (i === 0 || glob[i - 1] === "/")) {
      out += "(?:.*/)?";
      i += 3;
    } else if (glob.startsWith("**", i) && i + 2 === n && glob[i - 1] === "/") {
      out += ".*";
      i += 2;
    } else if (c === "*") {
      out += "[^/]*";
      i++;
    } else if (c === "?") {
      out += "[^/]";
      i++;
    } else if (c === "[") {
      const j = glob.indexOf("]", i + 2);
      if (j === -1) {
        out += "\\[";
        i++;
      } else {
        let body = glob.slice(i + 1, j);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        out += `[${body}]`;
        i = j + 1;
      }
    } else {
      out += escapeRe(c);
      i++;
    }
  }
  return out;
}

type Rule = { re: RegExp; negate: boolean; dirOnly: boolean };

function compileLine(line: string): Rule | undefined {
  if (/^\s*$/.test(line) || line.startsWith("#")) return undefined;
  // Unescaped trailing whitespace is not part of the pattern.
  let pat = line.replace(/([^\\])\s+$/, "$1");
  let negate = false;
  if (pat.startsWith("!")) {
    negate = true;
    pat = pat.slice(1);
  } else if (pat.startsWith("\\#") || pat.startsWith("\\!")) {
    pat = pat.slice(1);
  }
  const dirOnly = pat.endsWith("/");
  if (dirOnly) pat = pat.slice(0, -1);
  if (pat === "") return undefined;
  // An interior slash anchors at the repo root; a bare name matches any depth.
  const anchored = pat.includes("/");
  if (pat.startsWith("/")) pat = pat.slice(1);
  let body = translate(pat);
  if (!anchored) body = `(?:.*/)?${body}`;
  try {
    return { re: new RegExp(`^${body}$`), negate, dirOnly };
  } catch {
    return undefined;
  }
}

export class Matcher {
  private readonly cache = new Map<RepoPath, boolean>();
  constructor(private readonly rules: readonly Rule[]) {}

  /** Last matching rule wins; dir-only rules apply to ancestor directories only. */
  private decide(candidate: string, isDir: boolean): boolean | undefined {
    let ignored: boolean | undefined;
    for (const rule of this.rules) {
      if ((isDir || !rule.dirOnly) && rule.re.test(candidate)) {
        ignored = !rule.negate;
      }
    }
    return ignored;
  }

  /**
   * An ignored ancestor ignores everything beneath it and can't be re-included
   * from within, so ancestors are decided outermost-first.
   */
  match(path: RepoPath): boolean {
    const hit = this.cache.get(path);
    if (hit !== undefined) return hit;
    let result = false;
    for (
      let at = path.indexOf("/");
      at !== -1;
      at = path.indexOf("/", at + 1)
    ) {
      if (this.decide(path.slice(0, at), true)) {
        result = true;
        break;
      }
    }
    if (!result) result = this.decide(path, false) === true;
    this.cache.set(path, result);
    return result;
  }
}

/** Undefined when the text declares no rules. */
export function compile(text: string): Matcher | undefined {
  const rules = text
    .split("\n")
    .map((l) => compileLine(l.replace(/\r$/, "")))
    .filter((r): r is Rule => r !== undefined);
  return rules.length === 0 ? undefined : new Matcher(rules);
}

/** Read `<root>/.gleanignore`; undefined when absent or ruleless. */
export async function load(root: string): Promise<Matcher | undefined> {
  try {
    return compile(await readFile(`${root}/${FILE}`, "utf8"));
  } catch {
    return undefined;
  }
}
