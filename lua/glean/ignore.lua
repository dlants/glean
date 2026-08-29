-- glean.ignore: `.gleanignore` — the repo's declaration of which files are
-- generated. Generated files are derived-seen (and therefore collapsed) rather
-- than marked: nothing is written to the review store, so a path leaving the
-- file makes its lines unseen again by construction.
--
-- Pure: patterns in, predicate out. The syntax is gitignore's, implemented here
-- rather than delegated to `git check-ignore` so the matcher stays synchronous
-- and headless-testable.
local M = {}
M.FILE = ".gleanignore"
-- One glob segment-language token at a time, translated into vim regex. `*` and
-- `?` never cross a `/`; `**` does, and only as a whole path segment.
local function translate(glob)
  local out, i, n = {}, 1, #glob
  while i <= n do
    local c = glob:sub(i, i)
    if c == "\\" and i < n then
      out[#out + 1] = "\\" .. glob:sub(i + 1, i + 1)
      i = i + 2
    elseif glob:sub(i, i + 2) == "**/" and (i == 1 or glob:sub(i - 1, i - 1) == "/") then
      out[#out + 1] = "\\%(.*/\\)\\="
      i = i + 3
    elseif glob:sub(i, i + 1) == "**" and i + 1 == n and glob:sub(i - 1, i - 1) == "/" then
      out[#out + 1] = ".*"
      i = i + 2
    elseif c == "*" then
      out[#out + 1] = "[^/]*"
      i = i + 1
    elseif c == "?" then
      out[#out + 1] = "[^/]"
      i = i + 1
    elseif c == "[" then
      local j = glob:find("]", i + 2, true)
      if not j then
        out[#out + 1] = "\\["
        i = i + 1
      else
        local body = glob:sub(i + 1, j - 1)
        if body:sub(1, 1) == "!" then body = "^" .. body:sub(2) end
        out[#out + 1] = "[" .. body .. "]"
        i = j + 1
      end
    else
      out[#out + 1] = c:match("[%w_/]") and c or ("\\" .. c)
      i = i + 1
    end
  end
  return table.concat(out)
end
-- A single `.gleanignore` line as a rule, or nil for blanks and comments.
local function compile(line)
  if line:match("^%s*$") or line:sub(1, 1) == "#" then return nil end
  -- Unescaped trailing whitespace is not part of the pattern.
  local pat = line:gsub("([^\\])%s+$", "%1")
  local negate = false
  if pat:sub(1, 1) == "!" then
    negate = true
    pat = pat:sub(2)
  elseif pat:sub(1, 2) == "\\#" or pat:sub(1, 2) == "\\!" then
    pat = pat:sub(2)
  end
  local dir_only = pat:sub(-1) == "/"
  if dir_only then pat = pat:sub(1, -2) end
  if pat == "" then return nil end
  -- A pattern with an interior slash is anchored at the repo root; a bare name
  -- matches at any depth.
  local anchored = pat:find("/", 1, true) ~= nil
  if pat:sub(1, 1) == "/" then pat = pat:sub(2) end
  local body = translate(pat)
  if not anchored then body = "\\%(.*/\\)\\=" .. body end
  local ok, re = pcall(vim.regex, "^" .. body .. "$")
  if not ok then return nil end
  return { re = re, negate = negate, dir_only = dir_only }
end
local Matcher = {}
Matcher.__index = Matcher
-- Compile `.gleanignore` text. Returns nil when it declares no rules, so
-- callers can skip the predicate entirely.
function M.compile(text)
  local rules = {}
  for line in (text .. "\n"):gmatch("([^\n]*)\n") do
    local rule = compile((line:gsub("\r$", "")))
    if rule then rules[#rules + 1] = rule end
  end
  if #rules == 0 then return nil end
  return setmetatable({ rules = rules, cache = {} }, Matcher)
end
-- Read `<root>/.gleanignore`. Returns nil when absent or ruleless.
function M.load(root)
  local path = root .. "/" .. M.FILE
  local fd = io.open(path, "r")
  if not fd then return nil end
  local text = fd:read("*a")
  fd:close()
  return M.compile(text or "")
end
-- Last matching rule wins, as in gitignore. `dir_only` rules only apply to the
-- ancestor-directory candidates.
function Matcher:decide(candidate, is_dir)
  local ignored = nil
  for _, rule in ipairs(self.rules) do
    if (is_dir or not rule.dir_only) and rule.re:match_str(candidate) then
      ignored = not rule.negate
    end
  end
  return ignored
end
-- Is this repo-relative file path generated? An ignored ancestor directory
-- ignores everything beneath it and cannot be re-included from within, which is
-- why ancestors are decided outermost-first and short-circuit.
function Matcher:match(path)
  local hit = self.cache[path]
  if hit ~= nil then return hit end
  local result = false
  local at = 0
  while true do
    local slash = path:find("/", at + 1, true)
    if not slash then break end
    at = slash
    if self:decide(path:sub(1, slash - 1), true) then
      result = true
      break
    end
  end
  if not result then result = self:decide(path, false) == true end
  self.cache[path] = result
  return result
end
return M
