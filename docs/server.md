# Architecture: one core, two frontends

```
 cmd/incremental-diff/   the core: one Go binary, `incremental-diff serve`
 internal/
   diffspec/               git diff arguments → the two sides (pure)
   diff/                   the changed files, their blobs and line counts (git diff --raw / --numstat)
   review/                 a review: open, refresh, mark, clear (session.go);
                           snapshots kept as git blobs behind a ref (snapshot.go);
                           marks and input history in state.json (state.go);
                           the branch HEAD forked from (branch.go)
   server/                 the reviews behind JSON-RPC on stdio, and git's state watched
 test/conformance/protocol.json   the protocol as scenarios (below)
 src/vscode/             the VS Code extension: a client of the core
 lua/incremental_diff/, plugin/   the Neovim frontend: a client of the core
 build.lua               lazy.nvim's build step: puts the core at bin/<os>-<arch>/
```

The boundary is the protocol below. Everything that decides something
lives in the core: which files changed, what each side is, what "viewed"
and "changed since viewed" mean, where snapshots and marks are kept. A
frontend only shows what it is told and asks for changes. How files are
arranged (a folder tree, a flat list, the order "next file" walks) is each
frontend's own.

## Why one Go binary

DevHub and its plugins run only binaries they ship, never a `node` from
the system (an SSH host has none to offer). The core was TypeScript, run
in VS Code's extension host and, for Neovim, as a bundled script under
`node`. It is now Go, without cgo:

- It is about a thousand lines of git calls and JSON. A Node runtime
  compiled into a single binary would be 50–100 MB; this is under 3 MB.
- It cross-compiles from anywhere, so one VSIX carries a build for each
  platform it supports (`bin/darwin-arm64/`, `bin/linux-amd64/`,
  `bin/linux-arm64/`), and the extension needs no Node of its own beyond
  the extension host.
- Both frontends run the same executable, so there is one implementation
  and nothing to keep in step. [vscode-review-relay](https://github.com/statiolake/vscode-review-relay)
  is built the same way.

For Neovim, `build.lua` (run by lazy.nvim on install and update) installs
the prebuilt core of the plugin's version: tag `v<version>` (package.json's)
has a GitHub release with `incremental-diff-<os>-<arch>.tar.gz` for
darwin-arm64, linux-amd64 and linux-arm64 and their `SHA256SUMS`, which
`.github/workflows/release.yml` builds (`scripts/release-assets.sh`) and
publishes when the tag is pushed. `build.lua` checks the archive's sha256
and that the core reports the version. It builds the core from the
plugin's own source with Go instead when the checkout's `cmd/`,
`internal/`, `go.mod` or `go.sum` differ from the tag's, or when there is
no prebuilt core to install. Either way the frontends only look for the
executable at `bin/<os>-<arch>/incremental-diff`.

## Why a long-lived process over stdio

Each frontend starts `incremental-diff serve` on first use as its child.
It speaks JSON-RPC 2.0, one JSON object per line, on stdin and stdout.

- **Long-lived, not a CLI per action.** A review is state: the resolved
  sides, the files, the marks being written, refreshes that must coalesce
  (a save and a focus change together run `git diff` once), and changes
  pushed to the client (`review/changed`) when git's own state moves (a
  commit, a checkout, staging). A CLI would resolve the revisions again
  for every keystroke that marks a file. It could also never tell the
  editor that something changed.
- **stdio, not a socket.** The server lives exactly as long as its
  editor: when stdin closes it closes every review and exits. There is no
  port to pick, no socket file to clean up, nothing to secure, and no
  daemon to find or restart. It runs wherever the editor runs (an SSH host
  included), next to the repository it reads.
- **Line-delimited JSON, not LSP framing.** Neovim's job API hands over
  lines, and `vim.json` decodes them; Node reads them with `readline`.
  Nothing on either side needs a `Content-Length` parser.

## Where the core keeps state

Marks and input history are kept in
`<git common dir>/incremental-diff/state.json`:

- They sit next to the objects and refs that hold the snapshots they name
  (`refs/incremental-diff/*`).
- They are shared by the repository's worktrees; each review's key names
  its root.
- They are deleted with the clone.
- Every editor on one repository, VS Code and Neovim alike, sees the same
  marks: each read checks the file, and each write replaces it atomically.

The file is an object: `incrementalDiff.review:<root>\n<git diff key>` →
`{ version: 1, marks: { <path>: { snapshot, reviewedAt } } }`, and
`incrementalDiff.history` → the inputs opened, most recent first (at most
20). Keys the core does not know are kept as they are. The TypeScript
core wrote the same file, so marks it made are found.

Git's own state (HEAD, the index, packed refs) is watched cheaply: the
regular files at the top level of the git directory, looked at twice a
second. Changes to work tree files are the client's to report with
`review/refresh` (Neovim's frontend does it after a write, on focus and
after a shell command; VS Code's on file changes). The client knows about
them without the core watching the whole tree, which for a large
repository costs more than it saves.

## The protocol

Requests (`internal/server/protocol.go` has the types; `src/vscode/protocol.ts`
mirrors them):

| method | params | result |
| --- | --- | --- |
| `initialize` | `{}` | `{ name, version, protocol: 1 }` |
| `review/open` | `{ root, input? \| branch: true, baseBranch?, stats? }` | a review |
| `review/get`, `review/refresh`, `review/clearReviewed`, `review/close` | `{ id }` | a review (`close`: null) |
| `review/setReviewed` | `{ id, paths, reviewed }` | a review (+ `warning`) |
| `git/blob` | `{ root, blob }` | `{ text }` or `{ binary: true }` |
| `git/log` | `{ root, path, limit? }` | commits touching the file (`--follow`), each with its path then |
| `history/list`, `history/remove` | `{ root, input? }` | the inputs opened before |

A review is
`{ id, root, title, key, left, right, files, error? }`:

- A side is `{ kind: "commit", sha, label } | { kind: "index" } | { kind: "worktree" }`.
- A file is `{ path, oldPath?, status, untracked?, oldBlob?, newBlob?, added?, deleted?, binary?, review, snapshot?, reviewedAt? }`.
- `review` is `unreviewed`, `reviewed` or `changed` (since it was viewed);
  `snapshot` is the blob it was viewed at.

The notification `review/changed` carries a review whenever its files or
marks change; a change a request made is notified before its answer.
A bad request answers error -32602; a failure to do what was asked
(an unknown revision, a git error) -32000.

`test/conformance/protocol.json` holds the protocol as scenarios: requests
and the answers, notifications and `state.json` they must produce on a
fresh repository. `go test ./internal/server` plays them against the
server. While the TypeScript core was being replaced, the same file was
played against both servers.

To see the traffic from Neovim, start it with `INCREMENTAL_DIFF_LOG=/path/to/file`:
every message both ways is appended there with a timestamp.
