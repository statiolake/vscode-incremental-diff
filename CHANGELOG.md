# Changelog

## 0.1.1

- Branch Changes compares against the branch the current branch forked from (the branch whose merge base with `HEAD` is closest) instead of always the default branch.

## 0.1.0

- Review any `git diff` file by file with reviewed checkboxes in a dedicated view, including Branch Changes from the merge base with the default branch.
- Snapshot reviewed files as git blobs and show only the changes since review once a reviewed file changes.
