package review

import (
	"testing"

	"github.com/statiolake/vscode-incremental-diff/internal/testrepo"
)

func TestDetectingTheBaseBranch(t *testing.T) {
	repo := testrepo.New(t)
	repo.Commit("root")
	repo.Git("switch", "-q", "-c", "feat-a")
	repo.Commit("a1")
	repo.Git("switch", "-q", "-c", "feat-b")
	repo.Commit("b1")
	// An older push of feat-b itself is closer than feat-a but is not a fork point.
	repo.Git("update-ref", "refs/remotes/origin/feat-b", "HEAD")
	repo.Commit("b2")
	// A branch forked from feat-b contains HEAD and must not be mistaken for its base.
	repo.Git("branch", "feat-c")
	repo.Git("switch", "-q", "feat-c")
	repo.Commit("c1")
	repo.Git("switch", "-q", "main")
	repo.Commit("m1")
	repo.Git("update-ref", "refs/remotes/origin/main", "HEAD")
	repo.Git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")

	detect := func() string {
		t.Helper()
		base, err := DetectBaseBranch(repo.Root, "")
		if err != nil {
			t.Fatal(err)
		}
		return base
	}
	t.Run("picks the branch HEAD forked from", func(t *testing.T) {
		repo.Git("switch", "-q", "feat-b")
		if base := detect(); base != "feat-a" {
			t.Errorf("feat-b: %q", base)
		}
		repo.Git("switch", "-q", "feat-a")
		if base := detect(); base != "main" && base != "origin/main" {
			t.Errorf("feat-a: %q", base)
		}
	})
	t.Run("a branch with no commits of its own is based on where it was created", func(t *testing.T) {
		repo.Git("switch", "-q", "-c", "fresh", "feat-a")
		if base := detect(); base != "feat-a" {
			t.Errorf("fresh: %q", base)
		}
	})
	t.Run("the configured branch wins", func(t *testing.T) {
		if base, _ := DetectBaseBranch(repo.Root, " develop "); base != "develop" {
			t.Errorf("configured: %q", base)
		}
	})
}
