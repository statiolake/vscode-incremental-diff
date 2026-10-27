# Incremental Diff

Incremental Diff lets you review any git diff in VS Code file by file, the way GitHub pull requests do: tick **Viewed** on each file, and when a file changes afterwards, see only what changed since you reviewed it.

It works on any `git diff`: a branch against its base, a range of commits, staged or unstaged changes, or the work tree against any revision. No pull request, remote, or account is needed.

## Getting started

1. Install **Incremental Diff** from a VSIX (see [Install](#install)).
2. Open a folder inside a git repository.
3. Run **Incremental Diff: Open Branch Changes** from the Command Palette to review everything your branch changes, or **Incremental Diff: Open Diff…** to type `git diff` arguments.
4. Open the Incremental Diff icon in the Activity Bar. Click a file to open its diff, and tick its checkbox once you have reviewed it.

## Choosing a diff

**Open Diff…** takes arguments exactly as `git diff` does. Recent inputs are offered below the input box; the ✕ button removes one from the history.

| Input | Left side | Right side |
| --- | --- | --- |
| *(empty)* | index | work tree (unstaged changes) |
| `--cached` / `--staged` | `HEAD` | index |
| `--cached X` | `X` | index |
| `X` | `X` | work tree |
| `X..Y` | `X` | `Y` |
| `X...Y` | merge base of `X` and `Y` | `Y` |
| `X Y` | `X` | `Y` |
| `X^!` | `X^` | `X` |
| `--merge-base X` | merge base of `X` and `HEAD` | work tree |

An omitted side of a range means `HEAD`. Paths go after `--` (`main... -- src docs`); a bare word that names no revision is also taken as a path, like git does. Paths are relative to the repository root. Options that do not change the output format, such as `-w`, `-M50%`, or `--diff-filter=AM`, are passed through to git. A leading `git diff` is ignored, so you can paste a whole command.

When the right side is the work tree, untracked files (not ignored) are listed as added.

**Open Branch Changes** is a shortcut for `--merge-base <base>`: everything since your branch left its base, including uncommitted and untracked work. The base is `incrementalDiff.baseBranch` if set; otherwise the default branch of the `upstream` or `origin` remote (`upstream/HEAD`, `origin/HEAD`, then `main` or `master` on those remotes), and finally a local `main` or `master`.

Only one review is open at a time. It is reopened automatically when the window reloads.

## Reviewing

The **Changed Files** view lists the changed files as a folder tree (single-child folders are compacted) or, with **View as List**, as a flat list. Each file shows its status — **A**dded, **M**odified, **D**eleted, **R**enamed (with `← old/path`), **C**opied, **T**ype changed — using the familiar git colors. The view's message counts reviewed files, and the Activity Bar badge counts the files still to review.

- **Click a file** to open its diff. Added and deleted files are compared with an empty document.
- **Tick a file's checkbox** to mark it reviewed. Tick a folder to mark every file below it; untick it to clear them all. A folder is ticked when all of its files are reviewed.
- **Open All Changes** (title bar) opens every file in one multi-file diff editor. **Open Unreviewed Changes** (`…` menu) shows only files not yet reviewed.
- **Mark Reviewed and Next** (✓ in the diff editor title) marks the focused file reviewed and, in a single-file diff, opens the next file to review. In the multi-file diff editor it marks the file whose editor has focus.
- Right-click a file for **Open Full Diff**, **Open Changes Since Review**, and **Open File**.

### Changes since review

When you mark a file reviewed, Incremental Diff saves a snapshot of its right side. If the file changes later, it is unticked automatically and shown as *changed since review* (an amber `M•`-style badge).

- Clicking such a file opens **snapshot → current**: only what changed since you reviewed it. **Toggle Full Diff / Changes Since Review** (editor title) switches to the whole diff and back. Set `incrementalDiff.openChangesSinceReview` to `false` to open the full diff by default.
- **Open Changes Since Review** (title bar) opens every changed-since-review file in one multi-file diff editor.
- Tick the file again to review it at its new state.

A reviewed file whose change disappears from the diff drops out of the list; its mark returns if the same content comes back. **Clear Reviewed Marks** (`…` menu) forgets every mark of the current review.

### Where review state lives

Reviewed marks are stored in VS Code's workspace state, separately for each workspace folder and each diff (equivalent spellings such as `--staged` and `--cached` share one review), and survive reloads.

Snapshots are ordinary git blobs written with `git hash-object -w`. To keep `git gc` from pruning them, Incremental Diff points a private ref, `refs/incremental-diff/<id>`, at a commit whose tree holds all snapshots of that review. These refs are never pushed by a normal `git push`; **Clear Reviewed Marks** deletes the review's ref. To remove all of them:

```bash
git for-each-ref --format='%(refname)' refs/incremental-diff/ | xargs -n1 git update-ref -d
```

## Refreshing

The review refreshes after files are saved or changed on disk and when the git state changes (commits, checkouts, staging), waiting `incrementalDiff.refreshDelay` milliseconds after the last change. Checkboxes and expanded folders are kept. **Refresh** in the title bar refreshes immediately.

File contents of commits and the index are opened through VS Code's built-in git extension, so the usual editor features work on them. If the git extension is disabled, Incremental Diff reads them from git directly.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `incrementalDiff.baseBranch` | `""` | Base for **Open Branch Changes**, e.g. `origin/develop`. Empty detects it as described above. |
| `incrementalDiff.viewMode` | `"tree"` | `tree` groups files by folder; `flat` lists them by path. |
| `incrementalDiff.openChangesSinceReview` | `true` | Clicking a file changed since review shows only the changes since the review. |
| `incrementalDiff.autoRefresh` | `true` | Refresh on file saves and git state changes. |
| `incrementalDiff.refreshDelay` | `500` | Milliseconds to wait after the last change before refreshing. |

## Keyboard shortcuts

Incremental Diff contributes no default keybindings. Bind the commands you use most in **Keyboard Shortcuts**, for example:

```json
[
  { "key": "ctrl+alt+r", "command": "incrementalDiff.markReviewedAndNext", "when": "incrementalDiff.activeFile" },
  { "key": "ctrl+alt+b", "command": "incrementalDiff.openBranchChanges" },
  { "key": "ctrl+alt+t", "command": "incrementalDiff.toggleChangesSinceReview", "when": "incrementalDiff.activeFileChanged" }
]
```

Useful `when` contexts: `incrementalDiff.active` (a review is open), `incrementalDiff.activeFile` (the focused editor shows a file of the review), and `incrementalDiff.activeFileChanged` (that file changed since review).

## Install

Download `vscode-incremental-diff-<version>.vsix` from the [releases](https://github.com/statiolake/vscode-incremental-diff/releases), or build it yourself (see below), then run **Extensions: Install from VSIX…** or:

```bash
code --install-extension vscode-incremental-diff-0.1.0.vsix
```

## Development

```bash
npm install
npm test
npm run build
```

Press F5 in VS Code to launch an Extension Development Host. `npm run package` type-checks, bundles, and creates a VSIX.

## Known limitations

- Submodule changes are not listed.
- Combined diffs of three or more revisions and `--no-index` are not supported.
- Snapshot refs appear in `git log --all` and similar views of every ref.
- The multi-file diff editor cannot be scrolled by extensions, so **Mark Reviewed and Next** there only marks the focused file.
