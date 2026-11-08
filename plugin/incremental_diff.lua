-- Incremental Diff's commands. Nothing loads until one is used.
if vim.g.loaded_incremental_diff then
  return
end
vim.g.loaded_incremental_diff = true

local function complete()
  return { 'HEAD', '--cached', 'HEAD~', 'main...HEAD', '--merge-base main' }
end

vim.api.nvim_create_user_command('IncDiff', function(o)
  require('incremental_diff').open(o.args)
end, { nargs = '*', complete = complete, desc = 'Review `git diff <args>` file by file (none: unstaged changes)' })

vim.api.nvim_create_user_command('IncDiffBranch', function(o)
  require('incremental_diff').open_branch(o.args ~= '' and o.args or nil)
end, { nargs = '?', desc = 'Review everything since this branch left its base (or [base])' })

vim.api.nvim_create_user_command('IncDiffHistory', function(o)
  require('incremental_diff').open_history(o.args)
end, { nargs = '?', complete = 'file', desc = "A file's history, commit by commit (default: this buffer's file)" })

vim.api.nvim_create_user_command('IncDiffClose', function()
  require('incremental_diff').close()
end, { desc = "Close this tab page's review" })

vim.api.nvim_create_user_command('IncDiffToggle', function()
  require('incremental_diff').toggle_layout()
end, { desc = 'Split ⇄ inline' })

vim.api.nvim_create_user_command('IncDiffRefresh', function()
  require('incremental_diff').refresh()
end, { desc = "Refresh this tab page's review" })
