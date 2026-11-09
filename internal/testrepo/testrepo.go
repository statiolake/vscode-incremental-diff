// Package testrepo makes throwaway git repositories for tests.
package testrepo

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Repo is a throwaway git repository.
type Repo struct {
	t *testing.T
	// Root is canonical, as git reports it: the temp dir may sit behind a
	// symlink (macOS /var -> /private/var).
	Root string
}

// New makes an empty repository on branch main, removed after the test.
func New(t *testing.T) *Repo {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	r := &Repo{t: t, Root: root}
	r.Git("init", "-q", "-b", "main")
	r.Git("config", "user.name", "Test")
	r.Git("config", "user.email", "test@example.com")
	r.Git("config", "commit.gpgsign", "false")
	return r
}

// Git runs git in the repository and answers its output.
func (r *Repo) Git(args ...string) string {
	r.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = r.Root
	out, err := cmd.Output()
	if err != nil {
		stderr := ""
		if e, ok := err.(*exec.ExitError); ok {
			stderr = string(e.Stderr)
		}
		r.t.Fatalf("git %s: %v %s", strings.Join(args, " "), err, stderr)
	}
	return string(out)
}

// Write writes a file, making its folders.
func (r *Repo) Write(path, content string) {
	r.t.Helper()
	file := filepath.Join(r.Root, path)
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		r.t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
		r.t.Fatal(err)
	}
}

// Remove removes a file.
func (r *Repo) Remove(path string) {
	r.t.Helper()
	if err := os.Remove(filepath.Join(r.Root, path)); err != nil {
		r.t.Fatal(err)
	}
}

// Commit commits everything and answers the commit id.
func (r *Repo) Commit(message string) string {
	r.t.Helper()
	r.Git("add", "-A")
	r.Git("commit", "-q", "--allow-empty", "-m", message)
	return strings.TrimSpace(r.Git("rev-parse", "HEAD"))
}
