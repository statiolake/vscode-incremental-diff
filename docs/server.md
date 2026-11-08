# Architecture: one core, two frontends

```
 src/core/          the logic, with no editor in it
   diffSpec.ts        git diff arguments → the two sides
   diff.ts            the changed files, their blobs and line counts (git diff --raw / --numstat)
   snapshot.ts        a viewed file's right side kept as a git blob, protected by a ref
   state.ts           viewed marks, input history (over a Memento: get / update)
   fileMemento.ts     a Memento in a JSON file
   session.ts         ReviewSession: open, refresh, mark, clear, next
   treeModel.ts       files as a folder tree
 src/vscode/        the VS Code extension: holds ReviewSessions in the extension host
 src/server/        incremental-diff-server: ReviewSessions behind JSON-RPC on stdio
 server/incremental-diff-server.js   the server bundled (checked in)
 lua/incremental_diff/, plugin/      the Neovim frontend: a client of the server
```

The boundary is `ReviewSession` and the wire types in `src/server/protocol.ts`.
Everything that decides something lives in the core: which files changed,
what each side is, what "viewed" and "changed since viewed" mean, where
snapshots and marks are kept. A frontend only shows what it is told and
asks for changes.

## Why a long-lived process over stdio

The Neovim frontend talks to `node server/incremental-diff-server.js`,
started on first use as a child of Neovim. It speaks JSON-RPC 2.0, one JSON
object per line, on stdin and stdout.

- **Long-lived, not a CLI per action.** A review is state: the resolved
  sides, the files, the marks being written, refreshes that must coalesce
  (a save and a focus change together run `git diff` once), and changes
  pushed to the client (`review/changed`) when git's own state moves (a
  commit, a checkout, staging). A CLI would start Node and resolve the
  revisions again for every keystroke that marks a file. It could also
  never tell the editor that something changed.
- **stdio, not a socket.** The server lives exactly as long as its
  Neovim: when stdin closes it closes every review and exits. There is no
  port to pick, no socket file to clean up, nothing to secure, and no
  daemon to find or restart. It runs wherever Neovim runs (an SSH host
  included), next to the repository it reads.
- **Line-delimited JSON, not LSP framing.** Neovim's job API hands over
  lines, and `vim.json` decodes them. Nothing on either side needs a
  `Content-Length` parser.
- **Bundled and checked in.** `scripts/build-server.mjs` bundles the server
  and the core into one dependency-free file. A plugin manager that clones
  the repository (lazy.nvim) needs no build step, only `node` on `PATH`.
  `npm test` fails when the bundle is stale.

The VS Code extension holds its `ReviewSession`s in the extension host
rather than spawning the server. The extension host is already a Node
process next to the repository, so a second process would only add a hop
and a lifetime to manage. It keeps its marks in VS Code's workspace state,
as before, so existing reviews stay where they were.

## Where the server keeps state

The server keeps marks and input history in
`<git common dir>/incremental-diff/state.json`, with the same shape as the
extension's workspace state:

- They sit next to the objects and refs that hold the snapshots they name
  (`refs/incremental-diff/*`).
- They are shared by the repository's worktrees; each review's key names
  its root.
- They are deleted with the clone.
- Two editors on one repository see each other's marks: each read checks
  the file, and each write replaces it atomically.

Git's own state (HEAD, the index, packed refs) is watched cheaply: only the
top level of the git directory. Changes to work tree files are the
client's to report with `review/refresh` (Neovim's frontend does it after a
write, on focus and after a shell command). The client knows about them
without watching the whole tree, which for a large repository costs more
than it saves.

## The protocol

Requests (`src/server/protocol.ts` has the types):

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
marks change.

To see the traffic from Neovim, start it with `INCREMENTAL_DIFF_LOG=/path/to/file`:
every message both ways is appended there with a timestamp.
