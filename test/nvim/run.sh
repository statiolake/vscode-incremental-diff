#!/bin/sh
# The Neovim frontend's headless tests: nvim on PATH (or $NVIM), node on PATH.
set -eu
cd "$(dirname "$0")/../.."
NVIM="${NVIM:-nvim}"
"$NVIM" --headless --clean --cmd "set rtp^=$PWD" \
  -c "lua local ok, e = pcall(dofile, 'test/nvim/spec.lua'); if not ok then io.stderr:write('FAIL ' .. tostring(e) .. '\n'); vim.cmd 'cquit 1' end" \
  -c 'qall!' </dev/null
