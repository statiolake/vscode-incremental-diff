// Package diff lists the files a diff changes, with their blobs and line
// counts (`git diff --raw` / `--numstat`).
package diff

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/statiolake/vscode-incremental-diff/internal/diffspec"
	"github.com/statiolake/vscode-incremental-diff/internal/git"
)

// RawEntry is one record of `git diff --raw -z`.
type RawEntry struct {
	Status string
	// Score is the similarity score of a rename or copy (-1: none).
	Score            int
	Path             string
	OldPath          *string
	OldMode, NewMode string
	OldBlob, NewBlob string
}

// SideKind names what a resolved side is.
type SideKind string

const (
	Commit   SideKind = "commit"
	Index    SideKind = "index"
	Worktree SideKind = "worktree"
)

// Side is a diff side after its revision was resolved.
type Side struct {
	Kind  SideKind
	SHA   string
	Label string
}

// ChangedFile is one file of a diff.
type ChangedFile struct {
	Status string
	// Path on the right side, relative to the repository root.
	Path string
	// OldPath is the left side's path of a rename or copy.
	OldPath *string
	// OldBlob is empty when the left side is empty (added files).
	OldBlob string
	// NewBlob is empty when the right side is empty (deleted files).
	NewBlob string
	// Untracked: a work tree file reported as added.
	Untracked bool
	// Stats: lines added and deleted; absent for binary files.
	Added, Deleted *int
	// Binary: git sees binary content on either side.
	Binary bool
}

// Result is a listed diff.
type Result struct {
	Spec        *diffspec.Spec
	Left, Right Side
	Files       []*ChangedFile
}

var nullOID = regexp.MustCompile(`^0+$`)

var whitespace = regexp.MustCompile(`\s+`)

// ParseRaw parses `git diff --raw -z --no-abbrev` output.
func ParseRaw(output string) ([]RawEntry, error) {
	fields := git.SplitZ(output)
	entries := []RawEntry{}
	for i := 0; i < len(fields); {
		meta := whitespace.Split(strings.TrimSpace(strings.TrimPrefix(fields[i], ":")), -1)
		if !strings.HasPrefix(fields[i], ":") || len(meta) != 5 {
			return nil, fmt.Errorf("Unexpected git diff --raw record: %q", fields[i])
		}
		statusField := meta[4]
		status := statusField[:1]
		if !strings.Contains("AMDRCTU", status) {
			return nil, fmt.Errorf("Unknown git diff status: %s", statusField)
		}
		entry := RawEntry{Status: status, Score: -1, OldMode: meta[0], NewMode: meta[1], OldBlob: meta[2], NewBlob: meta[3]}
		if len(statusField) > 1 {
			if score, err := strconv.Atoi(statusField[1:]); err == nil {
				entry.Score = score
			}
		}
		if status == "R" || status == "C" {
			if i+2 >= len(fields) {
				return nil, fmt.Errorf("Truncated git diff --raw output.")
			}
			oldPath := fields[i+1]
			entry.OldPath, entry.Path = &oldPath, fields[i+2]
			i += 3
		} else {
			if i+1 >= len(fields) {
				return nil, fmt.Errorf("Truncated git diff --raw output.")
			}
			entry.Path = fields[i+1]
			i += 2
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

// ResolveCommit resolves rev to a commit id, or "" if it names none.
func ResolveCommit(root, rev string) string {
	out, ok := git.Try(root, []string{"rev-parse", "--verify", "--quiet", "--end-of-options", rev + "^{commit}"})
	if !ok {
		return ""
	}
	return strings.TrimSpace(out)
}

// ResolveSpec parses input, deciding like git whether bare words are
// revisions or paths: without `--`, a word that names no commit is a path;
// with `--`, every word before it must be a revision.
func ResolveSpec(root, input string) (*diffspec.Spec, error) {
	tokens, err := diffspec.Tokenize(input)
	if err != nil {
		return nil, err
	}
	dashDash := -1
	for i, token := range tokens {
		if token == "--" {
			dashDash = i
			break
		}
	}
	revisions := map[string]bool{}
	for index, token := range tokens {
		if dashDash >= 0 && index > dashDash {
			break
		}
		if token == "--" || strings.HasPrefix(token, "-") || index < 2 && (token == "git" || token == "diff") {
			continue
		}
		if strings.Contains(token, "..") || strings.HasSuffix(token, "^!") || ResolveCommit(root, token) != "" {
			revisions[token] = true
		} else if dashDash >= 0 {
			return nil, &diffspec.Error{Message: "Unknown revision: " + token}
		}
	}
	return diffspec.ParseTokens(tokens, func(word string) bool { return revisions[word] })
}

func resolveSide(root string, endpoint diffspec.Endpoint) (Side, error) {
	switch endpoint.Kind {
	case diffspec.Index:
		return Side{Kind: Index}, nil
	case diffspec.Worktree:
		return Side{Kind: Worktree}, nil
	case diffspec.Rev:
		if sha := ResolveCommit(root, endpoint.Rev); sha != "" {
			return Side{Kind: Commit, SHA: sha, Label: endpoint.Rev}, nil
		}
		// The parent of a root commit (`X^!`, `X^..X`): nothing, the empty tree.
		if strings.HasSuffix(endpoint.Rev, "^") && ResolveCommit(root, strings.TrimSuffix(endpoint.Rev, "^")) != "" {
			empty, err := git.Run(root, []string{"hash-object", "-t", "tree", "--stdin"}, git.Input(""))
			if err != nil {
				return Side{}, err
			}
			return Side{Kind: Commit, SHA: strings.TrimSpace(empty), Label: endpoint.Rev + " (none)"}, nil
		}
		return Side{}, &diffspec.Error{Message: "Unknown revision: " + endpoint.Rev}
	case diffspec.MergeBase:
		for _, rev := range []string{endpoint.A, endpoint.B} {
			if ResolveCommit(root, rev) == "" {
				return Side{}, &diffspec.Error{Message: "Unknown revision: " + rev}
			}
		}
		out, _ := git.Try(root, []string{"merge-base", "--end-of-options", endpoint.A, endpoint.B})
		sha := strings.TrimSpace(out)
		if sha == "" {
			return Side{}, &diffspec.Error{Message: fmt.Sprintf("%s and %s have no common ancestor.", endpoint.A, endpoint.B)}
		}
		return Side{Kind: Commit, SHA: sha, Label: fmt.Sprintf("merge-base(%s, %s)", endpoint.A, endpoint.B)}, nil
	}
	return Side{}, fmt.Errorf("unknown endpoint %q", endpoint.Kind)
}

// Args are the `git diff` arguments comparing two resolved sides.
func Args(left, right Side, spec *diffspec.Spec) ([]string, error) {
	args := append([]string{"diff", "--raw", "-z", "--no-abbrev", "--no-ext-diff", "--no-color"}, spec.Options...)
	switch {
	case left.Kind == Index && right.Kind == Worktree:
		// plain `git diff`
	case left.Kind == Commit && right.Kind == Worktree:
		args = append(args, left.SHA)
	case left.Kind == Commit && right.Kind == Index:
		args = append(args, "--cached", left.SHA)
	case left.Kind == Commit && right.Kind == Commit:
		args = append(args, left.SHA, right.SHA)
	default:
		return nil, &diffspec.Error{Message: fmt.Sprintf("Cannot compare %s with %s.", left.Kind, right.Kind)}
	}
	return append(append(args, "--"), spec.Pathspecs...), nil
}

// List lists the files changed by spec, with blob ids for both sides; with
// stats, their added and deleted line counts too.
func List(root string, spec *diffspec.Spec, stats bool) (*Result, error) {
	left, err := resolveSide(root, spec.Left)
	if err != nil {
		return nil, err
	}
	right, err := resolveSide(root, spec.Right)
	if err != nil {
		return nil, err
	}
	args, err := Args(left, right, spec)
	if err != nil {
		return nil, err
	}
	out, err := git.Run(root, args)
	if err != nil {
		return nil, err
	}
	raw, err := ParseRaw(out)
	if err != nil {
		return nil, err
	}
	files := []*ChangedFile{}
	for _, entry := range raw {
		if entry.OldMode == "160000" || entry.NewMode == "160000" { // submodules
			continue
		}
		file := &ChangedFile{Status: entry.Status, Path: entry.Path, OldPath: entry.OldPath}
		if entry.Status != "A" && !nullOID.MatchString(entry.OldBlob) {
			file.OldBlob = entry.OldBlob
		}
		if entry.Status != "D" && !nullOID.MatchString(entry.NewBlob) {
			file.NewBlob = entry.NewBlob
		}
		files = append(files, file)
	}

	if diffspec.ComparesWithWorktree(spec) {
		listed := map[string]bool{}
		for _, file := range files {
			listed[file.Path] = true
		}
		out, err := git.Run(root, append([]string{"ls-files", "-z", "--others", "--exclude-standard", "--"}, spec.Pathspecs...))
		if err != nil {
			return nil, err
		}
		for _, path := range git.SplitZ(out) {
			if !strings.HasSuffix(path, "/") && !listed[path] {
				files = append(files, &ChangedFile{Status: "A", Path: path, Untracked: true})
			}
		}
		// Hash work tree content ourselves (without filters) so that the id
		// always matches what `git hash-object -w --no-filters` stores for a
		// snapshot.
		var present []*ChangedFile
		var paths []string
		for _, file := range files {
			if file.Status != "D" {
				present = append(present, file)
				paths = append(paths, file.Path)
			}
		}
		blobs := HashWorktreeFiles(root, paths, false)
		for i, file := range present {
			file.NewBlob = blobs[i]
		}
	}

	if stats {
		addStats(root, args, files)
	}
	sort.SliceStable(files, func(a, b int) bool { return files[a].Path < files[b].Path })
	return &Result{Spec: spec, Left: left, Right: right, Files: files}, nil
}

// HashWorktreeFiles answers the blob ids of work tree files, "" for files
// that vanished. With write, the blobs are also stored in the object
// database.
func HashWorktreeFiles(root string, paths []string, write bool) []string {
	if len(paths) == 0 {
		return nil
	}
	args := []string{"hash-object", "--no-filters"}
	if write {
		args = append(args, "-w")
	}
	if out, ok := git.Try(root, append(args, "--stdin-paths"), git.Input(strings.Join(paths, "\n")+"\n")); ok {
		blobs := strings.Split(strings.TrimSpace(out), "\n")
		if len(blobs) == len(paths) {
			return blobs
		}
	}
	// Some file vanished between listing and hashing; fall back to one by one.
	blobs := make([]string, len(paths))
	var wg sync.WaitGroup
	limit := make(chan struct{}, 8)
	for i, path := range paths {
		wg.Add(1)
		go func() {
			defer wg.Done()
			limit <- struct{}{}
			defer func() { <-limit }()
			if out, ok := git.Try(root, append(append([]string{}, args...), "--", path)); ok {
				blobs[i] = strings.TrimSpace(out)
			}
		}()
	}
	wg.Wait()
	return blobs
}

// Stat is one file's line counts: Binary, or Added and Deleted.
type Stat struct {
	Added, Deleted int
	Binary         bool
}

// ParseNumstat parses `git diff --numstat -z`: added, deleted ("-" for
// binary) and the path (the new one for renames).
func ParseNumstat(output string) map[string]Stat {
	fields := git.SplitZ(output)
	stats := map[string]Stat{}
	for i := 0; i < len(fields); {
		parts := strings.SplitN(fields[i], "\t", 3)
		i++
		name := ""
		if len(parts) == 3 {
			name = parts[2]
		}
		// A rename or copy: "added\tdeleted\t" then the old and new paths.
		if name == "" {
			if i+1 >= len(fields) {
				break
			}
			name = fields[i+1]
			i += 2
		}
		if parts[0] == "-" {
			stats[name] = Stat{Binary: true}
			continue
		}
		added, _ := strconv.Atoi(parts[0])
		deleted := 0
		if len(parts) > 1 {
			deleted, _ = strconv.Atoi(parts[1])
		}
		stats[name] = Stat{Added: added, Deleted: deleted}
	}
	return stats
}

func addStats(root string, rawArgs []string, files []*ChangedFile) {
	args := make([]string, len(rawArgs))
	for i, arg := range rawArgs {
		if arg == "--raw" {
			arg = "--numstat"
		}
		args[i] = arg
	}
	out, _ := git.Try(root, args)
	stats := ParseNumstat(out)
	for _, file := range files {
		if stat, ok := stats[file.Path]; ok {
			file.apply(stat)
		} else if file.Untracked {
			if stat, ok := countLines(filepath.Join(root, file.Path)); ok {
				file.apply(stat)
			}
		}
	}
}

func (f *ChangedFile) apply(stat Stat) {
	if stat.Binary {
		f.Binary = true
		return
	}
	added, deleted := stat.Added, stat.Deleted
	f.Added, f.Deleted = &added, &deleted
}

// countLines counts an untracked file as all added (binary when it holds a
// NUL byte).
func countLines(path string) (Stat, bool) {
	content, err := os.ReadFile(path)
	if err != nil {
		return Stat{}, false
	}
	if bytes.IndexByte(content, 0) >= 0 {
		return Stat{Binary: true}, true
	}
	if len(content) == 0 {
		return Stat{}, true
	}
	lines := bytes.Count(content, []byte{'\n'})
	if content[len(content)-1] != '\n' {
		lines++
	}
	return Stat{Added: lines}, true
}
