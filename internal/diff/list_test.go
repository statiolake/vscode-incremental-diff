package diff

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/statiolake/vscode-incremental-diff/internal/diffspec"
	"github.com/statiolake/vscode-incremental-diff/internal/testrepo"
)

func summary(files []*ChangedFile) []string {
	out := []string{}
	for _, f := range files {
		line := f.Status + " "
		if f.OldPath != nil {
			line += *f.OldPath + " -> "
		}
		line += f.Path
		if f.Untracked {
			line += " (untracked)"
		}
		out = append(out, line)
	}
	return out
}

func list(t *testing.T, root, input string) *Result {
	t.Helper()
	spec, err := ResolveSpec(root, input)
	if err != nil {
		t.Fatal(err)
	}
	result, err := List(root, spec, false)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func expect(t *testing.T, what string, got, want []string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s: got %q, want %q", what, got, want)
	}
}

func TestListingChanges(t *testing.T) {
	repo := testrepo.New(t)
	repo.Write("keep.txt", "keep\n")
	repo.Write("src/app.ts", "one\ntwo\nthree\nfour\nfive\nsix\n")
	repo.Write("old/name.ts", "export const value = 1;\nexport const other = 2;\nexport const third = 3;\n")
	repo.Write("gone.md", "bye\n")
	base := repo.Commit("base")
	repo.Git("switch", "-q", "-c", "feature")
	repo.Write("src/app.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\n")
	repo.Write("new/name.ts", "export const value = 1;\nexport const other = 2;\nexport const third = 3;\n")
	repo.Remove("old/name.ts")
	repo.Remove("gone.md")
	repo.Write("added.ts", "added\n")
	repo.Commit("feature")

	t.Run("compares two commits, detecting renames", func(t *testing.T) {
		result := list(t, repo.Root, "main..feature")
		expect(t, "files", summary(result.Files), []string{"A added.ts", "D gone.md", "R old/name.ts -> new/name.ts", "M src/app.ts"})
		if result.Left.Kind != Commit || result.Left.SHA != base {
			t.Errorf("left %+v", result.Left)
		}
		added := result.Files[0]
		if added.OldBlob != "" || added.NewBlob != strings.TrimSpace(repo.Git("rev-parse", "feature:added.ts")) {
			t.Errorf("added %+v", added)
		}
		if result.Files[1].NewBlob != "" {
			t.Errorf("deleted %+v", result.Files[1])
		}
	})

	t.Run("three dots start at the merge base", func(t *testing.T) {
		repo.Git("switch", "-q", "main")
		repo.Write("main-only.txt", "x\n")
		repo.Commit("main moves on")
		repo.Git("switch", "-q", "feature")
		for _, f := range list(t, repo.Root, "main...feature").Files {
			if f.Path == "main-only.txt" {
				t.Error("three dots list main-only.txt")
			}
		}
		found := false
		for _, f := range list(t, repo.Root, "main..feature").Files {
			found = found || f.Path == "main-only.txt" && f.Status == "D"
		}
		if !found {
			t.Error("two dots list main-only.txt as deleted")
		}
	})

	t.Run("work tree side includes uncommitted and untracked files", func(t *testing.T) {
		repo.Write("keep.txt", "edited\n")
		repo.Write("brand new.txt", "fresh\n")
		defer func() {
			repo.Git("reset", "-q", "--hard")
			repo.Remove("brand new.txt")
		}()
		result := list(t, repo.Root, "HEAD")
		expect(t, "HEAD", summary(result.Files), []string{"A brand new.txt (untracked)", "M keep.txt"})
		hashed := strings.TrimSpace(repo.Git("hash-object", "--no-filters", "keep.txt"))
		if result.Files[1].NewBlob != hashed {
			t.Errorf("work tree blob %q, want %q", result.Files[1].NewBlob, hashed)
		}
		expect(t, "unstaged", summary(list(t, repo.Root, "").Files), []string{"A brand new.txt (untracked)", "M keep.txt"})
		expect(t, "staged", summary(list(t, repo.Root, "--cached").Files), []string{})
		repo.Git("add", "keep.txt")
		staged := list(t, repo.Root, "--cached")
		expect(t, "staged now", summary(staged.Files), []string{"M keep.txt"})
		if staged.Files[0].NewBlob != hashed {
			t.Errorf("index blob %q", staged.Files[0].NewBlob)
		}
	})

	t.Run("bare words that are not revisions are paths", func(t *testing.T) {
		spec, err := ResolveSpec(repo.Root, "main src")
		if err != nil || !reflect.DeepEqual(spec.Pathspecs, []string{"src"}) {
			t.Fatalf("%+v %v", spec, err)
		}
		result, _ := List(repo.Root, spec, false)
		expect(t, "files", summary(result.Files), []string{"M src/app.ts"})
		var specErr *diffspec.Error
		if _, err := ResolveSpec(repo.Root, "nope --"); !errors.As(err, &specErr) {
			t.Errorf("nope --: %v", err)
		}
		bad, _ := diffspec.Parse("nope..main", nil)
		if _, err := List(repo.Root, bad, false); !errors.As(err, &specErr) || err.Error() != "Unknown revision: nope" {
			t.Errorf("nope..main: %v", err)
		}
	})

	t.Run("branch changes run from the merge base with the base branch to the work tree", func(t *testing.T) {
		repo.Write("wip.txt", "wip\n")
		defer repo.Remove("wip.txt")
		spec, _ := diffspec.ParseTokens(diffspec.BranchChangesArgs("main"), nil)
		result, err := List(repo.Root, spec, false)
		if err != nil {
			t.Fatal(err)
		}
		expect(t, "files", summary(result.Files), []string{"A added.ts", "D gone.md", "R old/name.ts -> new/name.ts", "M src/app.ts", "A wip.txt (untracked)"})
	})

	t.Run("stats count lines, untracked and binary files included", func(t *testing.T) {
		repo.Write("src/app.ts", "one\nTWO\nthree\nfour\nfive\nsix\nseven\n")
		repo.Write("notes.txt", "a\nb\nc")
		repo.Write("blob.bin", "\x00\x01")
		defer func() {
			repo.Git("checkout", "--", "src/app.ts")
			repo.Remove("notes.txt")
			repo.Remove("blob.bin")
		}()
		spec, _ := ResolveSpec(repo.Root, "HEAD")
		result, err := List(repo.Root, spec, true)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, f := range result.Files {
			if f.Binary {
				got = append(got, f.Path+" binary")
			} else {
				got = append(got, fmt.Sprintf("%s +%d -%d", f.Path, *f.Added, *f.Deleted))
			}
		}
		expect(t, "stats", got, []string{"blob.bin binary", "notes.txt +3 -0", "src/app.ts +1 -1"})
	})
}

func TestRootCommitParentComparesWithNothing(t *testing.T) {
	repo := testrepo.New(t)
	repo.Write("first.txt", "1\n")
	root := repo.Commit("root")
	result := list(t, repo.Root, root+"^!")
	if result.Left.Kind != Commit || result.Left.Label != root+"^ (none)" {
		t.Errorf("left %+v", result.Left)
	}
	expect(t, "files", summary(result.Files), []string{"A first.txt"})
}
