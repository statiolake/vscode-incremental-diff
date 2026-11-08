-- The panel: the review's changed files (or a file's commits) as a buffer,
-- one line per item. The lines are plain text you can search and count
-- (`/name`, `5j`); in DevHub's GUI each line is also drawn as a component
-- (gui.view), elsewhere it is that text with highlights.

local M = {}

M.ns = vim.api.nvim_create_namespace 'incremental_diff_panel'

local ok_devhub, devhub = pcall(require, 'devhub')
local gui = ok_devhub and devhub.gui or nil
local ui = gui and gui.ui or nil

local STATUS_HL = {
  A = 'IncDiffStatusAdded',
  M = 'IncDiffStatusModified',
  D = 'IncDiffStatusDeleted',
  R = 'IncDiffStatusRenamed',
  C = 'IncDiffStatusAdded',
  T = 'IncDiffStatusModified',
  U = 'IncDiffStatusConflict',
}
local STATUS_TONE = { A = 'added', M = 'changed', D = 'removed', R = 'info', C = 'added', T = 'changed', U = 'error' }

function M.gui_available()
  return gui ~= nil and gui.available()
end

local function basename(path)
  return path:match '[^/]+$' or path
end

local function dirname(path)
  return path:match '^(.*)/[^/]+$' or ''
end

--- Files as a folder tree (single-child folder chains compacted, folders
--- before files) or a flat list: { { kind = 'dir', path, label, depth, files }
--- | { kind = 'file', file, depth } } in display order.
function M.arrange(files, mode)
  local out = {}
  if mode == 'flat' then
    local sorted = vim.list_slice(files)
    table.sort(sorted, function(a, b)
      return a.path < b.path
    end)
    for _, f in ipairs(sorted) do
      table.insert(out, { kind = 'file', file = f, depth = 0 })
    end
    return out
  end
  local root = { children = {}, dirs = {}, files = {}, all = {} }
  for _, f in ipairs(files) do
    local node = root
    table.insert(node.all, f)
    local dir = dirname(f.path)
    if dir ~= '' then
      for part in dir:gmatch '[^/]+' do
        if not node.dirs[part] then
          node.dirs[part] = { name = part, dirs = {}, files = {}, all = {}, order = {} }
          node.order = node.order or {}
          table.insert(node.order, part)
        end
        node = node.dirs[part]
        table.insert(node.all, f)
      end
    end
    table.insert(node.files, f)
  end
  local function walk(node, prefix, depth)
    local names = vim.list_slice(node.order or {})
    table.sort(names)
    for _, name in ipairs(names) do
      local child = node.dirs[name]
      local label, path = name, prefix == '' and name or prefix .. '/' .. name
      -- Compact a chain of folders that hold one folder and nothing else.
      while #child.files == 0 and #(child.order or {}) == 1 do
        local only = child.order[1]
        child = child.dirs[only]
        label = label .. '/' .. only
        path = path .. '/' .. only
      end
      table.insert(out, { kind = 'dir', path = path, label = label, depth = depth, files = child.all })
      walk(child, path, depth + 1)
    end
    local fs = vim.list_slice(node.files)
    table.sort(fs, function(a, b)
      return basename(a.path) < basename(b.path)
    end)
    for _, f in ipairs(fs) do
      table.insert(out, { kind = 'file', file = f, depth = depth })
    end
  end
  walk(root, '', 0)
  return out
end

local function stat_text(f)
  if f.binary then
    return 'binary'
  end
  if f.added == nil then
    return ''
  end
  local parts = {}
  if f.added > 0 then
    table.insert(parts, '+' .. f.added)
  end
  if f.deleted > 0 then
    table.insert(parts, '−' .. f.deleted)
  end
  return table.concat(parts, ' ')
end

local function checkbox_text(state)
  if state == true then
    return '[x]'
  elseif state == 'mixed' then
    return '[-]'
  end
  return '[ ]'
end

local function dir_state(files)
  local n = 0
  for _, f in ipairs(files) do
    if f.review == 'reviewed' then
      n = n + 1
    end
  end
  if n == #files and n > 0 then
    return true
  end
  return n > 0 and 'mixed' or false
end

--- The entries of a review's panel: { text, hls = { {from, to, group} }, node?, kind, ... }.
function M.file_entries(R)
  local entries = {}
  local files = R.files or {}
  local done, changed = 0, 0
  for _, f in ipairs(files) do
    if f.review == 'reviewed' then
      done = done + 1
    elseif f.review == 'changed' then
      changed = changed + 1
    end
  end
  local title = R.title or ''
  table.insert(entries, {
    kind = 'header',
    text = title,
    hls = { { 0, #title, 'IncDiffTitle' } },
    node = ui and ui.hstack {
      gap = 8,
      pad = { 6, 2 },
      ui.text('Changes', { size = 'lg', bold = true, tone = 'title' }),
      ui.badge(R.key == '' and 'unstaged' or R.key, { mono = true, tone = 'muted' }),
    },
  })
  local summary = ('%d / %d viewed'):format(done, #files)
  if changed > 0 then
    summary = summary .. (' · %d changed since viewed'):format(changed)
  end
  if R.error then
    summary = 'Error: ' .. R.error
  elseif #files == 0 then
    summary = 'No changes.'
  end
  table.insert(entries, {
    kind = 'summary',
    text = summary,
    hls = { { 0, #summary, R.error and 'DiagnosticError' or 'IncDiffDim' } },
    node = ui and ui.stack {
      gap = 2,
      pad = { 2, 2 },
      #files > 0 and not R.error and ui.hstack {
        gap = 10,
        ui.progress(#files > 0 and done / #files or 0, { grow = true }),
        ui.text(('%d / %d viewed'):format(done, #files), { dim = true, size = 'sm' }),
      } or ui.text(summary, { dim = not R.error or nil, tone = R.error and 'error' or nil, wrap = true }),
      (changed > 0 and not R.error) and ui.text(('%d changed since viewed'):format(changed), { size = 'sm', tone = 'warn' }) or ui.spacer(0),
    },
  })
  for _, item in ipairs(M.arrange(files, R.list_mode)) do
    local indent = string.rep('  ', item.depth)
    if item.kind == 'dir' then
      local state = dir_state(item.files)
      local text = indent .. checkbox_text(state) .. ' ' .. item.label .. '/'
      table.insert(entries, {
        kind = 'dir',
        files = item.files,
        text = text,
        hls = { { 0, #text, 'IncDiffDirectory' } },
        node = ui and ui.hstack {
          gap = 8,
          pad = { 3, 2 },
          indent = item.depth * 16,
          ui.checkbox(state, {
            on_click = function()
              require('incremental_diff.review').toggle_viewed_entry(R, { kind = 'dir', files = item.files })
            end,
          }),
          ui.text(item.label, { dim = true, grow = true }),
        },
      })
    else
      local f = item.file
      local name = R.list_mode == 'flat' and f.path or basename(f.path)
      local status = f.untracked and '?' or f.status
      local stat = stat_text(f)
      local note = ''
      if f.review == 'changed' then
        note = '  changed since viewed'
      end
      local old = f.oldPath and ('  ← ' .. f.oldPath) or ''
      local box = checkbox_text(f.review == 'reviewed')
      local text = indent .. box .. ' ' .. status .. ' ' .. name .. old .. (stat ~= '' and ('  ' .. stat) or '') .. note
      local col = #indent
      local hls = {
        { col, col + #box, f.review == 'changed' and 'IncDiffSinceViewed' or 'IncDiffDim' },
        { col + #box + 1, col + #box + 2, STATUS_HL[f.status] or 'IncDiffDim' },
      }
      local name_from = col + #box + 3
      table.insert(hls, { name_from, name_from + #name, f.review == 'reviewed' and 'IncDiffDim' or (f.path == R.current and 'IncDiffCurrent' or 'Normal') })
      if old ~= '' then
        table.insert(hls, { name_from + #name, name_from + #name + #old, 'IncDiffDim' })
      end
      if note ~= '' then
        table.insert(hls, { #text - #note, #text, 'IncDiffSinceViewed' })
      end
      local row
      if ui then
        local label = { { name, strike = f.status == 'D' or nil, bold = f.path == R.current or nil } }
        if f.oldPath then
          table.insert(label, { '  ← ' .. f.oldPath, dim = true, size = 'sm' })
        end
        local right
        if f.review == 'changed' then
          -- Short, so the name keeps its room; the tip and the summary line say the rest.
          right = ui.text('changed', { size = 'xs', tone = 'warn', bold = true, tip = 'Changed since you viewed it' })
        elseif stat ~= '' then
          local runs = {}
          if f.binary then
            runs = { { 'binary', dim = true } }
          else
            if f.added > 0 then
              table.insert(runs, { '+' .. f.added .. ' ', tone = 'added', mono = true })
            end
            if f.deleted > 0 then
              table.insert(runs, { '−' .. f.deleted, tone = 'removed', mono = true })
            end
          end
          right = ui.text(runs, { size = 'xs' })
        else
          right = ui.spacer(0)
        end
        row = ui.hstack {
          gap = 8,
          pad = { 3, 2 },
          indent = item.depth * 16,
          ui.checkbox(f.review == 'reviewed', {
            tone = f.review == 'changed' and 'warn' or nil,
            on_click = function()
              require('incremental_diff.review').toggle_viewed_entry(R, { kind = 'file', file = f })
            end,
          }),
          ui.text(status, { mono = true, bold = true, tone = f.untracked and 'added' or STATUS_TONE[f.status] or 'muted' }),
          ui.text(label, { grow = true, dim = f.review == 'reviewed' or nil }),
          right,
        }
      end
      table.insert(entries, { kind = 'file', file = f, text = text, hls = hls, node = row })
    end
  end
  return entries
end

--- The entries of a file history panel: the commits that touched the file.
function M.history_entries(R)
  local entries = {}
  local title = 'History  ' .. (R.history_path or '')
  table.insert(entries, {
    kind = 'header',
    text = title,
    hls = { { 0, #title, 'IncDiffTitle' } },
    node = ui and ui.hstack {
      gap = 8,
      pad = { 6, 2 },
      ui.text('History', { size = 'lg', bold = true, tone = 'title' }),
      ui.badge(R.history_path or '', { mono = true, tone = 'muted' }),
    },
  })
  if #(R.commits or {}) == 0 then
    table.insert(entries, { kind = 'summary', text = 'No commits.', hls = { { 0, 11, 'IncDiffDim' } }, node = ui and ui.text('No commits.', { dim = true }) })
  end
  for _, c in ipairs(R.commits or {}) do
    local date = (c.date or ''):sub(1, 10)
    local text = c.short .. '  ' .. c.subject .. '  ' .. c.author .. ', ' .. date
    local current = R.current_commit == c.sha
    local hls = {
      { 0, #c.short, 'IncDiffHash' },
      { #c.short + 2, #c.short + 2 + #c.subject, current and 'IncDiffCurrent' or 'Normal' },
      { #c.short + 2 + #c.subject, #text, 'IncDiffDim' },
    }
    table.insert(entries, {
      kind = 'commit',
      commit = c,
      text = text,
      hls = hls,
      node = ui and ui.stack {
        gap = 1,
        pad = { 3, 2 },
        ui.text({ { c.subject, bold = current or nil } }, { wrap = true }),
        ui.text({ { c.short, mono = true, tone = 'keyword' }, { '  ' .. c.author .. ' · ' .. date, dim = true } }, { size = 'sm' }),
      },
    })
  end
  return entries
end

M.FILE_KEYS = {
  { '⏎', 'open' },
  { '␣', 'viewed' },
  { 'Tab', 'next' },
  { 'i', 'inline/split' },
  { 's', 'since viewed' },
  { 't', 'tree/list' },
  { 'q', 'close' },
}
M.HISTORY_KEYS = {
  { '⏎', 'open' },
  { 'Tab', 'next' },
  { 'i', 'inline/split' },
  { 'q', 'close' },
}

--- Write R's panel buffer from its entries (and draw it again in DevHub).
function M.draw(R)
  local buf = R.panel_buf
  if not buf or not vim.api.nvim_buf_is_valid(buf) then
    return
  end
  local entries = R.history_path and M.history_entries(R) or M.file_entries(R)
  R.entries = entries
  local lines = {}
  for _, e in ipairs(entries) do
    table.insert(lines, e.text)
  end
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  vim.bo[buf].modified = false
  vim.api.nvim_buf_clear_namespace(buf, M.ns, 0, -1)
  for i, e in ipairs(entries) do
    for _, h in ipairs(e.hls or {}) do
      local to = math.min(h[2], #e.text)
      if to > h[1] then
        vim.api.nvim_buf_set_extmark(buf, M.ns, i - 1, h[1], { end_col = to, hl_group = h[3] })
      end
    end
  end
  if R.view then
    R.view:update()
  end
end

--- Make the panel's view in DevHub's GUI (a no-op elsewhere).
function M.attach_view(R, win)
  if not M.gui_available() then
    return
  end
  R.view = gui.view {
    buf = R.panel_buf,
    win = win,
    items = function(lnum)
      local e = R.entries and R.entries[lnum]
      return e and e.node or nil
    end,
    on_click = function(lnum)
      local e = R.entries and R.entries[lnum]
      if e and (e.kind == 'file' or e.kind == 'commit') then
        require('incremental_diff.review').open_entry(R, lnum, { focus = false })
      end
    end,
    keys = R.history_path and M.HISTORY_KEYS or M.FILE_KEYS,
  }
end

return M
