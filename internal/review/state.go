package review

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Mark is a file marked reviewed (viewed).
type Mark struct {
	// Snapshot is the right side's blob id when it was marked, or Deleted.
	Snapshot string `json:"snapshot"`
	// ReviewedAt is an ISO 8601 timestamp in UTC with milliseconds.
	ReviewedAt string `json:"reviewedAt"`
}

// Status is a file's review status.
type Status string

const (
	Unreviewed Status = "unreviewed"
	Reviewed   Status = "reviewed"
	// Changed: reviewed, and its right side changed since.
	Changed Status = "changed"
)

// StatusOf answers a file's status: reviewed while its right side still
// equals the snapshot taken when it was marked, changed once it differs.
func StatusOf(current string, mark *Mark) Status {
	switch {
	case mark == nil:
		return Unreviewed
	case mark.Snapshot == current:
		return Reviewed
	}
	return Changed
}

const (
	reviewPrefix = "incrementalDiff.review:"
	historyKey   = "incrementalDiff.history"
	// HistoryLimit is how many inputs the history keeps.
	HistoryLimit = 20
)

// Scope is a review's identity: one folder (the repository root) and one
// normalized diff spec key.
func Scope(folder, specKey string) string { return folder + "\n" + specKey }

// Store keeps reviewed marks and the input history of one repository in a
// JSON file (`<git common dir>/incremental-diff/state.json`). Every read
// checks what is on disk (cached by modification time and size) and every
// write replaces the file atomically (a temporary file, then rename), so two
// processes on one repository see each other's marks; a write from both at
// the same instant keeps the later one. Writes within a process are
// serialized, so concurrent toggles never lose each other.
//
// The file is an object of keys: `incrementalDiff.review:<root>\n<key>` →
// `{ version: 1, marks: { <path>: { snapshot, reviewedAt } } }`, and
// `incrementalDiff.history` → the inputs, most recent first. Keys it does
// not know are kept as they are.
type Store struct {
	path string
	now  func() time.Time

	mu    sync.Mutex
	cache *cached
}

type cached struct {
	mtime time.Time
	size  int64
	data  map[string]json.RawMessage
}

// NewStore opens the store in the file at path (created on the first write).
func NewStore(path string) *Store { return &Store{path: path, now: time.Now} }

// SetClock replaces the store's clock (tests).
func (s *Store) SetClock(now func() time.Time) { s.now = now }

// Path is the store's file.
func (s *Store) Path() string { return s.path }

// read answers what is on disk; s.mu is held.
func (s *Store) read() map[string]json.RawMessage {
	info, err := os.Stat(s.path)
	if err != nil {
		return map[string]json.RawMessage{}
	}
	if s.cache != nil && s.cache.mtime.Equal(info.ModTime()) && s.cache.size == info.Size() {
		return s.cache.data
	}
	data := map[string]json.RawMessage{}
	if content, err := os.ReadFile(s.path); err == nil {
		var parsed map[string]json.RawMessage
		// A damaged file reads as empty; the next update replaces it.
		if json.Unmarshal(content, &parsed) == nil && parsed != nil {
			data = parsed
		}
	}
	s.cache = &cached{mtime: info.ModTime(), size: info.Size(), data: data}
	return data
}

// write sets (or with nil removes) keys and replaces the file; s.mu is held.
func (s *Store) write(changes map[string]any) error {
	current := s.read()
	data := make(map[string]json.RawMessage, len(current)+len(changes))
	for key, value := range current {
		data[key] = value
	}
	for key, value := range changes {
		if value == nil {
			delete(data, key)
			continue
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return err
		}
		data[key] = encoded
	}
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", " ")
	if err := encoder.Encode(data); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	temporary := fmt.Sprintf("%s.%d.tmp", s.path, os.Getpid())
	if err := os.WriteFile(temporary, out.Bytes(), 0o644); err != nil {
		return err
	}
	if err := os.Rename(temporary, s.path); err != nil {
		os.Remove(temporary)
		return err
	}
	s.cache = nil
	return nil
}

type storedReview struct {
	Version int             `json:"version"`
	Marks   map[string]Mark `json:"marks"`
}

// Marks answers a review's marks by path. Malformed stored data is ignored
// entry by entry.
func (s *Store) Marks(scope string) map[string]Mark {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.marks(scope)
}

func (s *Store) marks(scope string) map[string]Mark {
	marks := map[string]Mark{}
	var stored struct {
		Version any                        `json:"version"`
		Marks   map[string]json.RawMessage `json:"marks"`
	}
	if json.Unmarshal(s.read()[reviewPrefix+scope], &stored) != nil || stored.Version != float64(1) {
		return marks
	}
	for path, raw := range stored.Marks {
		var mark struct {
			Snapshot   any `json:"snapshot"`
			ReviewedAt any `json:"reviewedAt"`
		}
		if json.Unmarshal(raw, &mark) != nil {
			continue
		}
		snapshot, ok1 := mark.Snapshot.(string)
		reviewedAt, ok2 := mark.ReviewedAt.(string)
		if ok1 && ok2 && snapshot != "" {
			marks[path] = Mark{Snapshot: snapshot, ReviewedAt: reviewedAt}
		}
	}
	return marks
}

// Update sets (a snapshot value) or clears (nil) the marks of several paths
// at once, and answers the review's marks after it.
func (s *Store) Update(scope string, changes map[string]*string) (map[string]Mark, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	marks := s.marks(scope)
	reviewedAt := s.now().UTC().Format("2006-01-02T15:04:05.000Z")
	for path, snapshot := range changes {
		if snapshot == nil {
			delete(marks, path)
		} else {
			marks[path] = Mark{Snapshot: *snapshot, ReviewedAt: reviewedAt}
		}
	}
	var value any
	if len(marks) > 0 {
		value = storedReview{Version: 1, Marks: marks}
	}
	if err := s.write(map[string]any{reviewPrefix + scope: value}); err != nil {
		return nil, err
	}
	return marks, nil
}

// Clear forgets every mark of one review.
func (s *Store) Clear(scope string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.write(map[string]any{reviewPrefix + scope: nil})
}

// History answers the inputs opened before, most recent first.
func (s *Store) History() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.history()
}

func (s *Store) history() []string {
	history := []string{}
	var stored []any
	if json.Unmarshal(s.read()[historyKey], &stored) != nil {
		return history
	}
	for _, item := range stored {
		if text, ok := item.(string); ok {
			history = append(history, text)
		}
	}
	return history
}

// AddHistory moves input to the front of the history.
func (s *Store) AddHistory(input string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	history := []string{input}
	for _, item := range s.history() {
		if item != input && len(history) < HistoryLimit {
			history = append(history, item)
		}
	}
	return s.write(map[string]any{historyKey: history})
}

// RemoveHistory removes input from the history.
func (s *Store) RemoveHistory(input string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	history := []string{}
	for _, item := range s.history() {
		if item != input {
			history = append(history, item)
		}
	}
	return s.write(map[string]any{historyKey: history})
}
