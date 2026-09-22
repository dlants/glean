/**
 * Flatten an ordered path list into a preorder directory tree: a `dir` row per
 * directory component when it opens, then the files inside it. Order-preserving:
 * a directory reappearing later (unsorted input) opens a second row sharing
 * the first one's prefix.
 */

export type LayoutNode =
  | {
      kind: "dir";
      depth: number;
      name: string;
      /** Full path of the (deepest, after chain collapse) directory. */
      prefix: string;
      /** Indices into the input of every path beneath this row. */
      files: number[];
    }
  | { kind: "file"; depth: number; name: string; index: number };

export function dirLayout(paths: readonly string[]): LayoutNode[] {
  const out: LayoutNode[] = [];
  const open: string[] = [];
  const nodes: Extract<LayoutNode, { kind: "dir" }>[] = [];
  paths.forEach((path, i) => {
    const comps = path.split("/");
    const ndirs = comps.length - 1;
    let common = 0;
    while (
      common < open.length &&
      common < ndirs &&
      open[common] === comps[common]
    ) {
      common++;
    }
    open.length = common;
    nodes.length = common;
    for (let k = common; k < ndirs; k++) {
      open.push(comps[k]!);
      const node = {
        kind: "dir" as const,
        depth: k,
        name: comps[k]!,
        prefix: comps.slice(0, k + 1).join("/"),
        files: [],
      };
      nodes.push(node);
      out.push(node);
    }
    for (let k = 0; k < ndirs; k++) nodes[k]!.files.push(i);
    out.push({ kind: "file", depth: ndirs, index: i, name: comps.at(-1)! });
  });
  return collapseChains(out);
}

/**
 * `a/` holding only `b/` holding only `c/` renders as one `a/b/c` row, and a
 * chain ending in a lone file as one `a/b/c/file` row. Back to front, so each
 * subtree is collapsed before its parent is considered. A merged dir keeps the
 * deepest prefix; its `files` are unchanged since a chain adds no siblings.
 */
function collapseChains(out: LayoutNode[]): LayoutNode[] {
  for (let i = out.length - 1; i >= 0; i--) {
    for (;;) {
      const node = out[i];
      if (node?.kind !== "dir") break;
      const depth = node.depth;
      let last = i + 1;
      while (last < out.length && out[last]!.depth > depth) last++;
      let kids = 0;
      for (let k = i + 1; k < last; k++)
        if (out[k]!.depth === depth + 1) kids++;
      if (kids !== 1) break;
      const child = out[i + 1]!;
      if (child.kind === "file") {
        if (last - i !== 2) break;
        child.name = `${node.name}/${child.name}`;
        child.depth = depth;
        out.splice(i, 1);
        break;
      }
      node.name = `${node.name}/${child.name}`;
      node.prefix = child.prefix;
      out.splice(i + 1, 1);
      for (let k = i + 1; k < last - 1; k++) out[k]!.depth--;
    }
  }
  return out;
}
