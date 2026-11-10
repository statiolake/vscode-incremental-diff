#!/bin/sh
# The Neovim frontend's headless tests against the real core: the one the
# plugin ships, bin/<os>-<arch>/incremental-diff, as an install runs it.
# INCREMENTAL_DIFF_BUILD=source rebuilds that from this checkout's source
# first (scripts/build-bins.sh host; needs Go), for testing a change to the
# core. NVIM=path/to/nvim picks the Neovim (default: nvim on PATH).
set -eu
cd "$(dirname "$0")/../.."
NVIM="${NVIM:-nvim}"
if [ "${INCREMENTAL_DIFF_BUILD:-}" = source ]; then
  scripts/build-bins.sh host
fi
"$NVIM" --headless --clean --cmd "set rtp^=$PWD" \
  -c "lua local ok, e = pcall(dofile, 'test/nvim/spec.lua'); if not ok then io.stderr:write('FAIL ' .. tostring(e) .. '\n'); vim.cmd 'cquit 1' end" \
  -c 'qall!' </dev/null
