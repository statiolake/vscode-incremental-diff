-- A review in a tab page: the panel on the left, the diff on the right —
-- split (two windows in Neovim's own diff mode) or inline (the new side's
-- buffer alone, the diff drawn on it). The state lives in the server; this
-- module asks it, shows what it answers and follows its notifications.

local client = require 'incremental_diff.client'
local content = require 'incremental_diff.content'
local hunks_mod = require 'incremental_diff.hunks'
local inline = require 'incremental_diff.inline'
local keys = require 'incremental_diff.keys'
local panel = require 'incremental_diff.panel'

local M = {}

M.config = {
  width = 40,
  layout = 'split', -- or 'inline'
  list_mode = 'tree', -- or 'flat'
  since_viewed = true, -- a file changed since viewed opens with only those changes
  base_branch = '', -- for :IncDiffBranch; empty: the branch HEAD forked from
  refresh_delay = 200,
  keys = {
    -- In the diff windows (only while they show a review; elsewhere the
    -- keys do what they did). false turns one off.
    next_file = '<Tab>',
    prev_file = '<S-Tab>',
    toggle_layout = 'gL',
    toggle_since = 'gS',
    viewed_next = 'gV',
    next_hunk = ']c', -- the inline view's; split uses diff mode's own
    prev_hunk = '[c',
    close = false,
    focus_panel = false,
  },
}

--- Open reviews by tab page.
M.reviews = {}

local function notify(msg, level)
  vim.notify(msg, level or vim.log.levels.INFO, { title = 'incremental-diff' })
end

local function valid_win(win)
  return win and vim.api.nvim_win_is_valid(win)
end

--- The review of the current tab page (or of tab).
function M.current(tab)
  local R = M.reviews[tab or vim.api.nvim_get_current_tabpage()]
  if R and vim.api.nvim_tabpage_is_valid(R.tab) then
    return R
  end
end

local function by_id(id)
  for _, R in pairs(M.reviews) do
    if R.id == id then
      return R
    end
  end
end

local function file_of(R, path)
  for _, f in ipairs(R.files or {}) do
    if f.path == path then
      return f
    end
  end
end

--- Files in the panel's order.
local function order(R)
  local out = {}
  for _, item in ipairs(panel.arrange(R.files or {}, R.list_mode)) do
    if item.kind == 'file' then
      table.insert(out, item.file)
    end
  end
  return out
end

local function short(sha)
  return (sha or ''):sub(1, 10)
end

-- Sides -----------------------------------------------------------------------

local function side_of(R, side, blob, f, which)
  if (which == 'left' and (f.status == 'A' or not blob) and side.kind ~= 'worktree')
    or (which == 'right' and f.status == 'D') then
    return { kind = 'empty', what = which == 'left' and 'added' or 'deleted', label = which == 'left' and 'Nothing (added)' or 'Nothing (deleted)' }
  end
  if side.kind == 'worktree' then
    return { kind = 'worktree', label = 'Working tree' }
  end
  if not blob then
    return { kind = 'empty', what = 'empty', label = 'Nothing' }
  end
  if side.kind == 'index' then
    return { kind = 'blob', blob = blob, what = 'index:' .. blob:sub(1, 8), label = 'Index' }
  end
  -- A name the person typed, with the commit it is; a bare commit id, short.
  local label = (side.label or ''):gsub('%x%x%x%x%x%x%x+', function(id)
    return id:sub(1, 7)
  end)
  if label == '' then
    label = side.sha:sub(1, 7)
  elseif not label:find(side.sha:sub(1, 7), 1, true) then
    label = label .. ' ' .. side.sha:sub(1, 7)
  end
  return { kind = 'blob', blob = blob, rev = side.sha, what = short(side.sha), label = label }
end

local function ago(iso)
  local y, mo, d, h, mi, s = (iso or ''):match '(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)'
  if not y then
    return ''
  end
  local t = os.time { year = y, month = mo, day = d, hour = h, min = mi, sec = s }
  -- The stamp is UTC; os.time read it as local time.
  local now = os.time(os.date '!*t')
  local secs = math.max(0, now - t)
  if secs < 90 then
    return 'just now'
  elseif secs < 5400 then
    return ('%d min ago'):format(math.floor(secs / 60 + 0.5))
  elseif secs < 129600 then
    return ('%d h ago'):format(math.floor(secs / 3600 + 0.5))
  end
  return ('%d days ago'):format(math.floor(secs / 86400 + 0.5))
end

--- The two sides of f in mode ('full' or 'since').
local function sides(R, f, mode)
  local left = side_of(R, R.left, f.oldBlob, f, 'left')
  local right = side_of(R, R.right, f.newBlob, f, 'right')
  if mode == 'since' and f.snapshot then
    if f.snapshot == 'deleted' then
      left = { kind = 'empty', what = 'viewed-deleted', label = 'Viewed (deleted) ' .. ago(f.reviewedAt) }
    else
      left = { kind = 'blob', blob = f.snapshot, what = 'viewed:' .. f.snapshot:sub(1, 8), label = 'Viewed ' .. ago(f.reviewedAt) }
    end
  end
  return left, right
end

local function mode_for(R, f)
  local mode = R.modes[f.path]
  if mode == nil then
    mode = (M.config.since_viewed and f.review == 'changed' and f.snapshot) and 'since' or 'full'
  end
  if mode == 'since' and not (f.review == 'changed' and f.snapshot) then
    mode = 'full'
  end
  return mode
end

-- Windows -----------------------------------------------------------------------

local function winbar_text(side, extra)
  local esc = function(s)
    return (s:gsub('%%', '%%%%'))
  end
  local tail = side.kind == 'worktree' and '%#IncDiffWinbarDim#  editable' or (side.kind ~= 'worktree' and '%#IncDiffWinbarDim#  read-only' or '')
  return '%#IncDiffWinbarRev# ' .. esc(side.label) .. tail .. (extra and ('%#IncDiffWinbarDim#  ' .. esc(extra)) or '') .. '%*'
end

local function is_diff_win(R, win)
  return win ~= nil and (win == R.wins.left or win == R.wins.right)
end

-- The options the panel sets on its window; a diff window made from it
-- (a split, :tabnew from the panel) gets the person's own values back.
local PANEL_OPTIONS = { 'winfixwidth', 'number', 'relativenumber', 'signcolumn', 'foldcolumn', 'cursorline', 'wrap', 'list', 'spell' }

local function as_editor_window(win)
  for _, name in ipairs(PANEL_OPTIONS) do
    vim.wo[win][name] = vim.go[name]
  end
  vim.wo[win].winbar = ''
end

--- A window of the diff area that is not the panel: the right one, made if needed.
local function ensure_right(R)
  if valid_win(R.wins.right) and vim.api.nvim_win_get_tabpage(R.wins.right) == R.tab then
    return R.wins.right
  end
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(R.tab)) do
    if win ~= R.panel_win and win ~= R.wins.left and vim.api.nvim_win_get_config(win).relative == '' then
      R.wins.right = win
      return win
    end
  end
  -- Only the panel is left: a window beside it.
  vim.api.nvim_win_call(R.panel_win, function()
    vim.cmd 'rightbelow vsplit'
    R.wins.right = vim.api.nvim_get_current_win()
  end)
  as_editor_window(R.wins.right)
  vim.api.nvim_win_set_width(R.panel_win, M.config.width)
  return R.wins.right
end

local function ensure_left(R)
  if valid_win(R.wins.left) and vim.api.nvim_win_get_tabpage(R.wins.left) == R.tab then
    return R.wins.left
  end
  local right = ensure_right(R)
  vim.api.nvim_win_call(right, function()
    vim.cmd 'leftabove vsplit'
    R.wins.left = vim.api.nvim_get_current_win()
  end)
  if valid_win(R.panel_win) then
    vim.api.nvim_win_set_width(R.panel_win, M.config.width)
  end
  return R.wins.left
end

local function diff_off(win)
  if valid_win(win) and vim.wo[win].diff then
    vim.api.nvim_win_call(win, function()
      vim.cmd 'diffoff'
    end)
  end
end

-- Keys in the diff windows ------------------------------------------------------------

local function bind_diff_keys(R, buf)
  local k = M.config.keys
  local active = function()
    return M.current() == R and is_diff_win(R, vim.api.nvim_get_current_win())
  end
  local inline_active = function()
    return active() and R.layout == 'inline' and vim.api.nvim_get_current_win() == R.wins.right
  end
  keys.bind(buf, k.next_file, function()
    M.step(R, 1)
  end, 'next file', active)
  keys.bind(buf, k.prev_file, function()
    M.step(R, -1)
  end, 'previous file', active)
  keys.bind(buf, k.toggle_layout, function()
    M.toggle_layout(R)
  end, 'inline / split', active)
  keys.bind(buf, k.toggle_since, function()
    M.toggle_since(R)
  end, 'changes since viewed / all changes', active)
  keys.bind(buf, k.viewed_next, function()
    M.viewed_and_next(R)
  end, 'mark viewed and open the next file', active)
  keys.bind(buf, k.close, function()
    M.close(R)
  end, 'close the review', active)
  keys.bind(buf, k.focus_panel, function()
    M.focus_panel(R)
  end, 'the file panel', active)
  keys.bind(buf, k.next_hunk, function()
    M.jump_hunk(R, 1)
  end, 'next hunk', inline_active)
  keys.bind(buf, k.prev_hunk, function()
    M.jump_hunk(R, -1)
  end, 'previous hunk', inline_active)
  R.bound[buf] = true
end

local function release(R, buf, keep)
  if keep and keep[buf] then
    return
  end
  if R.bound[buf] then
    keys.unbind_all(buf)
    R.bound[buf] = nil
  end
  inline.clear(buf)
  inline.mark_since(buf, nil)
  if R.watch and R.watch.buf == buf then
    pcall(vim.api.nvim_del_autocmd, R.watch.id)
    R.watch = nil
  end
end

-- Showing a file ------------------------------------------------------------------------

local function first_hunk_line(old_lines, new_lines)
  local h = hunks_mod.compute(old_lines, new_lines)[1]
  if not h then
    return 1
  end
  return math.max(1, math.min(h[4] == 0 and h[3] + 1 or h[3], #new_lines))
end

local function draw_inline(R)
  local s = R.shown
  if not s or R.layout ~= 'inline' or not vim.api.nvim_buf_is_valid(s.right_buf) then
    return
  end
  local width = valid_win(R.wins.right) and vim.api.nvim_win_get_width(R.wins.right) or 200
  s.hunks = inline.draw(s.right_buf, content.lines(s.left_buf), s.left_buf, width)
end

local function draw_since(R)
  local s = R.shown
  if not s or not vim.api.nvim_buf_is_valid(s.right_buf) then
    return
  end
  local f = file_of(R, s.path)
  if f and s.mode == 'full' and f.review == 'changed' and f.snapshot and f.snapshot ~= 'deleted' then
    inline.mark_since(s.right_buf, content.blob_lines(R.root, f.snapshot))
  else
    inline.mark_since(s.right_buf, nil)
  end
end

-- Redraw the inline view and the since-viewed marks as the work tree's buffer is edited.
local function watch_edits(R, buf)
  if R.watch and R.watch.buf == buf then
    return
  end
  if R.watch then
    pcall(vim.api.nvim_del_autocmd, R.watch.id)
  end
  local timer
  local id = vim.api.nvim_create_autocmd({ 'TextChanged', 'TextChangedI' }, {
    buffer = buf,
    callback = function()
      if timer then
        timer:stop()
      end
      timer = vim.defer_fn(function()
        if R.shown and R.shown.right_buf == buf then
          draw_inline(R)
          draw_since(R)
        end
      end, 120)
    end,
  })
  R.watch = { buf = buf, id = id }
end

--- Lay out the diff of R.shown in R.layout.
local function apply_layout(R)
  local s = R.shown
  if not s then
    return
  end
  local right = ensure_right(R)
  if R.layout == 'split' then
    local left = ensure_left(R)
    diff_off(left)
    diff_off(right)
    vim.api.nvim_win_set_buf(left, s.left_buf)
    vim.api.nvim_win_set_buf(right, s.right_buf)
    inline.clear(s.right_buf)
    for _, win in ipairs { left, right } do
      vim.api.nvim_win_call(win, function()
        vim.cmd 'diffthis'
      end)
    end
    vim.wo[left].winbar = winbar_text(s.left_side)
    vim.wo[right].winbar = winbar_text(s.right_side)
  else
    if valid_win(R.wins.left) then
      diff_off(R.wins.left)
      if #vim.api.nvim_tabpage_list_wins(R.tab) > 2 then
        vim.api.nvim_win_close(R.wins.left, true)
      end
    end
    R.wins.left = nil
    diff_off(right)
    vim.api.nvim_win_set_buf(right, s.right_buf)
    vim.wo[right].winbar = winbar_text(s.right_side, '← ' .. s.left_side.label .. '  · inline')
    draw_inline(R)
  end
  draw_since(R)
  if valid_win(R.panel_win) then
    vim.api.nvim_win_set_width(R.panel_win, M.config.width)
  end
end

--- Show f's diff. opts: focus (move into the diff), line (cursor on the new side).
function M.show(R, f, opts)
  opts = opts or {}
  local mode = mode_for(R, f)
  local left_side, right_side = sides(R, f, mode)
  local left_buf = content.side_buffer(R.root, f.oldPath and left_side.kind ~= 'empty' and mode ~= 'since' and f.oldPath or f.path, left_side)
  local right_buf = content.side_buffer(R.root, f.path, right_side)
  local previous = R.shown
  R.shown = {
    path = f.path,
    mode = mode,
    left_buf = left_buf,
    right_buf = right_buf,
    left_side = left_side,
    right_side = right_side,
    signature = M.signature(R, f, mode),
  }
  R.current = f.path
  if previous then
    local keep = { [left_buf] = true, [right_buf] = true }
    release(R, previous.left_buf, keep)
    release(R, previous.right_buf, keep)
  end
  bind_diff_keys(R, left_buf)
  bind_diff_keys(R, right_buf)
  if right_side.kind == 'worktree' then
    watch_edits(R, right_buf)
  end
  apply_layout(R)
  -- The cursor: where asked, else the first hunk.
  local line = opts.line or first_hunk_line(content.lines(left_buf), content.lines(right_buf))
  local right = R.wins.right
  line = math.max(1, math.min(line, vim.api.nvim_buf_line_count(right_buf)))
  vim.api.nvim_win_set_cursor(right, { line, 0 })
  if opts.view then
    vim.api.nvim_win_call(right, function()
      vim.fn.winrestview { topline = math.max(1, line - opts.view), lnum = line }
    end)
  else
    vim.api.nvim_win_call(right, function()
      vim.cmd 'normal! zz'
    end)
  end
  if opts.focus then
    vim.api.nvim_set_current_win(right)
  end
  content.wipe_unshown { [left_buf] = true, [right_buf] = true }
  panel.draw(R)
  M.follow_panel(R)
end

--- What decides whether a shown file must be loaded again after a refresh.
function M.signature(R, f, mode)
  return table.concat({ mode, f.status, f.oldBlob or '', R.right.kind == 'worktree' and 'wt' or (f.newBlob or ''), f.snapshot or '', f.review }, ':')
end

--- Move the panel's cursor to the shown file.
function M.follow_panel(R)
  if not valid_win(R.panel_win) or not R.entries then
    return
  end
  for i, e in ipairs(R.entries) do
    if (e.kind == 'file' and e.file.path == R.current) or (e.kind == 'commit' and e.commit.sha == R.current_commit) then
      vim.api.nvim_win_set_cursor(R.panel_win, { i, 0 })
      return
    end
  end
end

-- Moving between files and hunks ----------------------------------------------------

--- Open the file (or commit) of the panel's line lnum.
function M.open_entry(R, lnum, opts)
  local e = R.entries and R.entries[lnum]
  if not e then
    return
  end
  if e.kind == 'file' then
    M.show(R, e.file, opts)
  elseif e.kind == 'commit' then
    M.open_commit(R, e.commit, opts)
  elseif e.kind == 'dir' then
    M.toggle_viewed_entry(R, e)
  end
end

function M.step(R, delta)
  if R.history_path then
    local commits = R.commits or {}
    for i, c in ipairs(commits) do
      if c.sha == R.current_commit then
        local next = commits[i + delta]
        if next then
          M.open_commit(R, next, { focus = is_diff_win(R, vim.api.nvim_get_current_win()) })
        end
        return
      end
    end
    return
  end
  local files = order(R)
  if #files == 0 then
    return
  end
  local index = 0
  for i, f in ipairs(files) do
    if f.path == R.current then
      index = i
    end
  end
  local target = files[((index - 1 + delta) % #files) + 1]
  M.show(R, target, { focus = is_diff_win(R, vim.api.nvim_get_current_win()) })
end

--- ]c / [c in the inline view: the next / previous hunk's first line.
function M.jump_hunk(R, delta)
  local s = R.shown
  if not s or not s.hunks then
    return
  end
  local win = vim.api.nvim_get_current_win()
  local cur = vim.api.nvim_win_get_cursor(win)[1]
  local lines = inline.hunk_lines(s.hunks, vim.api.nvim_buf_line_count(s.right_buf))
  local count = vim.v.count1
  local target
  if delta > 0 then
    for _, l in ipairs(lines) do
      if l > cur then
        count = count - 1
        target = l
        if count == 0 then
          break
        end
      end
    end
  else
    for i = #lines, 1, -1 do
      if lines[i] < cur then
        count = count - 1
        target = lines[i]
        if count == 0 then
          break
        end
      end
    end
  end
  if target then
    vim.cmd "normal! m'"
    vim.api.nvim_win_set_cursor(win, { target, 0 })
  end
end

-- Layout and mode ------------------------------------------------------------------------

--- Where the cursor is, as a line of the new side and its distance from the window's top.
local function position(R)
  local s = R.shown
  local win = vim.api.nvim_get_current_win()
  local source = is_diff_win(R, win) and win or R.wins.right
  if not valid_win(source) then
    return nil
  end
  local view = vim.api.nvim_win_call(source, vim.fn.winsaveview)
  local line = view.lnum
  if source == R.wins.left and s then
    local h = hunks_mod.compute(content.lines(s.left_buf), content.lines(s.right_buf))
    line = hunks_mod.old_to_new(h, line)
  end
  return { line = line, offset = view.lnum - view.topline, focus = is_diff_win(R, win) }
end

--- Split ⇄ inline, on the same file at the same line.
function M.toggle_layout(R)
  R = R or M.current()
  if not R then
    return
  end
  local pos = position(R)
  R.layout = R.layout == 'split' and 'inline' or 'split'
  if not R.shown then
    return
  end
  apply_layout(R)
  if pos then
    local right = R.wins.right
    local line = math.max(1, math.min(pos.line, vim.api.nvim_buf_line_count(R.shown.right_buf)))
    vim.api.nvim_win_call(right, function()
      vim.fn.winrestview { lnum = line, col = 0, topline = math.max(1, line - pos.offset) }
    end)
    if pos.focus then
      vim.api.nvim_set_current_win(right)
    end
  end
  panel.draw(R)
end

--- Changes since viewed ⇄ all changes, for the shown file.
function M.toggle_since(R)
  R = R or M.current()
  local f = R and R.shown and file_of(R, R.shown.path)
  if not f then
    return
  end
  if not (f.review == 'changed' and f.snapshot) then
    notify(f.path .. ' has not changed since it was viewed.')
    return
  end
  R.modes[f.path] = R.shown.mode == 'since' and 'full' or 'since'
  local pos = position(R)
  M.show(R, f, { line = pos and pos.line, view = pos and pos.offset, focus = pos and pos.focus })
end

-- Viewed -------------------------------------------------------------------------------------

local function apply_state(R, state)
  R.title, R.key, R.left, R.right, R.files, R.error = state.title, state.key, state.left, state.right, state.files or {}, state.error
end

--- After the server answered with state: draw the panel, and show the current file again if it changed.
local function update(R, state)
  apply_state(R, state)
  panel.draw(R)
  if R.shown then
    local f = file_of(R, R.shown.path)
    if f and M.signature(R, f, mode_for(R, f)) ~= R.shown.signature then
      local pos = position(R)
      M.show(R, f, { line = pos and pos.line, view = pos and pos.offset, focus = pos and pos.focus })
    elseif f then
      draw_since(R)
    end
  end
end

function M.set_viewed(R, paths, viewed, after)
  if #paths == 0 then
    return
  end
  client.request('review/setReviewed', { id = R.id, paths = paths, reviewed = viewed }, function(err, state)
    if err then
      return notify(err, vim.log.levels.ERROR)
    end
    if state.warning then
      notify(state.warning, vim.log.levels.WARN)
    end
    update(R, state)
    if after then
      after()
    end
  end)
end

--- <Space> in the panel: a file's mark, or every file of a folder.
function M.toggle_viewed_entry(R, e)
  if R.history_path then
    return
  end
  if e.kind == 'file' then
    M.set_viewed(R, { e.file.path }, e.file.review ~= 'reviewed')
  elseif e.kind == 'dir' then
    local all = true
    for _, f in ipairs(e.files) do
      all = all and f.review == 'reviewed'
    end
    local paths = {}
    for _, f in ipairs(e.files) do
      if all or f.review ~= 'reviewed' then
        table.insert(paths, f.path)
      end
    end
    M.set_viewed(R, paths, not all)
  end
end

--- Mark the shown file viewed and open the next file to review.
function M.viewed_and_next(R)
  R = R or M.current()
  if not R or not R.current or R.history_path then
    return
  end
  local path = R.current
  local focus = is_diff_win(R, vim.api.nvim_get_current_win())
  M.set_viewed(R, { path }, true, function()
    local files = order(R)
    local start = 0
    for i, f in ipairs(files) do
      if f.path == path then
        start = i
      end
    end
    for step = 1, #files do
      local f = files[((start - 1 + step) % #files) + 1]
      if f.review ~= 'reviewed' and f.path ~= path then
        return M.show(R, f, { focus = focus })
      end
    end
    notify 'Every file is viewed.'
  end)
end

-- Refreshing --------------------------------------------------------------------------

function M.refresh(R)
  if R.history_path and not R.id then
    return
  end
  if R.refresh_timer then
    R.refresh_timer:stop()
  end
  R.refresh_timer = vim.defer_fn(function()
    R.refresh_timer = nil
    if not R.id then
      return
    end
    client.request('review/refresh', { id = R.id }, function(err, state)
      if err then
        return notify(err, vim.log.levels.WARN)
      end
      if M.reviews[R.tab] == R then
        update(R, state)
      end
    end)
  end, M.config.refresh_delay)
end

client.on('review/changed', function(state)
  local R = by_id(state.id)
  if R and M.reviews[R.tab] == R then
    update(R, state)
  end
end)

local group = vim.api.nvim_create_augroup('incremental_diff', { clear = true })

vim.api.nvim_create_autocmd('BufWritePost', {
  group = group,
  callback = function(ev)
    local name = vim.api.nvim_buf_get_name(ev.buf)
    for _, R in pairs(M.reviews) do
      if name:sub(1, #R.root + 1) == R.root .. '/' then
        M.refresh(R)
      end
    end
  end,
})

vim.api.nvim_create_autocmd({ 'FocusGained', 'ShellCmdPost', 'TermLeave' }, {
  group = group,
  callback = function()
    for _, R in pairs(M.reviews) do
      M.refresh(R)
    end
  end,
})

vim.api.nvim_create_autocmd('TabClosed', {
  group = group,
  callback = function()
    for tab, R in pairs(M.reviews) do
      if not vim.api.nvim_tabpage_is_valid(tab) then
        M.cleanup(R)
      end
    end
  end,
})

-- The panel --------------------------------------------------------------------------------

local function panel_keys(R)
  local buf = R.panel_buf
  local map = function(lhs, fn, desc)
    vim.keymap.set('n', lhs, fn, { buffer = buf, nowait = true, silent = true, desc = 'incremental-diff: ' .. desc })
  end
  local lnum = function()
    return vim.api.nvim_win_get_cursor(0)[1]
  end
  map('<CR>', function()
    M.open_entry(R, lnum(), { focus = true })
  end, 'open the diff')
  map('o', function()
    M.open_entry(R, lnum(), { focus = false })
  end, 'show the diff, staying here')
  map('<2-LeftMouse>', function()
    M.open_entry(R, lnum(), { focus = true })
  end, 'open the diff')
  map('<Space>', function()
    local e = R.entries[lnum()]
    if e then
      M.toggle_viewed_entry(R, e)
    end
  end, 'viewed')
  map('<Tab>', function()
    M.step(R, 1)
  end, 'next file')
  map('<S-Tab>', function()
    M.step(R, -1)
  end, 'previous file')
  map('i', function()
    M.toggle_layout(R)
  end, 'inline / split')
  map('s', function()
    M.toggle_since(R)
  end, 'changes since viewed / all changes')
  map('t', function()
    R.list_mode = R.list_mode == 'tree' and 'flat' or 'tree'
    panel.draw(R)
    M.follow_panel(R)
  end, 'tree / list')
  map('R', function()
    M.refresh(R)
  end, 'refresh')
  map('X', function()
    if vim.fn.confirm('Clear every viewed mark of this review?', '&Clear\n&Cancel', 2) == 1 then
      client.request('review/clearReviewed', { id = R.id }, function(err, state)
        if err then
          return notify(err, vim.log.levels.ERROR)
        end
        update(R, state)
      end)
    end
  end, 'clear viewed marks')
  map('q', function()
    M.close(R)
  end, 'close the review')
  for _, k in ipairs { M.config.keys.toggle_layout, M.config.keys.toggle_since, M.config.keys.viewed_next } do
    if k then
      local fn = k == M.config.keys.toggle_layout and M.toggle_layout or k == M.config.keys.toggle_since and M.toggle_since or M.viewed_and_next
      map(k, function()
        fn(R)
      end, 'as in the diff')
    end
  end
end

local function make_panel(R)
  local buf = vim.api.nvim_create_buf(false, true)
  -- The name's tail is what a tab line shows for the panel.
  vim.api.nvim_buf_set_name(buf, ('incdiff://panel-%d/%s'):format(R.serial, R.history_path and 'History' or 'Changes'))
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].modifiable = false
  vim.bo[buf].filetype = 'incremental-diff-panel'
  R.panel_buf = buf
  panel_keys(R)
end

local function panel_window(R)
  vim.cmd(('topleft vertical %dsplit'):format(M.config.width))
  local win = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(win, R.panel_buf)
  local wo = vim.wo[win]
  wo.winfixwidth = true
  wo.number = false
  wo.relativenumber = false
  wo.signcolumn = 'no'
  wo.foldcolumn = '0'
  wo.cursorline = true
  wo.wrap = false
  wo.list = false
  wo.spell = false
  wo.winbar = ''
  R.panel_win = win
  panel.attach_view(R, win)
  return win
end

--- Focus the panel of the review in this tab page (made again if closed).
--- Answers false when this tab page shows no review (for a key's fallback).
function M.focus_panel(R)
  R = R or M.current()
  if not R then
    return false
  end
  if not valid_win(R.panel_win) then
    local back = vim.api.nvim_get_current_win()
    panel_window(R)
    panel.draw(R)
    if valid_win(back) then
      vim.api.nvim_set_current_win(R.panel_win)
    end
  end
  vim.api.nvim_set_current_win(R.panel_win)
  M.follow_panel(R)
  return true
end

-- Opening and closing ------------------------------------------------------------------------

local serial = 0

local function new_tab(R)
  serial = serial + 1
  R.serial = serial
  vim.cmd 'tabnew'
  R.tab = vim.api.nvim_get_current_tabpage()
  local placeholder = vim.api.nvim_get_current_buf()
  vim.bo[placeholder].bufhidden = 'wipe'
  R.wins.right = vim.api.nvim_get_current_win()
  as_editor_window(R.wins.right)
  make_panel(R)
  panel_window(R)
  M.reviews[R.tab] = R
end

local function find_open(root, key, history_path)
  for _, R in pairs(M.reviews) do
    if vim.api.nvim_tabpage_is_valid(R.tab) and R.root == root and (history_path and R.history_path == history_path or (not history_path and not R.history_path and R.key == key)) then
      return R
    end
  end
end

local function new_review(fields)
  return vim.tbl_extend('force', {
    wins = {},
    modes = {},
    bound = {},
    layout = M.config.layout,
    list_mode = M.config.list_mode,
  }, fields)
end

--- Open (or focus) a review. opts: { root?, input? | branch = true }.
function M.open(opts)
  opts = opts or {}
  local root = opts.root or vim.fn.getcwd()
  local params = { root = root, stats = true }
  if opts.branch then
    params.branch = true
    params.baseBranch = opts.base or M.config.base_branch
  else
    params.input = opts.input or ''
  end
  client.request('review/open', params, function(err, state)
    if err then
      return notify(err, vim.log.levels.ERROR)
    end
    local existing = find_open(state.root, state.key)
    if existing then
      client.request('review/close', { id = state.id }, function() end)
      vim.api.nvim_set_current_tabpage(existing.tab)
      M.refresh(existing)
      return
    end
    local R = new_review { id = state.id, root = state.root }
    apply_state(R, state)
    new_tab(R)
    panel.draw(R)
    -- The first file to review, as the panel lists them.
    local first
    for _, f in ipairs(order(R)) do
      first = first or f
      if f.review ~= 'reviewed' then
        first = f
        break
      end
    end
    if first then
      M.show(R, first, { focus = false })
    end
    vim.api.nvim_set_current_win(R.panel_win)
    M.follow_panel(R)
  end)
end

--- A file's history: the commits that touched path (default: the current
--- buffer's file), each opened as that commit's change to the file.
function M.open_history(path)
  path = path and path ~= '' and vim.fn.fnamemodify(path, ':p') or vim.api.nvim_buf_get_name(0)
  if path == '' or content.is_ours(vim.fn.bufnr()) and not path:match '^/' then
    local info = vim.b.incremental_diff
    if info then
      path = info.root .. '/' .. info.path
    end
  end
  if path == '' then
    return notify('No file to show the history of.', vim.log.levels.WARN)
  end
  local dir = vim.fn.fnamemodify(path, ':h')
  local root = vim.fn.systemlist({ 'git', '-C', dir, 'rev-parse', '--show-toplevel' })[1]
  if vim.v.shell_error ~= 0 or not root then
    return notify(path .. ' is not in a git work tree.', vim.log.levels.ERROR)
  end
  root = vim.uv.fs_realpath(root) or root
  local real = vim.uv.fs_realpath(path) or path
  local rel = real:sub(#root + 2)
  local existing = find_open(root, nil, rel)
  if existing then
    vim.api.nvim_set_current_tabpage(existing.tab)
    return
  end
  client.request('git/log', { root = root, path = rel, limit = 500 }, function(err, commits)
    if err then
      return notify(err, vim.log.levels.ERROR)
    end
    local R = new_review { root = root, history_path = rel, commits = commits, files = {}, title = 'History ' .. rel, key = '' }
    new_tab(R)
    panel.draw(R)
    if commits[1] then
      M.open_commit(R, commits[1], { focus = false })
    end
    vim.api.nvim_set_current_win(R.panel_win)
    M.follow_panel(R)
  end)
end

--- In a history: show commit's change to the file.
function M.open_commit(R, commit, opts)
  local previous = R.id
  client.request('review/open', { root = R.root, input = commit.sha .. '^! -- ' .. vim.fn.shellescape(commit.path), stats = false }, function(err, state)
    if err then
      -- A root commit has no parent to compare with: show the file as added.
      if err:match 'Unknown revision' then
        return notify(commit.short .. ' is the first commit of ' .. commit.path .. '.', vim.log.levels.INFO)
      end
      return notify(err, vim.log.levels.ERROR)
    end
    if previous then
      client.request('review/close', { id = previous }, function() end)
    end
    R.id = state.id
    R.current_commit = commit.sha
    local title, key = R.title, R.key
    apply_state(R, state)
    R.title, R.key = title, key
    local f = file_of(R, commit.path) or R.files[1]
    if f then
      M.show(R, f, opts)
    else
      panel.draw(R)
    end
  end)
end

--- Close a review: its tab page, its keys and marks on your buffers, its scratch buffers.
function M.close(R)
  R = R or M.current()
  if not R then
    return
  end
  if vim.api.nvim_tabpage_is_valid(R.tab) then
    if #vim.api.nvim_list_tabpages() == 1 then
      vim.cmd 'tabnew'
    end
    local tabnr = vim.api.nvim_tabpage_get_number(R.tab)
    vim.cmd('tabclose ' .. tabnr)
  end
  M.cleanup(R)
end

function M.cleanup(R)
  if R.closed then
    return
  end
  R.closed = true
  for tab, r in pairs(M.reviews) do
    if r == R then
      M.reviews[tab] = nil
    end
  end
  for buf in pairs(R.bound) do
    release(R, buf)
  end
  if R.shown then
    release(R, R.shown.right_buf)
    release(R, R.shown.left_buf)
  end
  if R.id then
    client.request('review/close', { id = R.id }, function() end)
  end
  if R.view then
    pcall(function()
      R.view:close()
    end)
  end
  if R.panel_buf and vim.api.nvim_buf_is_valid(R.panel_buf) then
    pcall(vim.api.nvim_buf_delete, R.panel_buf, { force = true })
  end
  vim.schedule(function()
    content.wipe_unshown()
  end)
end

return M
