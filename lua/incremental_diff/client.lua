-- The server process and its JSON-RPC: one per Neovim, started on first use
-- and ended with Neovim (its stdin closes). See docs/server.md.

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

--- The bundled server, next to this plugin's lua/ directory.
function M.server_path()
  local here = debug.getinfo(1, 'S').source:sub(2)
  return vim.fn.fnamemodify(here, ':h:h:h') .. '/server/incremental-diff-server.js'
end

M.node = 'node'

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
  if vim.fn.executable(M.node) == 0 then
    return false, ('incremental-diff needs Node.js (%s is not on PATH)'):format(M.node)
  end
  local path = M.server_path()
  if vim.fn.filereadable(path) == 0 then
    return false, 'incremental-diff: the server is missing: ' .. path
  end
  buffered = ''
  local id = vim.fn.jobstart({ M.node, path }, {
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
    return false, 'incremental-diff: could not start ' .. M.node
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
