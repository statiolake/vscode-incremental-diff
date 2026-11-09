package review

import (
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/statiolake/vscode-incremental-diff/internal/testrepo"
)

func statuses(s *Session) []string {
	out := []string{}
	for _, f := range s.State().Files {
		out = append(out, f.Path+":"+string(f.Review))
	}
	return out
}

func TestReviewsFilesIncrementallyAgainstTheWorkTree(t *testing.T) {
	repo := testrepo.New(t)
	repo.Write("a.txt", "a\n")
	repo.Write("src/b.txt", "b\n")
	repo.Write("gone.txt", "gone\n")
	repo.Commit("base")
	repo.Write("a.txt", "a1\n")
	repo.Write("src/b.txt", "b1\n")
	repo.Remove("gone.txt")
	repo.Write("new.txt", "new\n")

	path := filepath.Join(t.TempDir(), "state.json")
	session, err := Open(NewStore(path), repo.Root, Request{Input: "HEAD"}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	var changes atomic.Int32
	session.OnChange(func() { changes.Add(1) })
	if session.Title != "git diff HEAD" {
		t.Errorf("title %q", session.Title)
	}
	expect := func(what string, s *Session, want ...string) {
		t.Helper()
		if got := statuses(s); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %q", what, got)
		}
	}
	expect("opened", session, "a.txt:unreviewed", "gone.txt:unreviewed", "new.txt:unreviewed", "src/b.txt:unreviewed")

	if _, err := session.SetReviewed([]string{"a.txt", "gone.txt", "src/b.txt"}, true); err != nil {
		t.Fatal(err)
	}
	expect("marked", session, "a.txt:reviewed", "gone.txt:reviewed", "new.txt:unreviewed", "src/b.txt:reviewed")
	if refs := strings.Fields(repo.Git("for-each-ref", "--format=%(refname)", "refs/incremental-diff/")); len(refs) != 1 || refs[0] != session.Ref {
		t.Errorf("refs %q", refs)
	}
	if changes.Load() != 1 {
		t.Errorf("%d changes notified", changes.Load())
	}

	// Edit a reviewed file: it is changed since review, its mark kept.
	repo.Write("a.txt", "a2\n")
	session.Refresh()
	expect("edited", session, "a.txt:changed", "gone.txt:reviewed", "new.txt:unreviewed", "src/b.txt:reviewed")
	a := session.State().Files[0]
	if a.Mark == nil || repo.Git("cat-file", "blob", a.Mark.Snapshot) != "a1\n" {
		t.Errorf("a.txt's snapshot %+v", a.Mark)
	}

	// Review state survives a new store on the same file; a reverted change
	// disappears from the list.
	repo.Git("checkout", "--", "src/b.txt")
	reopened, err := Open(NewStore(path), repo.Root, Request{Input: "  HEAD "}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	expect("reopened", reopened, "a.txt:changed", "gone.txt:reviewed", "new.txt:unreviewed")
	reopened.SetReviewed([]string{"a.txt"}, true)
	expect("marked again", reopened, "a.txt:reviewed", "gone.txt:reviewed", "new.txt:unreviewed")
	reopened.SetReviewed([]string{"a.txt"}, false)
	expect("unmarked", reopened, "a.txt:unreviewed", "gone.txt:reviewed", "new.txt:unreviewed")

	if err := reopened.ClearReviewed(); err != nil {
		t.Fatal(err)
	}
	expect("cleared", reopened, "a.txt:unreviewed", "gone.txt:unreviewed", "new.txt:unreviewed")
	if refs := strings.TrimSpace(repo.Git("for-each-ref", "refs/incremental-diff/")); refs != "" {
		t.Errorf("refs left: %q", refs)
	}

	// A closed review notifies nothing.
	session.Close()
	before := changes.Load()
	session.Refresh()
	if changes.Load() != before {
		t.Error("a closed review notified a change")
	}
}

func TestRefreshesCoalesce(t *testing.T) {
	repo := testrepo.New(t)
	repo.Write("a.txt", "a\n")
	repo.Commit("base")
	session, err := Open(NewStore(filepath.Join(t.TempDir(), "s.json")), repo.Root, Request{}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	var changes atomic.Int32
	session.OnChange(func() { changes.Add(1) })
	done := make(chan struct{})
	for i := 0; i < 10; i++ {
		go func() { session.Refresh(); done <- struct{}{} }()
	}
	for i := 0; i < 10; i++ {
		<-done
	}
	if n := changes.Load(); n < 1 || n > 10 {
		t.Errorf("%d refreshes", n)
	}
}

func TestRejectsBadInputAndFindsNoBase(t *testing.T) {
	repo := testrepo.New(t)
	repo.Commit("root")
	store := NewStore(filepath.Join(t.TempDir(), "s.json"))
	if _, err := Open(store, repo.Root, Request{Input: "no-such-rev --"}, Options{}); err == nil || err.Error() != "Unknown revision: no-such-rev" {
		t.Errorf("bad revision: %v", err)
	}
	if _, err := Open(store, repo.Root, Request{Branch: true}, Options{}); err == nil || err.Error() != "Could not find a base branch. Set the base branch." {
		t.Errorf("no base: %v", err)
	}
	branch, err := Open(store, repo.Root, Request{Branch: true}, Options{BaseBranch: "main"})
	if err != nil || branch.Title != "Branch Changes (main)" || branch.Spec.Key != "--merge-base main" {
		t.Errorf("branch: %+v %v", branch, err)
	}
}
