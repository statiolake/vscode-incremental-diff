-- lazy.nvim runs this on install and update (`:Lazy build vscode-incremental-diff`):
-- it puts the core, incremental-diff, at bin/<os>-<arch>/incremental-diff(.exe),
-- where the Neovim plugin (and the VS Code extension's build) look for it.
--
-- It installs the prebuilt core of this plugin's version (package.json's
-- "version", released as tag v<version>) from the GitHub release:
-- incremental-diff-<os>-<arch>.tar.gz, checked against the release's
-- SHA256SUMS. It needs curl and tar. It builds the core from this checkout's
-- source (cmd/incremental-diff) with Go instead when
--   - the core's source (cmd/, internal/, go.mod, go.sum) differs from the
--     release tag's, i.e. the checkout is past the release, and Go is here;
--   - the release has no core for this platform, or fetching or checking it
--     fails (then Go is needed);
--   - vim.g.incremental_diff_build or $INCREMENTAL_DIFF_BUILD is 'source'.
-- 'prebuilt' there installs the release's core even when the source differs.
-- $INCREMENTAL_DIFF_RELEASE_URL replaces the release's download URL
-- (https://github.com/statiolake/vscode-incremental-diff/releases/download/v<version>).
local name = 'incremental-diff'
local repo = 'statiolake/vscode-incremental-diff'
local core_paths = { 'cmd', 'internal', 'go.mod', 'go.sum' }

local root = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':p:h')
local uv = vim.uv or vim.loop
local uname = uv.os_uname()
local os_name = ({ Linux = 'linux', Darwin = 'darwin', Windows_NT = 'windows' })[uname.sysname] or uname.sysname:lower()
local arch = ({ x86_64 = 'amd64', amd64 = 'amd64', arm64 = 'arm64', aarch64 = 'arm64' })[uname.machine] or uname.machine
local exe = os_name == 'windows' and name .. '.exe' or name
local out = table.concat({ root, 'bin', os_name .. '-' .. arch, exe }, '/')

-- run(cmd) runs cmd to its end; returns whether it exited 0 and its output.
local function run(cmd, cwd, env)
  local output = {}
  local collect = function(_, data)
    vim.list_extend(output, data)
  end
  local ok, job = pcall(vim.fn.jobstart, cmd, {
    cwd = cwd or root,
    env = env,
    stdout_buffered = true,
    stderr_buffered = true,
    on_stdout = collect,
    on_stderr = collect,
  })
  local code = ok and job > 0 and vim.fn.jobwait({ job }, 10 * 60 * 1000)[1] or -1
  return code == 0, vim.trim(table.concat(output, '\n'))
end

local function read(path)
  local fd = io.open(path, 'rb')
  if not fd then
    return nil
  end
  local data = fd:read '*a'
  fd:close()
  return data
end

local function plugin_version()
  local ok, manifest = pcall(vim.json.decode, read(root .. '/package.json') or '')
  return ok and type(manifest) == 'table' and manifest.version or nil
end

local function has_go()
  return vim.fn.executable 'go' == 1
end

local function from_source()
  if not has_go() then
    error('vscode-' .. name .. ': building ' .. name .. ' needs Go (https://go.dev/dl/)', 0)
  end
  local ok, output = run({ 'go', 'build', '-trimpath', '-ldflags=-s -w', '-o', out, './cmd/' .. name }, root, { CGO_ENABLED = '0' })
  if not ok then
    error('vscode-' .. name .. ': go build failed: ' .. output, 0)
  end
  print('vscode-' .. name .. ': built ' .. out .. ' from source')
end

-- source_differs(tag) reports whether the core's source at HEAD differs from
-- tag's (compared by git tree ids, so a partial clone fetches nothing); nil
-- when that cannot be told (no git, no checkout, the tag not fetched).
local function source_differs(tag)
  if vim.fn.executable 'git' == 0 then
    return nil
  end
  for _, path in ipairs(core_paths) do
    local ok_tag, at_tag = run({ 'git', 'rev-parse', '--verify', '--quiet', tag .. '^{commit}:' .. path })
    local ok_head, at_head = run({ 'git', 'rev-parse', '--verify', '--quiet', 'HEAD:' .. path })
    if not ok_head or not ok_tag then
      return nil
    end
    if at_tag ~= at_head then
      return true
    end
  end
  return false
end

local function sha256_of(path)
  local data = read(path)
  if data then
    local ok, sum = pcall(vim.fn.sha256, data)
    if ok and type(sum) == 'string' and #sum == 64 then
      return sum
    end
  end
  for _, cmd in ipairs { { 'sha256sum', path }, { 'shasum', '-a', '256', path } } do
    if vim.fn.executable(cmd[1]) == 1 then
      local ok, output = run(cmd)
      local sum = ok and output:match '^(%x+)'
      if sum and #sum == 64 then
        return sum:lower()
      end
    end
  end
  error 'cannot compute a sha256 here (needs Neovim\'s sha256(), sha256sum or shasum)'
end

-- prebuilt(version) installs the release's core for this platform at out;
-- errors on anything short of a checked, working executable.
local function prebuilt(version)
  for _, tool in ipairs { 'curl', 'tar' } do
    if vim.fn.executable(tool) == 0 then
      error(tool .. ' not found', 0)
    end
  end
  local base = vim.env.INCREMENTAL_DIFF_RELEASE_URL or ('https://github.com/' .. repo .. '/releases/download/v' .. version)
  local asset = name .. '-' .. os_name .. '-' .. arch .. '.tar.gz'
  local tmp = vim.fn.tempname()
  vim.fn.mkdir(tmp, 'p')
  local ok, err = pcall(function()
    local function fetch(file)
      local fetched, output = run({ 'curl', '-fsSL', '--retry', '2', '--connect-timeout', '20', '-o', tmp .. '/' .. file, base .. '/' .. file })
      if not fetched then
        error('downloading ' .. base .. '/' .. file .. ' failed: ' .. output, 0)
      end
    end
    fetch 'SHA256SUMS'
    local want
    for line in (read(tmp .. '/SHA256SUMS') or ''):gmatch '[^\r\n]+' do
      local sum, file = line:match '^(%x+)%s+%*?(%S+)$'
      if file == asset then
        want = sum:lower()
      end
    end
    if not want then
      error('the release has no ' .. asset, 0)
    end
    fetch(asset)
    local got = sha256_of(tmp .. '/' .. asset)
    if got ~= want then
      error(asset .. ': sha256 ' .. got .. ' does not match SHA256SUMS (' .. want .. ')', 0)
    end
    local extracted, output = run({ 'tar', '-xzf', asset }, tmp)
    if not extracted or vim.fn.filereadable(tmp .. '/' .. exe) == 0 then
      error('extracting ' .. asset .. ' failed: ' .. output, 0)
    end
    os.remove(out)
    local copied, copy_err = uv.fs_copyfile(tmp .. '/' .. exe, out)
    if not copied then
      error('installing ' .. out .. ' failed: ' .. tostring(copy_err), 0)
    end
    uv.fs_chmod(out, tonumber('755', 8))
    local runs, reported = run { out, 'version' }
    if not runs or reported ~= version then
      os.remove(out)
      error(out .. ' does not run as version ' .. version .. ': ' .. reported, 0)
    end
  end)
  vim.fn.delete(tmp, 'rf')
  if not ok then
    error(err, 0)
  end
  print('vscode-' .. name .. ': installed ' .. out .. ' (v' .. version .. ', ' .. asset .. ', sha256 checked)')
end

vim.fn.mkdir(vim.fn.fnamemodify(out, ':h'), 'p')
local mode = vim.g.incremental_diff_build or vim.env.INCREMENTAL_DIFF_BUILD or 'auto'
local version = plugin_version()
if mode == 'source' or not version then
  from_source()
elseif mode ~= 'prebuilt' and has_go() and source_differs('v' .. version) then
  print('vscode-' .. name .. ': the core\'s source differs from v' .. version .. '; building it')
  from_source()
else
  local ok, err = pcall(prebuilt, version)
  if not ok then
    if not has_go() then
      error('vscode-' .. name .. ': installing the prebuilt core failed (' .. err .. '), and building it needs Go (https://go.dev/dl/)', 0)
    end
    print('vscode-' .. name .. ': installing the prebuilt core failed (' .. err .. '); building it')
    from_source()
  end
end
