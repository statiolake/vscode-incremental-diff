// Package git runs git for the core: with output formats pinned, no prompts
// and no pager, in a given directory.
package git

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Error is a git command that exited non-zero.
type Error struct {
	Args   []string
	Stderr string
	msg    string
}

func (e *Error) Error() string { return e.msg }

// Options for Run.
type Options struct {
	// Input is written to git's stdin.
	Input *string
	// Env is added to the environment.
	Env []string
}

// Keep git from prompting, paging, or picking up unrelated user
// configuration that changes output formats.
var baseArgs = []string{"-c", "core.quotepath=off", "-c", "color.ui=false"}

// Run runs git in dir and answers its stdout.
func Run(dir string, args []string, opts ...Options) (string, error) {
	var o Options
	if len(opts) > 0 {
		o = opts[0]
	}
	cmd := exec.Command("git", append(append([]string{}, baseArgs...), args...)...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C")
	cmd.Env = append(cmd.Env, o.Env...)
	if o.Input != nil {
		cmd.Stdin = strings.NewReader(*o.Input)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return "", &Error{Args: args, Stderr: stderr.String(), msg: fmt.Sprintf("git %s failed: %s", strings.Join(args, " "), detail)}
	}
	return stdout.String(), nil
}

// Try runs git and answers ok=false instead of an error when it fails.
func Try(dir string, args []string, opts ...Options) (string, bool) {
	out, err := Run(dir, args, opts...)
	return out, err == nil
}

// Input makes an Options with stdin.
func Input(s string) Options { return Options{Input: &s} }

// IsError reports whether err is a failed git command.
func IsError(err error) bool {
	var e *Error
	return errors.As(err, &e)
}

// SplitZ splits NUL-terminated output, dropping the trailing empty field.
func SplitZ(output string) []string {
	fields := strings.Split(output, "\x00")
	if len(fields) > 0 && fields[len(fields)-1] == "" {
		fields = fields[:len(fields)-1]
	}
	return fields
}

// RepositoryRoot is the top level of the work tree containing path, or ""
// outside git.
func RepositoryRoot(path string) string {
	out, ok := Try(path, []string{"rev-parse", "--show-toplevel"})
	if !ok {
		return ""
	}
	return strings.TrimSpace(out)
}
