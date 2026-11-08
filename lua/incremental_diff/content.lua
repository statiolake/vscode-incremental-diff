-- The buffers a review shows.
--
-- * The work tree's side is the file's own buffer (`:edit path`): editable,
--   saved to disk, with its LSP, its plugins and its marks. Nothing about it
--   is ours except what a review puts on it for as long as it shows it.
-- * Any other side (a commit, the index, the snapshot taken when the file
--   was viewed, nothing for an added or deleted file) is a read-only scratch
--   buffer holding exactly that file's lines, named
--   `incdiff://<what>/<path>` — like fugitive:// and diffview:// buffers, a
--   name that says what it is and keeps the path's extension, so 'filetype'
--   and treesitter colour it as the file. What we know about it is ours, in
--   b:incremental_diff.

local client = require 'incremental_diff.client'

local M = {}

M.scheme = 'incdiff'

--- The scratch buffer named name with lines, made or reused.
local function scratch(name, lines, path, info)
  local buf = vim.fn.bufnr(name)
  if buf == -1 or not vim.api.nvim_buf_is_valid(buf) then
    buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_name(buf, name)
  end
  local bo = vim.bo[buf]
  bo.buftype = 'nofile'
  bo.bufhidden = 'hide'
  bo.swapfile = false
  bo.modifiable = true
  bo.readonly = false
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  bo.modifiable = false
  bo.readonly = true
  bo.modified = false
  vim.b[buf].incremental_diff = info
  if bo.filetype == '' then
    local ft = vim.filetype.match { filename = path, buf = buf }
    if ft then
      bo.filetype = ft
    end
  end
  return buf
end

local function split_lines(text)
  if text == nil or text == '' then
    return {}
  end
  local lines = vim.split(text, '\n', { plain = true })
  if lines[#lines] == '' then
    table.remove(lines)
  end
  return lines
end

-- Blob text by root and blob id: blobs never change, so they are kept.
local blobs = {}

--- A blob's lines (or nil, err; binary = true for binary content).
function M.blob_lines(root, blob)
  local key = root .. '\0' .. blob
  if blobs[key] == nil then
    local result, err = client.request_sync('git/blob', { root = root, blob = blob })
    if not result then
      return nil, err
    end
    blobs[key] = result
  end
  local result = blobs[key]
  if result.binary then
    return nil, 'binary', true
  end
  return split_lines(result.text)
end

local function short(sha)
  return sha:sub(1, 10)
end

--- A side as { buf, label, editable }: side is { kind = 'blob', blob, what }
--- | { kind = 'worktree' } | { kind = 'empty', what }. path is repo-relative.
function M.side_buffer(root, path, side)
  local abs = root .. '/' .. path
  if side.kind == 'worktree' then
    local buf = vim.fn.bufadd(abs)
    vim.fn.bufload(buf)
    vim.bo[buf].buflisted = true
    return buf
  end
  if side.kind == 'empty' then
    local name = ('%s://%s/%s'):format(M.scheme, side.what or 'empty', path)
    return scratch(name, {}, path, { root = root, path = path, side = side.what or 'empty' })
  end
  local lines, err, binary = M.blob_lines(root, side.blob)
  if not lines then
    local name = ('%s://%s/%s'):format(M.scheme, short(side.blob), path)
    local note = binary and '(binary file)' or ('(could not read ' .. side.blob .. ': ' .. tostring(err) .. ')')
    local buf = scratch(name, { note }, path .. '.txt', { root = root, path = path, blob = side.blob, binary = binary })
    return buf
  end
  local name = ('%s://%s/%s'):format(M.scheme, side.what or short(side.blob), path)
  return scratch(name, lines, path, { root = root, path = path, blob = side.blob, rev = side.rev, side = side.what })
end

--- The lines a side shows now (a work tree buffer's live text, unsaved edits included).
function M.lines(buf)
  return vim.api.nvim_buf_get_lines(buf, 0, -1, false)
end

--- Whether buf is one of ours.
function M.is_ours(buf)
  return vim.api.nvim_buf_get_name(buf):sub(1, #M.scheme + 3) == M.scheme .. '://'
end

--- Wipe the scratch buffers no window shows any more.
function M.wipe_unshown(keep)
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if M.is_ours(buf) and not (keep and keep[buf]) and #vim.fn.win_findbuf(buf) == 0 then
      pcall(vim.api.nvim_buf_delete, buf, { force = true })
    end
  end
end

-- `:edit incdiff://…` (a session restored, a buffer wiped and reopened)
-- reads the blob again; the name holds what is needed only for blobs of a
-- review still open, so others read as empty with a note.
vim.api.nvim_create_autocmd('BufReadCmd', {
  group = vim.api.nvim_create_augroup('incremental_diff_content', { clear = true }),
  pattern = M.scheme .. '://*',
  callback = function(ev)
    local info = vim.b[ev.buf].incremental_diff
    if info and info.blob then
      local lines = M.blob_lines(info.root, info.blob) or {}
      vim.bo[ev.buf].modifiable = true
      vim.api.nvim_buf_set_lines(ev.buf, 0, -1, false, lines)
      vim.bo[ev.buf].modifiable = false
      vim.bo[ev.buf].modified = false
    end
  end,
})

return M
