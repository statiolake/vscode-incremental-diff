-- lazy.nvim runs this on install and update (`:Lazy build vscode-incremental-diff`):
-- it puts the core, incremental-diff, at bin/<os>-<arch>/incremental-diff(.exe),
-- where the Neovim plugin (and the VS Code extension's build) look for it.
--
-- For now the core is built from this checkout's source (cmd/incremental-diff),
-- which needs Go. Installing a prebuilt binary instead (fetched per
-- platform and checked against its sha256) replaces `from_source` below and
-- nothing else: whatever installs it only has to leave the executable at
-- `out`.
local root = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':p:h')
local uname = (vim.uv or vim.loop).os_uname()
local os_name = ({ Linux = 'linux', Darwin = 'darwin', Windows_NT = 'windows' })[uname.sysname] or uname.sysname:lower()
local arch = ({ x86_64 = 'amd64', amd64 = 'amd64', arm64 = 'arm64', aarch64 = 'arm64' })[uname.machine] or uname.machine
local out = table.concat({ root, 'bin', os_name .. '-' .. arch, os_name == 'windows' and 'incremental-diff.exe' or 'incremental-diff' }, '/')

local function from_source()
  if vim.fn.executable 'go' == 0 then
    error 'vscode-incremental-diff: building incremental-diff needs Go (https://go.dev/dl/)'
  end
  local output = {}
  local collect = function(_, data)
    vim.list_extend(output, data)
  end
  local job = vim.fn.jobstart({ 'go', 'build', '-trimpath', '-ldflags=-s -w', '-o', out, './cmd/incremental-diff' }, {
    cwd = root,
    env = { CGO_ENABLED = '0' },
    on_stdout = collect,
    on_stderr = collect,
  })
  if job <= 0 or vim.fn.jobwait({ job }, 10 * 60 * 1000)[1] ~= 0 then
    error('vscode-incremental-diff: go build failed: ' .. table.concat(output, '\n'))
  end
end

vim.fn.mkdir(vim.fn.fnamemodify(out, ':h'), 'p')
from_source()
print('vscode-incremental-diff: built ' .. out)
