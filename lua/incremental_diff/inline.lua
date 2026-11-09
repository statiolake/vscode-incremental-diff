-- The inline view: the new side's buffer as it is, with the diff drawn on
-- it as extmarks — added and changed lines in diff mode's own groups, the
-- deleted lines as virtual lines above what replaced them (old, then new,
-- as a unified diff reads). Nothing is inserted into the buffer: it stays
-- the file, so editing, saving and every other plugin work on it.
--
-- Deleted lines are code, so they keep the old side's syntax colours (from
-- its buffer's treesitter highlights, or its 'syntax' items) on the
-- deletion's ground. DevHub draws a plugin's virtual lines as cells in the
-- grid's face, as the buffer's own, with nothing to declare.

local hunks_mod = require 'incremental_diff.hunks'

local M = {}

M.ns = vim.api.nvim_create_namespace 'incremental_diff_inline'
M.since_ns = vim.api.nvim_create_namespace 'incremental_diff_since'

--- Syntax highlight spans of buf's line row (0-based): { { from, to, group }, ... }.
local function line_spans(buf, row)
  local spans = {}
  local ok, parser = pcall(vim.treesitter.get_parser, buf)
  if ok and parser then
    local lang = parser:lang()
    local query = vim.treesitter.query.get(lang, 'highlights')
    local tree = parser:parse({ row, row + 1 })
    if query and tree then
      parser:for_each_tree(function(t, ltree)
        local q = ltree:lang() == lang and query or vim.treesitter.query.get(ltree:lang(), 'highlights')
        if not q then
          return
        end
        for id, node in q:iter_captures(t:root(), buf, row, row + 1) do
          local sr, sc, er, ec = node:range()
          if sr <= row and er >= row then
            local from = sr < row and 0 or sc
            local to = er > row and math.huge or ec
            local name = q.captures[id]
            if name and not name:match '^_' and name ~= 'spell' and name ~= 'nospell' then
              table.insert(spans, { from, to, '@' .. name .. '.' .. ltree:lang() })
            end
          end
        end
      end)
      return spans
    end
  end
  return M.syntax_spans(buf, row)
end

--- The same from 'syntax' items (no treesitter parser for the language):
--- runs of one syntax group, read with synID in buf.
function M.syntax_spans(buf, row)
  local spans = {}
  if vim.bo[buf].syntax == '' then
    return spans
  end
  vim.api.nvim_buf_call(buf, function()
    local line = vim.fn.getline(row + 1)
    local limit = math.min(#line, 400)
    local from, current = 0, nil
    for col = 1, limit + 1 do
      local name = col <= limit and vim.fn.synIDattr(vim.fn.synIDtrans(vim.fn.synID(row + 1, col, 1)), 'name') or nil
      if name == '' then
        name = nil
      end
      if name ~= current then
        if current then
          table.insert(spans, { from, col - 1, current })
        end
        from, current = col - 1, name
      end
    end
  end)
  return spans
end

--- The chunks of a deleted line: syntax groups over `ground`, with the
--- changed words in `word` (a byte range [from, to)).
local function chunks(line, spans, ground, word, word_hl)
  local cuts = { [0] = true, [#line] = true }
  for _, sp in ipairs(spans) do
    cuts[math.min(sp[1], #line)] = true
    cuts[math.min(sp[2], #line)] = true
  end
  if word then
    cuts[word[1]] = true
    cuts[word[2]] = true
  end
  local points = vim.tbl_keys(cuts)
  table.sort(points)
  local out = {}
  for i = 1, #points - 1 do
    local a, b = points[i], points[i + 1]
    if b > a then
      local groups = { word and a >= word[1] and b <= word[2] and word_hl or ground }
      for _, sp in ipairs(spans) do
        if sp[1] <= a and sp[2] >= b then
          table.insert(groups, sp[3])
        end
      end
      table.insert(out, { line:sub(a + 1, b), groups })
    end
  end
  if #out == 0 then
    out = { { '', ground } }
  end
  return out
end

--- Pad a virtual line to the window's width so its ground is a full band like a diff line's.
local function pad(chunk_list, width)
  local w = 0
  for _, c in ipairs(chunk_list) do
    w = w + vim.fn.strdisplaywidth(c[1])
  end
  if width > w then
    table.insert(chunk_list, { string.rep(' ', width - w), chunk_list[#chunk_list][2] })
  end
  return chunk_list
end

--- Draw old -> buf's current lines on buf. old_buf, when given, is the old
--- side's buffer (for its syntax colours). Answers the hunks.
function M.draw(buf, old_lines, old_buf, width)
  vim.api.nvim_buf_clear_namespace(buf, M.ns, 0, -1)
  local new_lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  local hunks = hunks_mod.compute(old_lines, new_lines)
  width = width or 200
  for _, h in ipairs(hunks) do
    local os, oc, ns, nc = h[1], h[2], h[3], h[4]
    -- Changed lines pair up one to one for their words; the rest are whole.
    local pairs_n = math.min(oc, nc)
    for i = 0, nc - 1 do
      local row = ns - 1 + i
      local group = i < pairs_n and 'IncDiffChange' or 'IncDiffAdd'
      if oc == 0 then
        group = 'IncDiffAdd'
      end
      vim.api.nvim_buf_set_extmark(buf, M.ns, row, 0, { line_hl_group = group, priority = 50 })
      if i < pairs_n and oc > 0 then
        local _, new_word = hunks_mod.words(old_lines[os + i] or '', new_lines[ns + i] or '')
        if new_word[2] > new_word[1] then
          vim.api.nvim_buf_set_extmark(buf, M.ns, row, new_word[1], { end_col = new_word[2], hl_group = 'IncDiffText', priority = 60 })
        end
      end
    end
    if oc > 0 then
      local virt = {}
      for i = 0, oc - 1 do
        local line = old_lines[os + i] or ''
        local spans = old_buf and vim.api.nvim_buf_is_valid(old_buf) and line_spans(old_buf, os + i - 1) or {}
        local word
        if i < pairs_n and nc > 0 then
          word = hunks_mod.words(line, new_lines[ns + i] or '')
          if word[2] <= word[1] then
            word = nil
          end
        end
        table.insert(virt, pad(chunks(line, spans, 'IncDiffDelete', word, 'IncDiffDeleteText'), width))
      end
      -- Above the first line after the deletion; at the end of the file, below the last.
      local below = nc == 0 and ns or ns + nc
      local count = #new_lines
      if nc > 0 then
        vim.api.nvim_buf_set_extmark(buf, M.ns, ns - 1, 0, { virt_lines = virt, virt_lines_above = true })
      elseif below < count then
        vim.api.nvim_buf_set_extmark(buf, M.ns, below, 0, { virt_lines = virt, virt_lines_above = true })
      else
        vim.api.nvim_buf_set_extmark(buf, M.ns, math.max(count - 1, 0), 0, { virt_lines = virt })
      end
    end
  end
  return hunks
end

function M.clear(buf)
  if vim.api.nvim_buf_is_valid(buf) then
    vim.api.nvim_buf_clear_namespace(buf, M.ns, 0, -1)
  end
end

--- Mark buf's lines that differ from snapshot_lines (changed since the file
--- was viewed) with a bar in the sign column. Clears with nil.
function M.mark_since(buf, snapshot_lines)
  if not vim.api.nvim_buf_is_valid(buf) then
    return
  end
  vim.api.nvim_buf_clear_namespace(buf, M.since_ns, 0, -1)
  if not snapshot_lines then
    return
  end
  local new_lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  for _, h in ipairs(hunks_mod.compute(snapshot_lines, new_lines)) do
    local ns, nc = h[3], h[4]
    if nc == 0 then
      local row = math.min(math.max(ns, 1), #new_lines) - 1
      if row >= 0 then
        vim.api.nvim_buf_set_extmark(buf, M.since_ns, row, 0, { sign_text = '▁', sign_hl_group = 'IncDiffSinceViewed', priority = 15 })
      end
    else
      for row = ns - 1, ns + nc - 2 do
        vim.api.nvim_buf_set_extmark(buf, M.since_ns, row, 0, { sign_text = '▎', sign_hl_group = 'IncDiffSinceViewed', priority = 15 })
      end
    end
  end
end

--- The hunk starts (1-based new lines) for ]c / [c in the inline view.
function M.hunk_lines(hunks, count)
  local lines = {}
  for _, h in ipairs(hunks or {}) do
    local ns, nc = h[3], h[4]
    local line = nc == 0 and ns + 1 or ns
    table.insert(lines, math.max(1, math.min(line, count)))
  end
  return lines
end

return M
