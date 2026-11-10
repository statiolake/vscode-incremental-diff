# Changelog

## 0.2.0

- A Neovim frontend (`lua/`, `plugin/`), installable with lazy.nvim:
  - a file panel, and split (Neovim's own diff mode) and inline views of the same buffers, with viewed marks and changes since viewed;
  - file history.
- The logic is one core, `incremental-diff`, a Go binary speaking JSON-RPC on stdio (docs/server.md), shared by both frontends:
  - the VS Code extension runs it from the VSIX, which carries it for macOS arm64 and Linux x86_64 / arm64;
  - the Neovim plugin's `build.lua` downloads it from the GitHub release (`incremental-diff-<os>-<arch>.tar.gz`, checked against `SHA256SUMS`), or builds it with Go when the checkout is past the release or no prebuilt core fits; Neovim needs no Node.js.
- Reviewed marks and the input history are kept in the repository (`.git/incremental-diff/state.json`), shared by VS Code, Neovim and every window on it. Marks VS Code 0.1 kept in its workspace state are not carried over.
- `X^!` on a root commit compares it with nothing instead of failing.

## 0.1.1

- Branch Changes compares against the branch the current branch forked from (the branch whose merge base with `HEAD` is closest) instead of always the default branch.

## 0.1.0

- Review any `git diff` file by file with reviewed checkboxes in a dedicated view, including Branch Changes from the merge base with the default branch.
- Snapshot reviewed files as git blobs and show only the changes since review once a reviewed file changes.
