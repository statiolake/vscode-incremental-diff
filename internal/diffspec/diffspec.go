// Package diffspec parses `git diff` arguments into the two sides being
// compared.
//
// It is pure: it never runs git. Whether a bare word is a revision or a path
// is decided by the caller (diff.ResolveSpec), exactly as git itself would
// decide it.
package diffspec

import (
	"regexp"
	"strings"
	"unicode"
)

// EndpointKind names what one side of a diff is before it is resolved.
type EndpointKind string

const (
	Rev       EndpointKind = "rev"
	MergeBase EndpointKind = "mergeBase"
	Index     EndpointKind = "index"
	Worktree  EndpointKind = "worktree"
)

// Endpoint is one side of a diff before revisions are resolved to commits:
// a revision (Rev), the merge base of A and B, the index or the work tree.
type Endpoint struct {
	Kind EndpointKind
	Rev  string
	A, B string
}

// Spec is parsed `git diff` arguments.
type Spec struct {
	// Key is the canonical spelling of the arguments; review state is keyed by it.
	Key         string
	Left, Right Endpoint
	// Options are passed through to `git diff` unchanged (e.g. `-w`, `--diff-filter=M`).
	Options []string
	// Pathspecs: everything after `--`, plus bare words that are not revisions.
	Pathspecs []string
}

// Error is input that is not a diff Incremental Diff can show.
type Error struct{ Message string }

func (e *Error) Error() string { return e.Message }

func errorf(message string) error { return &Error{Message: message} }

// Tokenize splits a command line the way a POSIX shell would (quotes and
// backslashes).
func Tokenize(input string) ([]string, error) {
	tokens := []string{}
	var current strings.Builder
	inToken := false
	var quote rune
	runes := []rune(input)
	for i := 0; i < len(runes); i++ {
		char := runes[i]
		switch {
		case quote == '\'':
			if char == '\'' {
				quote = 0
			} else {
				current.WriteRune(char)
			}
		case quote == '"':
			if char == '"' {
				quote = 0
			} else if char == '\\' && i+1 < len(runes) && strings.ContainsRune("\"\\$`", runes[i+1]) {
				i++
				current.WriteRune(runes[i])
			} else {
				current.WriteRune(char)
			}
		case char == '\'' || char == '"':
			quote = char
			inToken = true
		case char == '\\' && i+1 < len(runes):
			i++
			current.WriteRune(runes[i])
			inToken = true
		case unicode.IsSpace(char):
			if inToken {
				tokens = append(tokens, current.String())
			}
			current.Reset()
			inToken = false
		default:
			current.WriteRune(char)
			inToken = true
		}
	}
	if quote != 0 {
		return nil, errorf("Unterminated " + string(quote) + " quote.")
	}
	if inToken {
		tokens = append(tokens, current.String())
	}
	return tokens, nil
}

var plainToken = regexp.MustCompile(`^[A-Za-z0-9@%+=:,./^~_{}*?!-]+$`)

// Quote quotes a token only when needed, so Key stays readable.
func Quote(token string) string {
	if token != "" && plainToken.MatchString(token) {
		return token
	}
	return "'" + strings.ReplaceAll(token, "'", `'\''`) + "'"
}

// Options that change the output format would break parsing of the raw diff.
var rejectedOptions = regexp.MustCompile(`^(-p|-u|-s|-z|--patch|--raw|--stat.*|--numstat|--shortstat|--dirstat.*|--summary|--name-only|--name-status|--check|--color.*|--output.*|--word-diff.*|--patch-with-.*|--no-patch|--compact-summary|--cumulative|--ext-diff|--textconv|--no-index|--format.*|--pretty.*)$`)

var ignoredOptions = map[string]bool{"--no-color": true, "--no-ext-diff": true, "--no-textconv": true, "--no-abbrev": true}

// Parse parses `git diff` arguments, as typed (a leading `git diff` is
// ignored). isRevision decides whether a bare word before `--` names a
// revision (true) or a path (false); nil takes every word as a revision.
// Words containing `..` or ending in `^!` are always revisions.
func Parse(input string, isRevision func(string) bool) (*Spec, error) {
	tokens, err := Tokenize(input)
	if err != nil {
		return nil, err
	}
	return ParseTokens(tokens, isRevision)
}

// ParseTokens is Parse on arguments already split.
func ParseTokens(tokens []string, isRevision func(string) bool) (*Spec, error) {
	if isRevision == nil {
		isRevision = func(string) bool { return true }
	}
	if len(tokens) >= 2 && tokens[0] == "git" && tokens[1] == "diff" {
		tokens = tokens[2:]
	} else if len(tokens) >= 1 && tokens[0] == "diff" {
		tokens = tokens[1:]
	}

	options := []string{}
	revisions := []string{}
	pathspecs := []string{}
	cached, mergeBase, afterDashDash := false, false, false
	for _, token := range tokens {
		switch {
		case afterDashDash:
			pathspecs = append(pathspecs, token)
		case token == "--":
			afterDashDash = true
		case strings.HasPrefix(token, "-") && token != "-":
			switch {
			case token == "--cached" || token == "--staged":
				cached = true
			case token == "--merge-base":
				mergeBase = true
			case rejectedOptions.MatchString(token):
				return nil, errorf(token + " changes git diff's output format and is not supported.")
			case !ignoredOptions[token]:
				options = append(options, token)
			}
		case isRevisionWord(token) || isRevision(token):
			if len(pathspecs) > 0 {
				return nil, errorf("Revision " + token + " must come before paths.")
			}
			revisions = append(revisions, token)
		default:
			pathspecs = append(pathspecs, token)
		}
	}

	left, right, err := endpoints(revisions, cached, mergeBase)
	if err != nil {
		return nil, err
	}
	var keyTokens []string
	if cached {
		keyTokens = append(keyTokens, "--cached")
	}
	if mergeBase {
		keyTokens = append(keyTokens, "--merge-base")
	}
	keyTokens = append(keyTokens, options...)
	keyTokens = append(keyTokens, revisions...)
	if len(pathspecs) > 0 {
		keyTokens = append(append(keyTokens, "--"), pathspecs...)
	}
	quoted := make([]string, len(keyTokens))
	for i, token := range keyTokens {
		quoted[i] = Quote(token)
	}
	return &Spec{Key: strings.Join(quoted, " "), Left: left, Right: right, Options: options, Pathspecs: pathspecs}, nil
}

func isRevisionWord(word string) bool {
	return strings.Contains(word, "..") || strings.HasSuffix(word, "^!")
}

func rev(r string) Endpoint { return Endpoint{Kind: Rev, Rev: r} }

func endpoints(revisions []string, cached, mergeBase bool) (Endpoint, Endpoint, error) {
	head := func(r string) string {
		if r == "" {
			return "HEAD"
		}
		return r
	}
	none := Endpoint{}
	switch len(revisions) {
	case 0:
		if mergeBase {
			return none, none, errorf("--merge-base needs a revision.")
		}
		if cached {
			return rev("HEAD"), Endpoint{Kind: Index}, nil
		}
		return Endpoint{Kind: Index}, Endpoint{Kind: Worktree}, nil
	case 1:
		word := revisions[0]
		threeDot := strings.Index(word, "...")
		twoDot := strings.Index(word, "..")
		if threeDot >= 0 || twoDot >= 0 || strings.HasSuffix(word, "^!") {
			if cached {
				return none, none, errorf("--cached cannot be combined with a revision range.")
			}
			if mergeBase && threeDot < 0 {
				return none, none, errorf("--merge-base cannot be combined with a revision range.")
			}
		}
		if threeDot >= 0 {
			a, b := head(word[:threeDot]), head(word[threeDot+3:])
			return Endpoint{Kind: MergeBase, A: a, B: b}, rev(b), nil
		}
		if twoDot >= 0 {
			return rev(head(word[:twoDot])), rev(head(word[twoDot+2:])), nil
		}
		if strings.HasSuffix(word, "^!") {
			r := strings.TrimSuffix(word, "^!")
			return rev(r + "^"), rev(r), nil
		}
		left := rev(word)
		if mergeBase {
			left = Endpoint{Kind: MergeBase, A: word, B: "HEAD"}
		}
		if cached {
			return left, Endpoint{Kind: Index}, nil
		}
		return left, Endpoint{Kind: Worktree}, nil
	case 2:
		if cached {
			return none, none, errorf("--cached compares a revision with the index; give at most one revision.")
		}
		if isRevisionWord(revisions[0]) || isRevisionWord(revisions[1]) {
			return none, none, errorf("A revision range must be the only revision.")
		}
		a, b := revisions[0], revisions[1]
		if mergeBase {
			return Endpoint{Kind: MergeBase, A: a, B: b}, rev(b), nil
		}
		return rev(a), rev(b), nil
	}
	return none, none, errorf("Combined diffs of more than two revisions are not supported.")
}

// Describe is a short human description of a spec, e.g. `git diff main...HEAD`,
// `Unstaged Changes`.
func Describe(spec *Spec) string {
	switch spec.Key {
	case "":
		return "Unstaged Changes"
	case "--cached":
		return "Staged Changes"
	}
	return "git diff " + spec.Key
}

// ComparesWithWorktree reports whether the right side is the work tree, so
// untracked files count as added.
func ComparesWithWorktree(spec *Spec) bool { return spec.Right.Kind == Worktree }

// BranchChangesArgs are the `git diff` arguments for Branch Changes: the
// merge base with base to the work tree.
func BranchChangesArgs(base string) []string { return []string{"--merge-base", base} }
