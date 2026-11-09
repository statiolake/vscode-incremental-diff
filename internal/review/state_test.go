package review

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func newStore(t *testing.T) *Store {
	store := NewStore(filepath.Join(t.TempDir(), "incremental-diff", "state.json"))
	store.SetClock(func() time.Time { return time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC) })
	return store
}

func snap(s string) *string { return &s }

func TestStoresMarksPerFolderAndSpecAndSurvivesANewStore(t *testing.T) {
	store := newStore(t)
	scope, other := Scope("/repo", "main...HEAD"), Scope("/repo", "HEAD~")
	if _, err := store.Update(scope, map[string]*string{"a.ts": snap("1111"), "b.ts": snap("deleted")}); err != nil {
		t.Fatal(err)
	}
	want := map[string]Mark{"a.ts": {"1111", "2026-01-02T03:04:05.000Z"}, "b.ts": {"deleted", "2026-01-02T03:04:05.000Z"}}
	if got := NewStore(store.Path()).Marks(scope); !reflect.DeepEqual(got, want) {
		t.Errorf("a new store reads %+v", got)
	}
	if len(store.Marks(other)) != 0 {
		t.Error("another spec has no marks")
	}
	store.Update(scope, map[string]*string{"a.ts": nil})
	if got := store.Marks(scope); len(got) != 1 || got["b.ts"].Snapshot != "deleted" {
		t.Errorf("after clearing a.ts: %+v", got)
	}
	store.Update(scope, map[string]*string{"b.ts": nil})
	content, _ := os.ReadFile(store.Path())
	if strings.TrimSpace(string(content)) != "{}" {
		t.Errorf("an empty review leaves nothing behind: %s", content)
	}
}

func TestConcurrentUpdatesAreNotLost(t *testing.T) {
	store := newStore(t)
	scope := Scope("/repo", "")
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			store.Update(scope, map[string]*string{fmt.Sprintf("f%d", i): snap(fmt.Sprint(i))})
		}()
	}
	wg.Wait()
	if n := len(store.Marks(scope)); n != 20 {
		t.Errorf("%d marks", n)
	}
}

func TestClearForgetsOneReview(t *testing.T) {
	store := newStore(t)
	scope, other := Scope("/repo", ""), Scope("/repo", "HEAD")
	store.Update(scope, map[string]*string{"a": snap("1")})
	store.Update(other, map[string]*string{"a": snap("1")})
	store.Clear(scope)
	if len(store.Marks(scope)) != 0 || len(store.Marks(other)) != 1 {
		t.Error("clear forgets one review only")
	}
}

func TestIgnoresMalformedStoredData(t *testing.T) {
	store := newStore(t)
	scope := Scope("/repo", "")
	os.MkdirAll(filepath.Dir(store.Path()), 0o755)
	key, _ := jsonString("incrementalDiff.review:" + scope)
	os.WriteFile(store.Path(), []byte(`{`+key+`: {"version": 1, "marks": {"good": {"snapshot": "1", "reviewedAt": "x"}, "bad": {"snapshot": 3}, "empty": {"snapshot": "", "reviewedAt": "x"}, "odd": 5}}, "other": [1, 2]}`), 0o644)
	if got := store.Marks(scope); len(got) != 1 || got["good"].Snapshot != "1" {
		t.Errorf("marks %+v", got)
	}
	// Unknown keys are kept.
	store.Update(scope, map[string]*string{"new": snap("2")})
	content, _ := os.ReadFile(store.Path())
	if !strings.Contains(string(content), `"other": [`) {
		t.Errorf("unknown keys are kept: %s", content)
	}
	os.WriteFile(store.Path(), []byte(`{`+key+`: "garbage"}`), 0o644)
	if len(store.Marks(scope)) != 0 {
		t.Error("garbage reads as no marks")
	}
	os.WriteFile(store.Path(), []byte(`not json`), 0o644)
	if len(store.Marks(scope)) != 0 || len(store.History()) != 0 {
		t.Error("a damaged file reads as empty")
	}
}

func TestKeepsABoundedDeduplicatedHistory(t *testing.T) {
	store := newStore(t)
	for i := 0; i < HistoryLimit+5; i++ {
		store.AddHistory(fmt.Sprintf("HEAD~%d", i))
	}
	store.AddHistory("HEAD~3")
	history := store.History()
	if len(history) != HistoryLimit || history[0] != "HEAD~3" {
		t.Errorf("history %q", history)
	}
	count := 0
	for _, item := range history {
		if item == "HEAD~3" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("HEAD~3 %d times", count)
	}
	store.RemoveHistory("HEAD~3")
	for _, item := range store.History() {
		if item == "HEAD~3" {
			t.Error("removed")
		}
	}
}

func TestReviewStatusFollowsTheSnapshot(t *testing.T) {
	cases := []struct {
		current string
		mark    *Mark
		want    Status
	}{
		{"1", nil, Unreviewed},
		{"1", &Mark{Snapshot: "1"}, Reviewed},
		{"2", &Mark{Snapshot: "1"}, Changed},
		{"deleted", &Mark{Snapshot: "deleted"}, Reviewed},
	}
	for _, c := range cases {
		if got := StatusOf(c.current, c.mark); got != c.want {
			t.Errorf("%q %+v: %s", c.current, c.mark, got)
		}
	}
}

func jsonString(s string) (string, error) {
	b, err := json.Marshal(s)
	return string(b), err
}
