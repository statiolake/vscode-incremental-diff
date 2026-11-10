-- nvim --headless: the Neovim frontend against the core (bin/) and a
-- throwaway repository. Run by test/nvim/run.sh; leaves Neovim with an
-- error on failure.
local failures = {}
local function check(cond, msg)
  if not cond then
    table.insert(failures, msg)
    io.stderr:write('not ok: ' .. msg .. '\n')
  end
end
local function wait(pred, what)
  local ok = vim.wait(8000, pred, 20)
  check(ok, 'timed out waiting for ' .. what)
  return ok
end
local function sh(cmd, cwd)
  local out = vim.fn.system(cmd)
  assert(vim.v.shell_error == 0, table.concat(cmd, ' ') .. ': ' .. out)
  return out
end

local tmp = vim.fn.fnamemodify(vim.fn.tempname(), ':h')
local root = vim.uv.fs_realpath(tmp) .. '/incdiff-spec-' .. vim.fn.getpid()
vim.fn.mkdir(root .. '/src', 'p')
local function write(path, lines)
  vim.fn.writefile(lines, root .. '/' .. path)
end
local git = function(...)
  return sh(vim.list_extend({ 'git', '-C', root }, { ... }))
end
git('init', '-q', '-b', 'main')
git('config', 'user.email', 't@e')
git('config', 'user.name', 't')
git('config', 'commit.gpgsign', 'false')
write('a.lua', { 'local a = 1', 'local b = 2', 'local c = 3', 'return a' })
write('src/gone.txt', { 'bye' })
git('add', '-A')
git('commit', '-q', '-m', 'base')
write('a.lua', { 'local a = 1', 'local b = 20', 'local c = 3', 'local d = 4', 'return a' })
vim.fn.delete(root .. '/src/gone.txt')
write('src/new.txt', { 'hello' })

vim.cmd('cd ' .. root)
-- A buffer map of the person's own on a file: shadowed during the review, back after.
vim.cmd('edit ' .. root .. '/a.lua')
vim.keymap.set('n', 'gS', '<Nop>', { buffer = 0, desc = 'mine' })
vim.cmd 'enew'
local idiff = require('incremental_diff').setup {}
-- IncDiffDeleteText: a stronger red than DiffDelete, recomputed per colorscheme.
local function hl(name)
  return vim.api.nvim_get_hl(0, { name = name, link = false })
end
vim.cmd 'highlight clear'
vim.api.nvim_set_hl(0, 'Normal', { bg = 0x121314 })
vim.api.nvim_set_hl(0, 'DiffDelete', { fg = 0xeeeeee, bg = 0x341b1b })
vim.api.nvim_exec_autocmds('ColorScheme', {})
check(hl('IncDiffDeleteText').bg == 0x562322, 'DiffDelete\'s step from Normal, doubled: ' .. string.format('%06x', hl('IncDiffDeleteText').bg or 0))
check(hl('IncDiffDeleteText').fg == 0xeeeeee, 'DiffDelete\'s colour kept')
check(vim.api.nvim_get_hl(0, { name = 'IncDiffText' }).link == 'DiffText', 'IncDiffText still DiffText')
vim.cmd 'highlight clear'
vim.api.nvim_set_hl(0, 'Normal', { bg = 0x000000 })
vim.api.nvim_set_hl(0, 'DiffDelete', { fg = 0xff0000, bold = true })
vim.api.nvim_exec_autocmds('ColorScheme', {})
check(hl('IncDiffDeleteText').bg == 0x400000 and hl('IncDiffDeleteText').bold, 'no ground: a quarter of its colour, bold kept')
vim.cmd 'highlight clear'
vim.api.nvim_set_hl(0, 'IncDiffDeleteText', { bg = 0x123456 })
vim.api.nvim_exec_autocmds('ColorScheme', {})
check(hl('IncDiffDeleteText').bg == 0x123456, 'a colorscheme\'s own IncDiffDeleteText wins')
vim.cmd 'highlight clear'
vim.api.nvim_exec_autocmds('ColorScheme', {})
-- The changed word: on the deleted line IncDiffDeleteText, on the new one IncDiffText.
do
  local inline = require 'incremental_diff.inline'
  local b = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(b, 0, -1, false, { 'say goodbye now' })
  inline.draw(b, { 'say hello now' }, nil, 20)
  local del_word, add_word
  for _, m in ipairs(vim.api.nvim_buf_get_extmarks(b, inline.ns, 0, -1, { details = true })) do
    for _, vl in ipairs(m[4].virt_lines or {}) do
      for _, chunk in ipairs(vl) do
        local groups = type(chunk[2]) == 'table' and chunk[2] or { chunk[2] }
        if vim.tbl_contains(groups, 'IncDiffDeleteText') then
          del_word = chunk[1]
        end
      end
    end
    if m[4].hl_group == 'IncDiffText' then
      add_word = vim.api.nvim_buf_get_text(b, m[2], m[3], m[4].end_row or m[2], m[4].end_col, {})[1]
    end
  end
  check(del_word == 'hello', 'the deleted word in IncDiffDeleteText: ' .. tostring(del_word))
  check(add_word == 'goodbye', 'the added word in IncDiffText: ' .. tostring(add_word))
  vim.api.nvim_buf_delete(b, { force = true })
end
local review = require 'incremental_diff.review'
idiff.open 'HEAD'
wait(function()
  return review.current() and review.current().shown ~= nil
end, 'the review to open')
local R = review.current()
check(#vim.api.nvim_list_tabpages() == 2, 'a tab page of its own')
check(#R.files == 3, 'three files: ' .. #R.files)
-- Folders come first, as the tree shows them.
check(R.current == 'src/gone.txt', 'the first file shown: ' .. tostring(R.current))
for _, f in ipairs(R.files) do
  if f.path == 'a.lua' then
    review.show(R, f, { focus = false })
  end
end
-- The panel is text you can search.
local panel_lines = vim.api.nvim_buf_get_lines(R.panel_buf, 0, -1, false)
check(vim.tbl_contains(panel_lines, '[ ] M a.lua  +2 −1'), 'panel line for a.lua: ' .. vim.inspect(panel_lines))
check(vim.api.nvim_get_current_win() == R.panel_win, 'the panel has the cursor')
check(vim.api.nvim_win_get_cursor(R.panel_win)[1] == #panel_lines, 'the panel follows the shown file')

-- Split: native diff mode, the work tree's own buffer on the right.
local left, right = R.wins.left, R.wins.right
check(vim.wo[left].diff and vim.wo[right].diff, 'both windows in diff mode')
local rbuf = vim.api.nvim_win_get_buf(right)
check(vim.api.nvim_buf_get_name(rbuf) == root .. '/a.lua', 'right is the real file: ' .. vim.api.nvim_buf_get_name(rbuf))
local lbuf = vim.api.nvim_win_get_buf(left)
check(vim.api.nvim_buf_get_name(lbuf):match '^incdiff://%x+/a.lua$', 'left is a revision buffer: ' .. vim.api.nvim_buf_get_name(lbuf))
check(vim.bo[lbuf].readonly and not vim.bo[lbuf].modifiable and vim.bo[lbuf].filetype == 'lua', 'left is read-only lua')
check(vim.api.nvim_win_get_cursor(right)[1] == 2, 'cursor on the first hunk')
check(vim.wo[left].winbar:match 'HEAD' ~= nil, 'left winbar names the revision: ' .. vim.wo[left].winbar)

-- ]c works natively in split.
vim.api.nvim_set_current_win(right)
vim.cmd 'normal! gg'
vim.cmd 'normal ]c'
check(vim.api.nvim_win_get_cursor(right)[1] == 2, ']c in split')

-- Editing the work tree in split view.
vim.api.nvim_buf_set_lines(rbuf, 0, 1, false, { 'local a = 10' })
vim.cmd 'silent write'
check(vim.fn.readfile(root .. '/a.lua')[1] == 'local a = 10', 'edits are saved to the file')

-- Toggle to inline at the same line.
vim.api.nvim_win_set_cursor(right, { 4, 0 })
review.toggle_layout(R)
check(R.layout == 'inline' and not vim.wo[R.wins.right].diff, 'inline: no diff mode')
check(#vim.api.nvim_tabpage_list_wins(R.tab) == 2, 'inline: panel and one window')
check(vim.api.nvim_win_get_buf(R.wins.right) == rbuf, 'inline shows the same buffer')
check(vim.api.nvim_win_get_cursor(R.wins.right)[1] == 4, 'inline keeps the line')
local inline = require 'incremental_diff.inline'
local marks = vim.api.nvim_buf_get_extmarks(rbuf, inline.ns, 0, -1, { details = true })
local virt, lines_hl = 0, 0
for _, m in ipairs(marks) do
  if m[4].virt_lines then
    virt = virt + #m[4].virt_lines
  end
  -- A whole line's colour: a range to the next line's start, to the end of the line.
  if m[4].hl_eol and (m[4].hl_group == 'IncDiffChange' or m[4].hl_group == 'IncDiffAdd') then
    lines_hl = lines_hl + 1
  end
end
check(virt == 2, 'two deleted lines as virtual lines: ' .. virt)
check(lines_hl == 3, 'three changed or added lines decorated: ' .. lines_hl)
vim.api.nvim_set_current_win(R.wins.right)
vim.cmd 'normal! gg'
vim.cmd 'normal ]c'
check(vim.api.nvim_win_get_cursor(R.wins.right)[1] == 4, 'inline ]c to the next hunk: ' .. vim.api.nvim_win_get_cursor(R.wins.right)[1])
vim.cmd 'normal [c'
check(vim.api.nvim_win_get_cursor(R.wins.right)[1] == 1, 'inline [c back')
-- Edits redraw the inline diff.
vim.api.nvim_buf_set_lines(rbuf, 0, 1, false, { 'local a = 1' })
vim.api.nvim_exec_autocmds('TextChanged', { buffer = rbuf })
wait(function()
  local n = 0
  for _, m in ipairs(vim.api.nvim_buf_get_extmarks(rbuf, inline.ns, 0, -1, { details = true })) do
    if m[4].virt_lines then
      n = n + #m[4].virt_lines
    end
  end
  return n == 1
end, 'the inline diff to follow an edit')
vim.cmd 'silent write'

-- Back to split, and from the left side to inline.
review.toggle_layout(R)
check(R.layout == 'split' and vim.wo[R.wins.left].diff, 'split again')
vim.api.nvim_set_current_win(R.wins.left)
vim.api.nvim_win_set_cursor(R.wins.left, { 3, 0 })
review.toggle_layout(R)
check(vim.api.nvim_win_get_cursor(R.wins.right)[1] == 3, 'the left line maps to the new side')
review.toggle_layout(R)

-- g<Space> in a diff window: the shown file's mark, on and off, the diff stays.
vim.api.nvim_set_current_win(R.wins.right)
local shown_before = R.current
vim.api.nvim_feedkeys(vim.keycode 'g<Space>', 'x', false)
wait(function()
  return R.files[1].review == 'reviewed'
end, 'g<Space> marks the shown file viewed')
check(R.current == shown_before, 'g<Space> keeps the file shown')
vim.api.nvim_feedkeys(vim.keycode 'g<Space>', 'x', false)
wait(function()
  return R.files[1].review ~= 'reviewed'
end, 'g<Space> again takes the mark off')

-- Viewed, then changed since viewed.
review.set_viewed(R, { 'a.lua' }, true)
wait(function()
  return R.files[1].review == 'reviewed'
end, 'a.lua viewed')
check(vim.api.nvim_buf_get_lines(R.panel_buf, -2, -1, false)[1]:match '^%[x%] M a.lua' ~= nil, 'panel ticks it')
write('a.lua', { 'local a = 1', 'local b = 20', 'local c = 3', 'local d = 4', 'local e = 5', 'return a' })
vim.cmd 'checktime'
review.refresh(R)
wait(function()
  return R.files[1].review == 'changed'
end, 'a.lua changed since viewed')
wait(function()
  return R.shown and R.shown.mode == 'since'
end, 'the shown file switches to since-viewed')
check(vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(R.wins.left)):match '^incdiff://viewed:' ~= nil, 'left is the snapshot')
review.toggle_since(R)
check(R.shown.mode == 'full', 'all changes again')
local since = vim.api.nvim_buf_get_extmarks(rbuf, inline.since_ns, 0, -1, {})
check(#since == 1, 'one line marked changed since viewed: ' .. #since)

-- Next file, close.
review.step(R, 1)
check(R.current == 'src/gone.txt', 'next file in panel order: ' .. tostring(R.current))
check(vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(R.wins.right)) == 1, 'deleted file: right side empty')
review.close(R)
check(#vim.api.nvim_list_tabpages() == 1, 'the tab page closed')
check(#vim.api.nvim_buf_get_keymap(rbuf, 'n') == 1 and vim.api.nvim_buf_get_keymap(rbuf, 'n')[1].desc == 'mine', 'keys taken off the file buffer, its own back: ' .. vim.inspect(vim.tbl_map(function(m) return m.lhs end, vim.api.nvim_buf_get_keymap(rbuf, 'n'))))
check(#vim.api.nvim_buf_get_extmarks(rbuf, inline.since_ns, 0, -1, {}) == 0, 'marks taken off the file buffer')

-- History.
idiff.open_history(root .. '/a.lua')
wait(function()
  local H = review.current()
  return H and H.shown ~= nil
end, 'the history to open')
local H = review.current()
check(H.history_path == 'a.lua' and #H.commits == 1, 'history lists the commit')
check(vim.wo[H.wins.left].winbar:match 'Nothing' ~= nil, 'the root commit compares with nothing')
-- A review opened from a panel: its diff windows are editor windows, not panel-like.
vim.o.number = true
vim.api.nvim_set_current_win(H.panel_win)
idiff.open 'HEAD'
wait(function()
  local R2 = review.current()
  return R2 and R2 ~= H and R2.shown ~= nil
end, 'a review opened from the panel')
local R2 = review.current()
check(vim.wo[R2.wins.right].number and not vim.wo[R2.wins.right].winfixwidth, 'diff windows keep the editor options')
review.close(R2)
review.close(H)

vim.fn.delete(root, 'rf')
if #failures > 0 then
  error(#failures .. ' failed')
end
print 'incremental-diff nvim: ok'
