package review

import (
	"regexp"
	"strings"
	"testing"

	"github.com/statiolake/vscode-incremental-diff/internal/diff"
	"github.com/statiolake/vscode-incremental-diff/internal/diffspec"
	"github.com/statiolake/vscode-incremental-diff/internal/git"
	"github.com/statiolake/vscode-incremental-diff/internal/testrepo"
)

func find(files []*diff.ChangedFile, path string) *diff.ChangedFile {
	for _, f := range files {
		if f.Path == path {
			return f
		}
	}
	return nil
}

func TestSnapshots(t *testing.T) {
	repo := testrepo.New(t)
	repo.Write("a.txt", "a\n")
	repo.Write("b.txt", "b\n")
	repo.Commit("base")

	t.Run("snapshots the work tree, survives gc, and detects later edits", func(t *testing.T) {
		repo.Write("a.txt", "a changed\r\n")
		repo.Remove("b.txt")
		spec, _ := diffspec.Parse("", nil)
		before, err := diff.List(repo.Root, spec, false)
		if err != nil {
			t.Fatal(err)
		}
		snapshots := TakeSnapshots(repo.Root, before.Right, before.Files)
		blob := snapshots["a.txt"]
		if snapshots["b.txt"] != Deleted {
			t.Errorf("b.txt: %q", snapshots["b.txt"])
		}
		if text := repo.Git("cat-file", "blob", blob); text != "a changed\r\n" {
			t.Errorf("snapshot text %q", text)
		}
		if CurrentSnapshotValue(find(before.Files, "a.txt")) != blob {
			t.Error("the listing's blob is the snapshot's")
		}

		ref := SnapshotRef("folder\nkey")
		if !regexp.MustCompile(`^refs/incremental-diff/[0-9a-f]{16}$`).MatchString(ref) {
			t.Errorf("ref %q", ref)
		}
		values := []string{}
		for _, v := range snapshots {
			values = append(values, v)
		}
		if err := WriteSnapshotRef(repo.Root, ref, values); err != nil {
			t.Fatal(err)
		}
		if tree := strings.TrimSpace(repo.Git("ls-tree", ref)); tree != "100644 blob "+blob+"\t"+blob {
			t.Errorf("tree %q", tree)
		}
		commit := repo.Git("rev-parse", ref)
		if err := WriteSnapshotRef(repo.Root, ref, []string{blob}); err != nil {
			t.Fatal(err)
		}
		if repo.Git("rev-parse", ref) != commit {
			t.Error("an unchanged tree keeps the ref")
		}

		repo.Git("gc", "-q", "--prune=now")
		if text := repo.Git("cat-file", "blob", blob); text != "a changed\r\n" {
			t.Errorf("after gc %q", text)
		}

		repo.Write("a.txt", "a changed again\n")
		after, _ := diff.List(repo.Root, spec, false)
		if CurrentSnapshotValue(find(after.Files, "a.txt")) == blob {
			t.Error("an edit changes the value")
		}
		if CurrentSnapshotValue(find(after.Files, "b.txt")) != Deleted {
			t.Error("a deleted file's value")
		}

		if err := WriteSnapshotRef(repo.Root, ref, []string{Deleted}); err != nil {
			t.Fatal(err)
		}
		if _, ok := git.Try(repo.Root, []string{"rev-parse", "--verify", "--quiet", ref}); ok {
			t.Error("no blobs delete the ref")
		}
	})

	t.Run("snapshots of commit sides reuse the existing blob", func(t *testing.T) {
		repo.Git("checkout", "-q", "--", ".")
		repo.Write("a.txt", "committed\n")
		repo.Commit("second")
		spec, _ := diffspec.Parse("HEAD~..HEAD", nil)
		result, err := diff.List(repo.Root, spec, false)
		if err != nil {
			t.Fatal(err)
		}
		snapshots := TakeSnapshots(repo.Root, result.Right, result.Files)
		if want := strings.TrimSpace(repo.Git("rev-parse", "HEAD:a.txt")); snapshots["a.txt"] != want {
			t.Errorf("snapshot %q, want %q", snapshots["a.txt"], want)
		}
	})
}
