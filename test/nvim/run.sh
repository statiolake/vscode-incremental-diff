#!/bin/sh
# The Neovim frontend's headless tests against the real core: build.lua
# builds bin/<os>-<arch>/incremental-diff first from this checkout's source
# (needs Go; INCREMENTAL_DIFF_BUILD=auto installs the release's as lazy.nvim
# would). NVIM=path/to/nvim picks the Neovim (default: nvim on PATH).
set -eu
cd "$(dirname "$0")/../.."
NVIM="${NVIM:-nvim}"
INCREMENTAL_DIFF_BUILD="${INCREMENTAL_DIFF_BUILD:-source}" "$NVIM" --headless --clean -l build.lua
"$NVIM" --headless --clean --cmd "set rtp^=$PWD" \
  -c "lua local ok, e = pcall(dofile, 'test/nvim/spec.lua'); if not ok then io.stderr:write('FAIL ' .. tostring(e) .. '\n'); vim.cmd 'cquit 1' end" \
  -c 'qall!' </dev/null
