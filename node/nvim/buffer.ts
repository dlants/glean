import type { ExtmarkId, ExtmarkOptions } from "./extmarks.ts";
import type { Nvim } from "./nvim-node/index.ts";
import type {
  Position0Indexed,
  Position1Indexed,
  Row0Indexed,
} from "./window.ts";

export type Line = string & { __line: true };
export type BufNr = number & { __bufnr: true };
export type Mode = "n" | "i" | "v";

/**
 * Branded type for Neovim namespace IDs.
 */
export type NamespaceId = number & { __namespaceId: true };

/** The namespaces glean owns. Keeps a typo from silently creating a fresh,
 * invisible namespace. */
export const GLEAN_REVIEW_NAMESPACE = "glean-review";
export const GLEAN_GUTTER_NAMESPACE = "glean-gutter";
export type GleanNamespace =
  | typeof GLEAN_REVIEW_NAMESPACE
  | typeof GLEAN_GUTTER_NAMESPACE;

export class NvimBuffer {
  constructor(
    public readonly id: BufNr,
    private nvim: Nvim,
  ) {}

  getOption(option: string) {
    return this.nvim.call("nvim_buf_get_option", [this.id, option]);
  }

  setOption(option: string, value: unknown) {
    return this.nvim.call("nvim_buf_set_option", [this.id, option, value]);
  }

  getChangeTick() {
    return this.nvim.call("nvim_buf_get_changedtick", [
      this.id,
    ]) as unknown as Promise<number>;
  }

  setLines({
    start,
    end,
    lines,
  }: {
    start: Row0Indexed;
    end: Row0Indexed;
    lines: Line[];
  }) {
    return this.nvim.call("nvim_buf_set_lines", [
      this.id,
      start,
      end,
      false,
      lines,
    ]);
  }

  async getLines({
    start,
    end,
  }: {
    start: Row0Indexed;
    end: Row0Indexed;
  }): Promise<Line[]> {
    // Ensure buffer is loaded before getting lines
    // unloaded buffers return no lines, see https://github.com/neovim/neovim/pull/8660
    await this.nvim.call("nvim_eval", [`bufload(${this.id})`]);

    const lines = await this.nvim.call("nvim_buf_get_lines", [
      this.id,
      start,
      end,
      false,
    ]);
    return lines as Line[];
  }

  async getText({
    startPos,
    endPos,
  }: {
    startPos: Position0Indexed;
    endPos: Position0Indexed;
  }): Promise<Line[]> {
    const lines = await this.nvim.call("nvim_buf_get_text", [
      this.id,
      startPos.row,
      startPos.col,
      endPos.row,
      endPos.col,
      {},
    ]);
    return lines as Line[];
  }

  setText({
    startPos,
    endPos,
    lines,
  }: {
    startPos: Position0Indexed;
    endPos: Position0Indexed;
    lines: Line[];
  }): Promise<void> {
    return this.nvim.call("nvim_buf_set_text", [
      this.id,
      startPos.row,
      startPos.col,
      endPos.row,
      endPos.col,
      lines,
    ]);
  }

  setMark({ mark, pos }: { mark: string; pos: Position1Indexed }) {
    return this.nvim.call("nvim_buf_set_mark", [
      this.id,
      mark,
      pos.row,
      pos.col,
      {},
    ]);
  }

  getName(): Promise<string> {
    return this.nvim.call("nvim_buf_get_name", [this.id]) as Promise<string>;
  }

  setName(name: string) {
    // nvim_buf_set_name uses `:file` semantics: renaming a buffer that already
    // has a name leaves behind a new empty buffer holding the OLD name. These
    // orphans accumulate and cause E95 ("Buffer with this name already exists")
    // when a later setName targets a name that another buffer still holds. Wipe
    // any buffer already holding the target name *before* renaming (so the
    // rename can't fail with E95), then wipe orphans left holding the old name.
    return this.nvim.call("nvim_exec_lua", [
      `\
local bufId, name = ...
-- nvim_buf_set_name stores the name resolved to an absolute path, so match
-- against the resolved form rather than the raw argument.
local resolved = vim.fn.fnamemodify(name, ":p")
for _, other in ipairs(vim.api.nvim_list_bufs()) do
  if other ~= bufId then
    local otherName = vim.api.nvim_buf_get_name(other)
    if otherName == name or otherName == resolved then
      pcall(vim.api.nvim_buf_delete, other, { force = true })
    end
  end
end
local oldName = vim.api.nvim_buf_get_name(bufId)
vim.api.nvim_buf_set_name(bufId, name)
if oldName ~= "" then
  for _, orphan in ipairs(vim.api.nvim_list_bufs()) do
    if orphan ~= bufId and vim.api.nvim_buf_get_name(orphan) == oldName then
      pcall(vim.api.nvim_buf_delete, orphan, { force = true })
    end
  end
end`,
      [this.id, name],
    ]);
  }

  static async create(listed: boolean, scratch: boolean, nvim: Nvim) {
    const bufNr = (await nvim.call("nvim_create_buf", [
      listed,
      scratch,
    ])) as BufNr;
    return new NvimBuffer(bufNr, nvim);
  }

  delete(options?: { force?: boolean; unload?: boolean }) {
    return this.nvim.call("nvim_buf_delete", [this.id, options || {}]);
  }

  isValid(): Promise<boolean> {
    return this.nvim.call("nvim_buf_is_valid", [this.id]);
  }

  // Extmark methods

  /**
   * Set an extmark in this buffer with the given options.
   * Returns the extmark ID for later updates or deletion.
   */
  async setExtmark({
    startPos,
    endPos,
    options,
    namespace,
  }: {
    startPos: Position0Indexed;
    endPos: Position0Indexed;
    options: ExtmarkOptions;
    namespace?: GleanNamespace;
  }): Promise<ExtmarkId> {
    const namespaceId = await this.getNamespace(namespace);

    // Prepare extmark options with end position
    const extmarkOpts = {
      ...options,
      end_row: endPos.row,
      end_col: endPos.col,
    };

    const extmarkId = await this.nvim.call("nvim_buf_set_extmark", [
      this.id,
      namespaceId,
      startPos.row,
      startPos.col,
      extmarkOpts,
    ]);

    return extmarkId as ExtmarkId;
  }

  /**
   * Delete a specific extmark from this buffer.
   */
  async deleteExtmark(
    extmarkId: ExtmarkId,
    namespace?: GleanNamespace,
  ): Promise<void> {
    const namespaceId = await this.getNamespace(namespace);
    await this.nvim.call("nvim_buf_del_extmark", [
      this.id,
      namespaceId,
      extmarkId,
    ]);
  }

  /**
   * Clear all extmarks in the glean highlight namespace for this buffer.
   * This is useful for bulk cleanup when unmounting views or clearing highlights.
   */
  async clearAllExtmarks(namespace?: GleanNamespace): Promise<void> {
    const namespaceId = await this.getNamespace(namespace);

    // Clear all extmarks in the namespace for this buffer
    await this.nvim.call("nvim_buf_clear_namespace", [
      this.id,
      namespaceId,
      0, // start line
      -1, // end line (-1 means end of buffer)
    ]);
  }

  /**
   * Update an existing extmark with new options and/or position.
   * This is more efficient than deleting and recreating for position/style changes.
   */
  async updateExtmark({
    extmarkId,
    startPos,
    endPos,
    options,
    namespace,
  }: {
    extmarkId: ExtmarkId;
    startPos: Position0Indexed;
    endPos: Position0Indexed;
    options: ExtmarkOptions;
    namespace?: GleanNamespace;
  }): Promise<ExtmarkId> {
    const namespaceId = await this.getNamespace(namespace);

    // Prepare extmark options with end position and existing ID
    const extmarkOpts = {
      ...options,
      id: extmarkId,
      end_row: endPos.row,
      end_col: endPos.col,
    };

    const updatedId = await this.nvim.call("nvim_buf_set_extmark", [
      this.id,
      namespaceId,
      startPos.row,
      startPos.col,
      extmarkOpts,
    ]);

    return updatedId as ExtmarkId;
  }

  /**
   * Get all extmarks in the glean namespace for this buffer.
   * Returns an array of extmark information including ID, position, and options.
   */
  async getExtmarks(namespace?: GleanNamespace): Promise<
    Array<{
      id: ExtmarkId;
      startPos: Position0Indexed;
      endPos: Position0Indexed;
      options: ExtmarkOptions;
    }>
  > {
    const namespaceId = await this.getNamespace(namespace);

    // Get all extmarks in the namespace
    const extmarks = await this.nvim.call("nvim_buf_get_extmarks", [
      this.id,
      namespaceId,
      0, // start position
      -1, // end position (-1 means end of buffer)
      { details: true }, // include details like end position and options
    ]);

    return (extmarks as unknown[][]).map((extmarkData) =>
      this.parseExtmarkData(extmarkData),
    );
  }

  /**
   * Get a specific extmark by its ID from the glean namespace.
   * Returns undefined if the extmark doesn't exist.
   */
  async getExtmarkById(
    extmarkId: ExtmarkId,
    namespace?: GleanNamespace,
  ): Promise<
    | {
        id: ExtmarkId;
        startPos: Position0Indexed;
        endPos: Position0Indexed;
        options: ExtmarkOptions;
      }
    | undefined
  > {
    const namespaceId = await this.getNamespace(namespace);

    try {
      // Get the specific extmark by ID
      const extmarksResult = await this.nvim.call("nvim_buf_get_extmarks", [
        this.id,
        namespaceId,
        extmarkId, // start from this specific extmark ID
        extmarkId, // end at this specific extmark ID
        { details: true, limit: 1 }, // include details and limit to 1 result
      ]);

      const extmarksArray = extmarksResult as unknown[][];
      if (extmarksArray.length === 0) {
        return undefined;
      }

      return this.parseExtmarkData(extmarksArray[0]);
    } catch {
      // If the extmark doesn't exist, nvim_buf_get_extmarks may throw
      return undefined;
    }
  }

  /**
   * Parse raw extmark data from nvim_buf_get_extmarks into our structured format.
   */
  private parseExtmarkData(extmarkData: unknown[]): {
    id: ExtmarkId;
    startPos: Position0Indexed;
    endPos: Position0Indexed;
    options: ExtmarkOptions;
  } {
    const [id, startRow, startCol, details] = extmarkData;
    return {
      id: id as ExtmarkId,
      startPos: { row: startRow, col: startCol } as Position0Indexed,
      endPos: {
        row: (details as { end_row: unknown }).end_row || startRow,
        col: (details as { end_col: unknown }).end_col || startCol,
      } as Position0Indexed,
      options: details as ExtmarkOptions,
    };
  }

  /**
   * Create or get a neovim namespace, defaulting to the shared glean
   * highlight namespace.
   */
  async getNamespace(
    name: GleanNamespace = GLEAN_REVIEW_NAMESPACE,
  ): Promise<NamespaceId> {
    const namespaceId = await this.nvim.call("nvim_create_namespace", [name]);
    return namespaceId as NamespaceId;
  }
}
