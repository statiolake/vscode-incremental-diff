# Changelog

## 0.2.0

- A Neovim frontend (`lua/`, `plugin/`), installable with lazy.nvim:
  - a file panel, and split (Neovim's own diff mode) and inline views of the same buffers, with viewed marks and changes since viewed;
  - file history.
- The logic is a core (`src/core`) shared by the extension and a JSON-RPC server (`server/incremental-diff-server.js`) for other editors.
- `X^!` on a root commit compares it with nothing instead of failing.

## 0.1.1

- Branch Changes compares against the branch the current branch forked from (the branch whose merge base with `HEAD` is closest) instead of always the default branch.

## 0.1.0

- Review any `git diff` file by file with reviewed checkboxes in a dedicated view, including Branch Changes from the merge base with the default branch.
- Snapshot reviewed files as git blobs and show only the changes since review once a reviewed file changes.
