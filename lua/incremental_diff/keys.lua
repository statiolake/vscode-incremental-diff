-- Buffer-local keys on buffers incremental-diff does not own (the work
-- tree's files while they are shown in a review): each map remembers the
-- buffer-local map it shadows and puts it back when the review lets go of
-- the buffer. A key pressed outside a review's windows does what it did
-- before (that buffer map, else the global map, else Neovim's own).

local M = {}

-- buf -> lhs -> { saved = maparg dict | false }
local bound = {}

local function termcodes(keys)
  return vim.api.nvim_replace_termcodes(keys, true, false, true)
end

local function run_map(map, lhs)
  if map.callback then
    local result = map.callback()
    if map.expr == 1 and type(result) == 'string' and result ~= '' then
      vim.api.nvim_feedkeys(map.replace_keycodes == 1 and termcodes(result) or result, map.noremap == 1 and 'n' or 'm', false)
    end
    return
  end
  local rhs = map.rhs or ''
  if map.expr == 1 then
    rhs = vim.api.nvim_eval(rhs)
  end
  if rhs == '' then
    vim.api.nvim_feedkeys(termcodes(lhs), 'n', false)
  else
    vim.api.nvim_feedkeys(termcodes(rhs), map.noremap == 1 and 'n' or 'm', false)
  end
end

local function global_map(lhs)
  local want = termcodes(lhs)
  for _, map in ipairs(vim.api.nvim_get_keymap 'n') do
    if termcodes(map.lhs) == want then
      return map
    end
  end
end

--- What lhs did in buf before incremental-diff mapped it.
function M.fallback(buf, lhs)
  local entry = bound[buf] and bound[buf][lhs]
  local saved = entry and entry.saved
  if saved then
    return run_map(saved, lhs)
  end
  local map = global_map(lhs)
  if map then
    return run_map(map, lhs)
  end
  vim.api.nvim_feedkeys(termcodes(lhs), 'n', false)
end

--- Map lhs in buf (Normal mode) to fn while `active()` says so; otherwise
--- the key does what it did before.
function M.bind(buf, lhs, fn, desc, active)
  if not lhs or lhs == '' then
    return
  end
  bound[buf] = bound[buf] or {}
  if bound[buf][lhs] == nil then
    -- maparg answers for the current buffer: ask in buf.
    local saved = vim.api.nvim_buf_call(buf, function()
      return vim.fn.maparg(lhs, 'n', false, true)
    end)
    bound[buf][lhs] = { saved = (saved.buffer == 1) and saved or false }
  end
  vim.keymap.set('n', lhs, function()
    if active and not active() then
      return M.fallback(buf, lhs)
    end
    fn()
  end, { buffer = buf, nowait = true, silent = true, desc = 'incremental-diff: ' .. desc })
end

--- Take every map incremental-diff put on buf away, restoring what they shadowed.
function M.unbind_all(buf)
  local maps = bound[buf]
  bound[buf] = nil
  if not maps or not vim.api.nvim_buf_is_valid(buf) then
    return
  end
  for lhs, entry in pairs(maps) do
    pcall(vim.keymap.del, 'n', lhs, { buffer = buf })
    if entry.saved then
      vim.api.nvim_buf_call(buf, function()
        pcall(vim.fn.mapset, 'n', false, entry.saved)
      end)
    end
  end
end

function M.is_bound(buf)
  return bound[buf] ~= nil
end

return M
