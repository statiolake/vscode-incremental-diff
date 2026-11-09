-- The core's process (`incremental-diff serve`) and its JSON-RPC: one per
-- Neovim, started on first use and ended with Neovim (its stdin closes).
-- See docs/server.md.

local M = {}

local job, buffered, next_id = nil, '', 1
local waiting = {} -- id -> callback(err, result)
local handlers = {} -- notification method -> { fn, ... }
local exiting = false

vim.api.nvim_create_autocmd('VimLeavePre', {
  group = vim.api.nvim_create_augroup('incremental_diff_client', { clear = true }),
  callback = function()
    exiting = true
  end,
})

--- The core, incremental-diff: `cmd` when set (setup), else
--- bin/<os>-<arch>/incremental-diff of this plugin, where build.lua puts it.
M.cmd = nil

function M.executable()
  if M.cmd then
    return M.cmd
  end
  local here = debug.getinfo(1, 'S').source:sub(2)
  local root = vim.fn.fnamemodify(here, ':p:h:h:h')
  local uname = vim.uv.os_uname()
  local os_name = ({ Linux = 'linux', Darwin = 'darwin', Windows_NT = 'windows' })[uname.sysname] or uname.sysname:lower()
  local arch = ({ x86_64 = 'amd64', amd64 = 'amd64', arm64 = 'arm64', aarch64 = 'arm64' })[uname.machine] or uname.machine
  local name = os_name == 'windows' and 'incremental-diff.exe' or 'incremental-diff'
  return table.concat({ root, 'bin', os_name .. '-' .. arch, name }, '/')
end

-- $INCREMENTAL_DIFF_LOG: a file the messages both ways are appended to.
local function log(dir, line)
  local path = vim.env.INCREMENTAL_DIFF_LOG
  if path and path ~= '' then
    local f = io.open(path, 'a')
    if f then
      f:write(('%.3f %s %s\n'):format(vim.uv.hrtime() / 1e9, dir, line:sub(1, 300)))
      f:close()
    end
  end
end

local function dispatch(line)
  log('<', line)
  local ok, message = pcall(vim.json.decode, line, { luanil = { object = true, array = true } })
  if not ok or type(message) ~= 'table' then
    return
  end
  if message.id ~= nil and waiting[message.id] then
    local callback = waiting[message.id]
    waiting[message.id] = nil
    if message.error then
      callback(message.error.message or 'error', nil)
    else
      callback(nil, message.result)
    end
  elseif message.method then
    -- Not from inside the job's callback: a handler may wait on another
    -- answer (request_sync), which cannot arrive while this one runs.
    vim.schedule(function()
      for _, fn in ipairs(handlers[message.method] or {}) do
        local okh, err = pcall(fn, message.params)
        if not okh then
          vim.notify('incremental-diff: ' .. tostring(err), vim.log.levels.WARN)
        end
      end
    end)
  end
end

local function start()
  if job then
    return true
  end
  local cmd = M.executable()
  if vim.fn.executable(cmd) == 0 then
    return false, ('incremental-diff: %s is not built (:Lazy build vscode-incremental-diff)'):format(cmd)
  end
  buffered = ''
  local id = vim.fn.jobstart({ cmd, 'serve' }, {
    on_stdout = function(_, data)
      -- data: the chunk split at newlines; the first piece continues the last.
      data[1] = buffered .. data[1]
      buffered = table.remove(data)
      for _, line in ipairs(data) do
        if line ~= '' then
          dispatch(line)
        end
      end
    end,
    on_stderr = function(_, data)
      local text = table.concat(data, '\n')
      if text:match '%S' then
        vim.schedule(function()
          vim.notify('incremental-diff server: ' .. text, vim.log.levels.WARN)
        end)
      end
    end,
    on_exit = function()
      job = nil
      if exiting then
        waiting = {}
        return
      end
      for key, callback in pairs(waiting) do
        waiting[key] = nil
        callback('the incremental-diff server exited', nil)
      end
    end,
  })
  if id <= 0 then
    return false, 'incremental-diff: could not start ' .. cmd
  end
  job = id
  return true
end

--- Send method(params); callback(err, result) is called on the main loop.
function M.request(method, params, callback)
  local ok, err = start()
  if not ok then
    vim.schedule(function()
      callback(err, nil)
    end)
    return
  end
  local id = next_id
  next_id = next_id + 1
  waiting[id] = vim.schedule_wrap(callback)
  local line = vim.json.encode { jsonrpc = '2.0', id = id, method = method, params = params or vim.empty_dict() }
  log('>', line)
  vim.fn.chansend(job, line .. '\n')
end

--- The same, waiting for the answer (at most timeout ms). Answers result or nil, err.
function M.request_sync(method, params, timeout)
  local done, err, result = false, nil, nil
  M.request(method, params, function(e, r)
    done, err, result = true, e, r
  end)
  local ok = vim.wait(timeout or 10000, function()
    return done
  end, 5)
  if not ok then
    return nil, 'incremental-diff: ' .. method .. ' timed out'
  end
  if err then
    return nil, err
  end
  return result
end

--- fn(params) for every notification method from the server.
function M.on(method, fn)
  handlers[method] = handlers[method] or {}
  table.insert(handlers[method], fn)
end

--- Stop the server (it is started again on the next request).
function M.stop()
  if job then
    vim.fn.jobstop(job)
    job = nil
  end
end

function M.running()
  return job ~= nil
end

return M
