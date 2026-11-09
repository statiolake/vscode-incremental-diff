package review

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"

	"github.com/statiolake/vscode-incremental-diff/internal/diff"
	"github.com/statiolake/vscode-incremental-diff/internal/git"
)

// Deleted is the snapshot value of a file whose right side is empty (a
// deletion).
const Deleted = "deleted"

var identity = []string{
	"GIT_AUTHOR_NAME=Incremental Diff",
	"GIT_AUTHOR_EMAIL=incremental-diff@localhost",
	"GIT_COMMITTER_NAME=Incremental Diff",
	"GIT_COMMITTER_EMAIL=incremental-diff@localhost",
}

// SnapshotRef is the ref that keeps one review's snapshot blobs reachable.
func SnapshotRef(scope string) string {
	sum := sha256.Sum256([]byte(scope))
	return "refs/incremental-diff/" + hex.EncodeToString(sum[:])[:16]
}

// TakeSnapshots records the current right side of each file as a snapshot
// value: a blob id written to the object database, or Deleted.
func TakeSnapshots(root string, right diff.Side, files []*diff.ChangedFile) map[string]string {
	snapshots := map[string]string{}
	var fromWorktree []string
	for _, file := range files {
		switch {
		case file.Status == "D" || (right.Kind != diff.Worktree && file.NewBlob == ""):
			snapshots[file.Path] = Deleted
		case right.Kind == diff.Worktree:
			fromWorktree = append(fromWorktree, file.Path)
		default:
			snapshots[file.Path] = file.NewBlob
		}
	}
	blobs := diff.HashWorktreeFiles(root, fromWorktree, true)
	for i, path := range fromWorktree {
		if blobs[i] != "" {
			snapshots[path] = blobs[i]
		} else {
			snapshots[path] = Deleted
		}
	}
	return snapshots
}

// CurrentSnapshotValue is the value the right side of file has now,
// comparable with a snapshot.
func CurrentSnapshotValue(file *diff.ChangedFile) string {
	if file.NewBlob == "" {
		return Deleted
	}
	return file.NewBlob
}

// WriteSnapshotRef points ref at a commit whose tree holds every snapshot
// blob, so that `git gc` keeps them, or deletes the ref when there are none.
func WriteSnapshotRef(root, ref string, blobs []string) error {
	seen := map[string]bool{}
	var unique []string
	for _, blob := range blobs {
		if blob != Deleted && !seen[blob] {
			seen[blob] = true
			unique = append(unique, blob)
		}
	}
	sort.Strings(unique)
	if len(unique) == 0 {
		DeleteSnapshotRef(root, ref)
		return nil
	}
	var input strings.Builder
	for _, blob := range unique {
		input.WriteString("100644 blob " + blob + "\t" + blob + "\n")
	}
	treeOut, err := git.Run(root, []string{"mktree"}, git.Input(input.String()))
	if err != nil {
		return err
	}
	tree := strings.TrimSpace(treeOut)
	if existing, ok := git.Try(root, []string{"rev-parse", "--verify", "--quiet", ref + "^{tree}"}); ok && strings.TrimSpace(existing) == tree {
		return nil
	}
	commit, err := git.Run(root, []string{"commit-tree", tree, "-m", "Incremental Diff review snapshots"}, git.Options{Env: identity})
	if err != nil {
		return err
	}
	_, err = git.Run(root, []string{"update-ref", ref, strings.TrimSpace(commit)})
	return err
}

// DeleteSnapshotRef deletes a review's snapshot ref.
func DeleteSnapshotRef(root, ref string) {
	git.Try(root, []string{"update-ref", "-d", ref})
}
