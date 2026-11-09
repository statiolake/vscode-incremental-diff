package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/statiolake/vscode-incremental-diff/internal/diff"
	"github.com/statiolake/vscode-incremental-diff/internal/git"
	"github.com/statiolake/vscode-incremental-diff/internal/review"
)

// RequestError is a bad request (JSON-RPC -32602); any other error is a
// failure to do what was asked (-32000).
type RequestError struct{ Message string }

func (e *RequestError) Error() string { return e.Message }

func badRequest(format string, args ...any) error {
	return &RequestError{Message: fmt.Sprintf(format, args...)}
}

// Notify sends a notification to the client.
type Notify func(method string, params any)

// Options of a Service.
type Options struct {
	Version string
	// WatchDelay is how long git's state must be still before a review
	// refreshes (default 300ms).
	WatchDelay time.Duration
	// PollInterval is how often git's state is looked at (default 500ms).
	PollInterval time.Duration
}

type openReview struct {
	id      int
	session *review.Session
	stop    chan struct{}
}

// Service runs the requests: it holds open reviews by id, answers with their
// wire state, and notifies the client when a review changes.
type Service struct {
	notify  Notify
	options Options

	mu      sync.Mutex
	reviews map[int]*openReview
	stores  map[string]*review.Store
	nextID  int
}

// NewService makes a service that sends notifications through notify.
func NewService(notify Notify, options Options) *Service {
	if options.WatchDelay == 0 {
		options.WatchDelay = 300 * time.Millisecond
	}
	if options.PollInterval == 0 {
		options.PollInterval = 500 * time.Millisecond
	}
	return &Service{notify: notify, options: options, reviews: map[int]*openReview{}, stores: map[string]*review.Store{}, nextID: 1}
}

type params map[string]any

// Handle runs one request. params is the request's params (null or absent
// reads as {}).
func (s *Service) Handle(method string, raw json.RawMessage) (any, error) {
	p := params{}
	if len(raw) > 0 {
		// Params that are not an object read as {}.
		_ = json.Unmarshal(raw, &p)
		if p == nil {
			p = params{}
		}
	}
	switch method {
	case "initialize":
		return Initialized{Name: "incremental-diff", Version: s.options.Version, Protocol: ProtocolVersion}, nil
	case "review/open":
		return s.open(p)
	case "review/get":
		open, err := s.get(p["id"])
		if err != nil {
			return nil, err
		}
		return s.wire(open), nil
	case "review/refresh":
		open, err := s.get(p["id"])
		if err != nil {
			return nil, err
		}
		open.session.Refresh()
		return s.wire(open), nil
	case "review/setReviewed":
		open, err := s.get(p["id"])
		if err != nil {
			return nil, err
		}
		list, ok := p["paths"].([]any)
		paths := make([]string, len(list))
		for i, item := range list {
			if paths[i], ok = item.(string); !ok {
				break
			}
		}
		if !ok {
			return nil, badRequest("paths must be a list of paths.")
		}
		warning, err := open.session.SetReviewed(paths, p["reviewed"] != false)
		if err != nil {
			return nil, err
		}
		wire := s.wire(open)
		wire.Warning = warning
		return wire, nil
	case "review/clearReviewed":
		open, err := s.get(p["id"])
		if err != nil {
			return nil, err
		}
		if err := open.session.ClearReviewed(); err != nil {
			return nil, err
		}
		return s.wire(open), nil
	case "review/close":
		if id, ok := number(p["id"]); ok {
			s.close(int(id))
		}
		return nil, nil
	case "git/blob":
		return s.blob(p)
	case "git/log":
		return s.log(p)
	case "history/list":
		root, err := s.root(p["root"])
		if err != nil {
			return nil, err
		}
		store, err := s.store(root)
		if err != nil {
			return nil, err
		}
		return store.History(), nil
	case "history/remove":
		root, err := s.root(p["root"])
		if err != nil {
			return nil, err
		}
		store, err := s.store(root)
		if err != nil {
			return nil, err
		}
		input, _ := p["input"].(string)
		if err := store.RemoveHistory(input); err != nil {
			return nil, err
		}
		return store.History(), nil
	}
	return nil, badRequest("Unknown method: %s", method)
}

// number reads a JSON number, or a string holding one, as JavaScript's
// Number() would.
func number(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return f, err == nil
	}
	return 0, false
}

func describe(value any) string {
	switch v := value.(type) {
	case nil:
		return "undefined"
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func (s *Service) root(value any) (string, error) {
	path, ok := value.(string)
	if !ok || !filepath.IsAbs(path) {
		return "", badRequest("root must be an absolute path.")
	}
	root := git.RepositoryRoot(path)
	if root == "" {
		return "", badRequest("%s is not inside a git work tree.", path)
	}
	return root, nil
}

// store is the repository's store, in `<git common dir>/incremental-diff/state.json`:
// next to the objects and refs that hold the snapshots it names, shared by
// the repository's worktrees (each review's scope names its root), and gone
// with the clone.
func (s *Service) store(root string) (*review.Store, error) {
	out, err := git.Run(root, []string{"rev-parse", "--path-format=absolute", "--git-common-dir"})
	if err != nil {
		return nil, err
	}
	common := strings.TrimSpace(out)
	s.mu.Lock()
	defer s.mu.Unlock()
	store := s.stores[common]
	if store == nil {
		store = review.NewStore(filepath.Join(common, "incremental-diff", "state.json"))
		s.stores[common] = store
	}
	return store, nil
}

func (s *Service) open(p params) (*WireReview, error) {
	root, err := s.root(p["root"])
	if err != nil {
		return nil, err
	}
	store, err := s.store(root)
	if err != nil {
		return nil, err
	}
	request := review.Request{Branch: truthy(p["branch"])}
	if !request.Branch {
		request.Input, _ = p["input"].(string)
	}
	baseBranch, _ := p["baseBranch"].(string)
	session, err := review.Open(store, root, request, review.Options{BaseBranch: baseBranch, Stats: p["stats"] != false})
	if err != nil {
		return nil, err
	}
	if !request.Branch {
		if err := store.AddHistory(request.Input); err != nil {
			return nil, err
		}
	}
	s.mu.Lock()
	open := &openReview{id: s.nextID, session: session, stop: make(chan struct{})}
	s.nextID++
	s.reviews[open.id] = open
	s.mu.Unlock()
	session.OnChange(func() { s.notify("review/changed", s.wire(open)) })
	if err := s.watchGit(open); err != nil {
		s.close(open.id)
		return nil, err
	}
	wire := s.wire(open)
	return &wire, nil
}

// truthy is JavaScript's truthiness of a JSON value.
func truthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case float64:
		return v != 0 && !math.IsNaN(v)
	case string:
		return v != ""
	}
	return true
}

func (s *Service) get(id any) (*openReview, error) {
	n, _ := number(id)
	s.mu.Lock()
	open := s.reviews[int(n)]
	s.mu.Unlock()
	if open == nil || float64(int(n)) != n {
		return nil, badRequest("No open review with id %s.", describe(id))
	}
	return open, nil
}

func (s *Service) close(id int) {
	s.mu.Lock()
	open := s.reviews[id]
	delete(s.reviews, id)
	s.mu.Unlock()
	if open == nil {
		return
	}
	close(open.stop)
	open.session.Close()
}

// Dispose closes every review (the client went away).
func (s *Service) Dispose() {
	s.mu.Lock()
	ids := make([]int, 0, len(s.reviews))
	for id := range s.reviews {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.close(id)
	}
}

func wireSide(side diff.Side) WireSide {
	if side.Kind == diff.Commit {
		return WireSide{Kind: string(side.Kind), SHA: side.SHA, Label: side.Label}
	}
	return WireSide{Kind: string(side.Kind)}
}

func (s *Service) wire(open *openReview) WireReview {
	session := open.session
	state := session.State()
	files := make([]WireFile, len(state.Files))
	for i, file := range state.Files {
		w := WireFile{
			Path:      file.Path,
			Status:    file.Status,
			OldPath:   file.OldPath,
			Untracked: file.Untracked,
			OldBlob:   file.OldBlob,
			NewBlob:   file.NewBlob,
			Binary:    file.Binary,
			Review:    string(file.Review),
		}
		if file.Added != nil {
			w.Added, w.Deleted = file.Added, file.Deleted
		}
		if file.Mark != nil {
			w.Snapshot, w.ReviewedAt = file.Mark.Snapshot, file.Mark.ReviewedAt
		}
		files[i] = w
	}
	return WireReview{
		ID:    open.id,
		Root:  session.Root,
		Title: session.Title,
		Key:   session.Spec.Key,
		Left:  wireSide(state.Left),
		Right: wireSide(state.Right),
		Files: files,
		Error: state.Error,
	}
}

var objectID = regexp.MustCompile(`^[0-9a-f]{4,64}$`)

func (s *Service) blob(p params) (*WireBlob, error) {
	root, err := s.root(p["root"])
	if err != nil {
		return nil, err
	}
	blob, ok := p["blob"].(string)
	if !ok || !objectID.MatchString(blob) {
		return nil, badRequest("blob must be an object id.")
	}
	text, err := git.Run(root, []string{"cat-file", "blob", blob})
	if err != nil {
		return nil, err
	}
	head := text
	if len(head) > 8000 {
		head = head[:8000]
	}
	if strings.IndexByte(head, 0) >= 0 {
		return &WireBlob{Binary: true}, nil
	}
	return &WireBlob{Text: &text}, nil
}

func (s *Service) log(p params) ([]WireCommit, error) {
	root, err := s.root(p["root"])
	if err != nil {
		return nil, err
	}
	path, ok := p["path"].(string)
	if !ok || path == "" {
		return nil, badRequest("path must be a path relative to the root.")
	}
	limit := 200
	if n, ok := number(p["limit"]); ok && n != 0 && !math.IsNaN(n) {
		limit = int(math.Max(1, math.Min(n, 2000)))
	}
	// --name-only gives the file's name in each commit (it changes across renames).
	out, _ := git.Try(root, []string{"log", "--follow", "-n" + strconv.Itoa(limit), "--name-only", "--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s", "--", path})
	commits := []WireCommit{}
	for _, record := range strings.Split(out, "\x1e") {
		if strings.TrimSpace(record) == "" {
			continue
		}
		lines := strings.Split(record, "\n")
		header := strings.Split(lines[0], "\x1f")
		for len(header) < 5 {
			header = append(header, "")
		}
		commit := WireCommit{SHA: header[0], Short: header[1], Author: header[2], Date: header[3], Subject: header[4], Path: path}
		for _, line := range lines[1:] {
			if name := strings.TrimSpace(line); name != "" {
				commit.Path = name
				break
			}
		}
		commits = append(commits, commit)
	}
	return commits, nil
}

// IsRequestError reports whether err is a bad request.
func IsRequestError(err error) bool {
	var e *RequestError
	return errors.As(err, &e)
}
