// Package review is one open review: a diff, its files and their reviewed
// state, with the marks and snapshots that keep it. It is the whole of
// Incremental Diff's logic without an editor; the server (internal/server)
// holds reviews for the clients that talk JSON-RPC to it.
package review

import (
	"errors"
	"fmt"
	"sync"

	"github.com/statiolake/vscode-incremental-diff/internal/diff"
	"github.com/statiolake/vscode-incremental-diff/internal/diffspec"
)

// Request is what to review: `git diff` arguments as typed (Input), or
// Branch Changes (Branch).
type Request struct {
	Input  string
	Branch bool
}

// Options of Open.
type Options struct {
	// BaseBranch for Branch Changes; empty detects it.
	BaseBranch string
	// Stats counts added and deleted lines per file (`git diff --numstat`).
	Stats bool
}

// File is a changed file with its review status.
type File struct {
	diff.ChangedFile
	Review Status
	Mark   *Mark
}

// Session is one open review. Its methods are safe for concurrent use.
type Session struct {
	store *Store
	Root  string
	Spec  *diffspec.Spec
	Title string
	Scope string
	Ref   string
	stats bool

	mu       sync.Mutex
	result   *diff.Result
	files    []*File
	err      string
	closed   bool
	listener func()

	// Refreshes coalesce: one runs at a time, and requests while it runs
	// make it run once more.
	refreshMu   sync.Mutex
	refreshing  chan struct{}
	refreshMore bool

	// Marks are changed one call at a time.
	markMu sync.Mutex
}

// Open opens a review of the repository at root; it rejects bad input
// without side effects.
func Open(store *Store, root string, request Request, options Options) (*Session, error) {
	var spec *diffspec.Spec
	var title string
	var err error
	if request.Branch {
		base, err := DetectBaseBranch(root, options.BaseBranch)
		if err != nil {
			return nil, err
		}
		if base == "" {
			return nil, errors.New("Could not find a base branch. Set the base branch.")
		}
		if spec, err = diffspec.ParseTokens(diffspec.BranchChangesArgs(base), nil); err != nil {
			return nil, err
		}
		title = fmt.Sprintf("Branch Changes (%s)", base)
	} else {
		if spec, err = diff.ResolveSpec(root, request.Input); err != nil {
			return nil, err
		}
		title = diffspec.Describe(spec)
	}
	result, err := diff.List(root, spec, options.Stats)
	if err != nil {
		return nil, err
	}
	scope := Scope(root, spec.Key)
	s := &Session{store: store, Root: root, Spec: spec, Title: title, Scope: scope, Ref: SnapshotRef(scope), stats: options.Stats}
	s.apply(result)
	return s, nil
}

// OnChange sets the function called whenever the files or their state
// change (after a refresh, a mark, a clear).
func (s *Session) OnChange(listener func()) {
	s.mu.Lock()
	s.listener = listener
	s.mu.Unlock()
}

func (s *Session) changed() {
	s.mu.Lock()
	listener, closed := s.listener, s.closed
	s.mu.Unlock()
	if listener != nil && !closed {
		listener()
	}
}

// Snapshot is a consistent view of the review's state.
type Snapshot struct {
	Left, Right diff.Side
	Files       []File
	Error       string
}

// State answers the review's current state, copied.
func (s *Session) State() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	files := make([]File, len(s.files))
	for i, file := range s.files {
		files[i] = *file
		if file.Mark != nil {
			mark := *file.Mark
			files[i].Mark = &mark
		}
	}
	return Snapshot{Left: s.result.Left, Right: s.result.Right, Files: files, Error: s.err}
}

// apply takes a listing as the review's files; s.mu is not held.
func (s *Session) apply(result *diff.Result) {
	marks := s.store.Marks(s.Scope)
	files := make([]*File, len(result.Files))
	for i, changed := range result.Files {
		file := &File{ChangedFile: *changed}
		if mark, ok := marks[changed.Path]; ok {
			file.Mark = &mark
		}
		file.Review = StatusOf(CurrentSnapshotValue(changed), file.Mark)
		files[i] = file
	}
	s.mu.Lock()
	s.result, s.files = result, files
	s.mu.Unlock()
}

// Refresh runs the diff again now, coalescing with a refresh already
// running, and returns when the review is up to date.
func (s *Session) Refresh() {
	s.refreshMu.Lock()
	if s.refreshing != nil {
		s.refreshMore = true
		done := s.refreshing
		s.refreshMu.Unlock()
		<-done
		return
	}
	done := make(chan struct{})
	s.refreshing = done
	s.refreshMu.Unlock()
	for {
		s.refreshOnce()
		s.refreshMu.Lock()
		if !s.refreshMore {
			s.refreshing = nil
			s.refreshMu.Unlock()
			close(done)
			return
		}
		s.refreshMore = false
		s.refreshMu.Unlock()
	}
}

func (s *Session) refreshOnce() {
	if s.isClosed() {
		return
	}
	result, err := diff.List(s.Root, s.Spec, s.stats)
	if s.isClosed() {
		return
	}
	if err != nil {
		s.mu.Lock()
		s.err = err.Error()
		s.mu.Unlock()
	} else {
		s.apply(result)
		s.mu.Lock()
		s.err = ""
		s.mu.Unlock()
	}
	s.changed()
}

// SetReviewed marks files reviewed (snapshotting their right side) or not
// reviewed. It answers a warning when the snapshots could not be protected
// from `git gc`.
func (s *Session) SetReviewed(paths []string, reviewed bool) (string, error) {
	if len(paths) == 0 {
		return "", nil
	}
	s.markMu.Lock()
	defer s.markMu.Unlock()
	wanted := map[string]bool{}
	for _, path := range paths {
		wanted[path] = true
	}
	s.mu.Lock()
	right := s.result.Right
	var targets []*diff.ChangedFile
	for _, file := range s.files {
		if wanted[file.Path] {
			changed := file.ChangedFile
			targets = append(targets, &changed)
		}
	}
	s.mu.Unlock()

	changes := map[string]*string{}
	snapshots := map[string]string{}
	if reviewed {
		snapshots = TakeSnapshots(s.Root, right, targets)
		for path, snapshot := range snapshots {
			changes[path] = &snapshot
		}
	} else {
		for _, file := range targets {
			changes[file.Path] = nil
		}
	}
	marks, err := s.store.Update(s.Scope, changes)
	if err != nil {
		return "", err
	}
	if s.isClosed() {
		return "", nil
	}
	var warning string
	blobs := make([]string, 0, len(marks))
	for _, mark := range marks {
		blobs = append(blobs, mark.Snapshot)
	}
	if err := WriteSnapshotRef(s.Root, s.Ref, blobs); err != nil {
		warning = "Could not protect review snapshots from git gc: " + err.Error()
	}
	s.mu.Lock()
	for _, file := range s.files {
		// The snapshot is the file's content right now.
		if snapshot, ok := snapshots[file.Path]; ok {
			if snapshot == Deleted {
				file.NewBlob = ""
			} else {
				file.NewBlob = snapshot
			}
		}
		if mark, ok := marks[file.Path]; ok {
			file.Mark = &mark
		} else {
			file.Mark = nil
		}
		file.Review = StatusOf(CurrentSnapshotValue(&file.ChangedFile), file.Mark)
	}
	s.mu.Unlock()
	s.changed()
	return warning, nil
}

// ClearReviewed forgets every reviewed mark of this review.
func (s *Session) ClearReviewed() error {
	s.markMu.Lock()
	defer s.markMu.Unlock()
	if err := s.store.Clear(s.Scope); err != nil {
		return err
	}
	DeleteSnapshotRef(s.Root, s.Ref)
	s.mu.Lock()
	result := s.result
	s.mu.Unlock()
	s.apply(result)
	s.changed()
	return nil
}

// Close stops the review: results still on their way are dropped.
func (s *Session) Close() {
	s.mu.Lock()
	s.closed = true
	s.listener = nil
	s.mu.Unlock()
}

func (s *Session) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}
