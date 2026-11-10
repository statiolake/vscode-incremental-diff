-- require('incremental_diff'): Incremental Diff in Neovim.
--
-- Review a git diff file by file, mark files viewed, and when a viewed file
-- changes see only what changed since. The diff, the files and the marks
-- come from the core, incremental-diff (the same as the VS Code extension's,
-- over JSON-RPC); this is the Neovim face of it. See README.md.

local M = {}

--- The changed words on a deleted line: a stronger red over the line's, as
--- VS Code draws removed text over a removed line. A colorscheme that sets
--- IncDiffDeleteText wins; otherwise it is DiffDelete with its ground's step
--- from Normal's doubled (with no ground, a quarter of DiffDelete's colour
--- over Normal's), its colour and boldness kept.
local function delete_text()
  local del = vim.api.nvim_get_hl(0, { name = 'DiffDelete', link = false })
  local normal = vim.api.nvim_get_hl(0, { name = 'Normal', link = false }).bg
    or (vim.o.background == 'light' and 0xffffff or 0x000000)
  local function mix(to, t)
    local out = 0
    for shift = 16, 0, -8 do
      local a, b = bit.band(bit.rshift(normal, shift), 0xff), bit.band(bit.rshift(to, shift), 0xff)
      out = out + bit.lshift(math.max(0, math.min(255, math.floor(a + (b - a) * t + 0.5))), shift)
    end
    return out
  end
  local bg
  if del.bg then
    bg = mix(del.bg, 2)
  elseif del.fg then
    bg = mix(del.fg, 0.25)
  else
    return { link = 'DiffText' }
  end
  local hl = vim.deepcopy(del)
  hl.bg = bg
  return hl
end

local function highlights()
  local links = {
    IncDiffAdd = 'DiffAdd',
    IncDiffChange = 'DiffChange',
    IncDiffText = 'DiffText',
    IncDiffDelete = 'DiffDelete',
    IncDiffSinceViewed = 'DiagnosticWarn',
    IncDiffStatusAdded = 'Added',
    IncDiffStatusModified = 'Changed',
    IncDiffStatusDeleted = 'Removed',
    IncDiffStatusRenamed = 'DiagnosticInfo',
    IncDiffStatusConflict = 'DiagnosticError',
    IncDiffDim = 'Comment',
    IncDiffTitle = 'Title',
    IncDiffDirectory = 'Directory',
    IncDiffCurrent = 'Special',
    IncDiffHash = 'Identifier',
    IncDiffWinbarRev = 'WinBar',
    IncDiffWinbarDim = 'WinBarNC',
  }
  -- Added / Changed / Removed are 0.10's; older schemes may lack them.
  local fallback = { Added = 'diffAdded', Changed = 'diffChanged', Removed = 'diffRemoved' }
  for group, target in pairs(links) do
    if fallback[target] and vim.tbl_isempty(vim.api.nvim_get_hl(0, { name = target })) then
      target = fallback[target]
    end
    vim.api.nvim_set_hl(0, group, { link = target, default = true })
  end
  vim.api.nvim_set_hl(0, 'IncDiffDeleteText', vim.tbl_extend('force', delete_text(), { default = true }))
end

highlights()
vim.api.nvim_create_autocmd('ColorScheme', {
  group = vim.api.nvim_create_augroup('incremental_diff_highlights', { clear = true }),
  callback = highlights,
})

--- Options (all optional):
---   width = 40, layout = 'split' | 'inline', list_mode = 'tree' | 'flat',
---   since_viewed = true, base_branch = '', cmd = nil (the core: bin/ of this plugin), refresh_delay = 200,
---   keys = { next_file, prev_file, toggle_layout, toggle_since, viewed_next,
---            next_hunk, prev_hunk, close, focus_panel } (false: none)
function M.setup(opts)
  opts = opts or {}
  local review = require 'incremental_diff.review'
  if opts.cmd then
    require('incremental_diff.client').cmd = opts.cmd
  end
  review.config = vim.tbl_deep_extend('force', review.config, opts)
  review.config.cmd = nil
  return M
end

--- Open a review of `git diff <args>` (a string as typed, or nil: unstaged changes).
function M.open(args, root)
  require('incremental_diff.review').open { input = args or '', root = root }
end

--- Branch Changes: everything since this branch left its base (`--merge-base <base>`).
function M.open_branch(base, root)
  require('incremental_diff.review').open { branch = true, base = base, root = root }
end

--- The history of a file (default: the current buffer's).
function M.open_history(path)
  require('incremental_diff.review').open_history(path)
end

--- Close the review of this tab page.
function M.close()
  require('incremental_diff.review').close()
end

--- Split ⇄ inline in this tab page's review.
function M.toggle_layout()
  require('incremental_diff.review').toggle_layout()
end

--- Focus this tab page's file panel. Answers false when it shows no review.
function M.focus_panel()
  return require('incremental_diff.review').focus_panel()
end

--- Whether this tab page shows a review.
function M.active()
  return require('incremental_diff.review').current() ~= nil
end

--- Refresh this tab page's review.
function M.refresh()
  local review = require 'incremental_diff.review'
  local R = review.current()
  if R then
    review.refresh(R)
  end
end

return M
