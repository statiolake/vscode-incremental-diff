-- Hunks between two texts, computed by Neovim's own xdiff (vim.diff) with
-- the options 'diffopt' gives diff mode, so the inline view's hunks are the
-- split view's hunks: the same boundaries, the same ]c stops.

local M = {}

--- vim.diff options from 'diffopt'.
function M.options()
  local opts = { result_type = 'indices' }
  for _, item in ipairs(vim.split(vim.o.diffopt, ',', { trimempty = true })) do
    local key, value = item:match '^([%w_]+):?(.*)$'
    if key == 'algorithm' and value ~= '' then
      opts.algorithm = value
    elseif key == 'indent-heuristic' then
      opts.indent_heuristic = true
    elseif key == 'iwhite' then
      opts.ignore_whitespace_change = true
    elseif key == 'iwhiteall' then
      opts.ignore_whitespace = true
    elseif key == 'iwhiteeol' then
      opts.ignore_whitespace_change_at_eol = true
    elseif key == 'iblank' then
      opts.ignore_blank_lines = true
    elseif key == 'linematch' and tonumber(value) then
      opts.linematch = tonumber(value)
    end
  end
  return opts
end

local function text(lines)
  if #lines == 0 then
    return ''
  end
  return table.concat(lines, '\n') .. '\n'
end

--- Hunks of old -> new (lists of lines): { { old_start, old_count, new_start, new_count }, ... },
--- 1-based; a count of 0 is a pure insertion or deletion (its start is the line before it).
function M.compute(old, new)
  local ok, result = pcall(vim.diff, text(old), text(new), M.options())
  if not ok then
    local opts = M.options()
    opts.linematch = nil
    result = vim.diff(text(old), text(new), opts)
  end
  return result
end

--- The line of new that shows old_line (or is nearest to where it was), given hunks.
function M.old_to_new(hunks, old_line)
  local shift = 0
  for _, h in ipairs(hunks) do
    local os, oc, ns, nc = h[1], h[2], h[3], h[4]
    local old_first = oc == 0 and os + 1 or os
    if old_line < old_first then
      break
    end
    if oc > 0 and old_line <= os + oc - 1 then
      -- Inside a changed range: the same offset into its replacement, else its last line.
      local offset = old_line - os
      if nc == 0 then
        return ns + 1
      end
      return ns + math.min(offset, nc - 1)
    end
    -- The first lines after the hunk on each side line up.
    local next_new = nc == 0 and ns + 1 or ns + nc
    local next_old = oc == 0 and os + 1 or os + oc
    shift = next_new - next_old
  end
  return math.max(1, old_line + shift)
end

--- The line of old that new_line comes from (or the nearest).
function M.new_to_old(hunks, new_line)
  local swapped = {}
  for i, h in ipairs(hunks) do
    swapped[i] = { h[3], h[4], h[1], h[2] }
  end
  return M.old_to_new(swapped, new_line)
end

--- The changed columns of a line pair, as byte ranges [from, to) in each:
--- the common prefix and suffix are left out.
function M.words(a, b)
  local n = math.min(#a, #b)
  local pre = 0
  while pre < n and a:byte(pre + 1) == b:byte(pre + 1) do
    pre = pre + 1
  end
  -- Do not split a multibyte character.
  while pre > 0 and a:byte(pre + 1) and a:byte(pre + 1) >= 0x80 and a:byte(pre + 1) < 0xC0 do
    pre = pre - 1
  end
  local suf = 0
  while suf < n - pre and a:byte(#a - suf) == b:byte(#b - suf) do
    suf = suf + 1
  end
  while suf > 0 and a:byte(#a - suf + 1) and a:byte(#a - suf + 1) >= 0x80 and a:byte(#a - suf + 1) < 0xC0 do
    suf = suf - 1
  end
  return { pre, #a - suf }, { pre, #b - suf }
end

return M
