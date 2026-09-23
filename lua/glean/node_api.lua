-- Agent api shim over the node backend: every call is one rpcrequest, served
-- by node from memory (node/api/api.ts). A call node cannot answer promptly
-- returns { status = "pending" }; retry it. Errors are raised.
--
-- Until cutover `glean.api` is still the Lua implementation; this module
-- replaces it then.
local M = {}

local function arg(v)
  if v == nil then return vim.NIL end
  return v
end

local function call(name, ...)
  local chan = require("glean.node").channel_id
  if not chan then
    error("glean: the backend is not running", 0)
  end
  local args = {}
  for i = 1, select("#", ...) do args[i] = arg(select(i, ...)) end
  local ok, res = pcall(vim.rpcrequest, chan, "gleanApi", name, args)
  if not ok then error(tostring(res), 0) end
  if res == vim.NIL then return nil end
  return res
end

function M.sessions() return call("sessions") end
function M.comments(session, opts) return call("comments", session, opts) end
function M.hunks(session, opts) return call("hunks", session, opts) end
function M.mark(session, sel, seen) return call("mark", session, sel, seen) end
function M.excerpt(session, srow, erow) return call("excerpt", session, srow, erow) end
function M.add_comment(opts) return call("add_comment", opts) end
function M.reply(session, id, text) return call("reply", session, id, text) end
function M.unreply(session, id) return call("unreply", session, id) end

return M
