package diffspec

import (
	"reflect"
	"testing"
)

func mustParse(t *testing.T, input string) *Spec {
	t.Helper()
	spec, err := Parse(input, nil)
	if err != nil {
		t.Fatalf("%q: %v", input, err)
	}
	return spec
}

func sides(spec *Spec) [2]Endpoint { return [2]Endpoint{spec.Left, spec.Right} }

func expectSides(t *testing.T, input string, left, right Endpoint) *Spec {
	t.Helper()
	spec := mustParse(t, input)
	if got := sides(spec); got != [2]Endpoint{left, right} {
		t.Errorf("%q: sides %+v, want %+v %+v", input, got, left, right)
	}
	return spec
}

func TestTokenizesLikeAShell(t *testing.T) {
	tokens, err := Tokenize(`  main...HEAD -- "src/a b.ts" 'it''s' c\ d `)
	if err != nil || !reflect.DeepEqual(tokens, []string{"main...HEAD", "--", "src/a b.ts", "its", "c d"}) {
		t.Errorf("tokens %q, %v", tokens, err)
	}
	if tokens, _ := Tokenize(""); len(tokens) != 0 {
		t.Errorf("empty: %q", tokens)
	}
	if tokens, _ := Tokenize(`""`); !reflect.DeepEqual(tokens, []string{""}) {
		t.Errorf(`"": %q`, tokens)
	}
	if _, err := Tokenize(`"open`); err == nil {
		t.Error("an open quote is an error")
	}
}

var (
	index    = Endpoint{Kind: Index}
	worktree = Endpoint{Kind: Worktree}
)

func TestNoArgumentsCompareTheIndexWithTheWorkTree(t *testing.T) {
	spec := expectSides(t, "", index, worktree)
	if spec.Key != "" || Describe(spec) != "Unstaged Changes" {
		t.Errorf("key %q, %q", spec.Key, Describe(spec))
	}
}

func TestCachedComparesARevisionWithTheIndex(t *testing.T) {
	for _, input := range []string{"--cached", "--staged"} {
		spec := expectSides(t, input, rev("HEAD"), index)
		if spec.Key != "--cached" || Describe(spec) != "Staged Changes" {
			t.Errorf("%q: key %q", input, spec.Key)
		}
	}
	if spec := expectSides(t, "--staged main", rev("main"), index); spec.Key != "--cached main" {
		t.Errorf("key %q", spec.Key)
	}
}

func TestOneRevisionComparesItWithTheWorkTree(t *testing.T) {
	expectSides(t, "HEAD~3", rev("HEAD~3"), worktree)
}

func TestRanges(t *testing.T) {
	expectSides(t, "a..b", rev("a"), rev("b"))
	expectSides(t, "a..", rev("a"), rev("HEAD"))
	expectSides(t, "main...feature", Endpoint{Kind: MergeBase, A: "main", B: "feature"}, rev("feature"))
	expectSides(t, "main...", Endpoint{Kind: MergeBase, A: "main", B: "HEAD"}, rev("HEAD"))
	expectSides(t, "abc^!", rev("abc^"), rev("abc"))
	expectSides(t, "a b", rev("a"), rev("b"))
}

func TestMergeBase(t *testing.T) {
	expectSides(t, "--merge-base origin/main", Endpoint{Kind: MergeBase, A: "origin/main", B: "HEAD"}, worktree)
	expectSides(t, "--merge-base a b", Endpoint{Kind: MergeBase, A: "a", B: "b"}, rev("b"))
	for _, input := range []string{"--merge-base", "--merge-base a..b"} {
		if _, err := Parse(input, nil); err == nil {
			t.Errorf("%q is an error", input)
		}
	}
}

func TestPathspecsAndOptions(t *testing.T) {
	spec := mustParse(t, "git diff -w main -- src 'docs/a b.md'")
	if !reflect.DeepEqual(spec.Options, []string{"-w"}) || !reflect.DeepEqual(spec.Pathspecs, []string{"src", "docs/a b.md"}) {
		t.Errorf("options %q pathspecs %q", spec.Options, spec.Pathspecs)
	}
	if spec.Key != "-w main -- src 'docs/a b.md'" {
		t.Errorf("key %q", spec.Key)
	}
	paths, err := Parse("main src", func(word string) bool { return word == "main" })
	if err != nil || !reflect.DeepEqual(paths.Pathspecs, []string{"src"}) || paths.Left != rev("main") {
		t.Errorf("%+v %v", paths, err)
	}
}

func TestEquivalentSpellingsShareOneKey(t *testing.T) {
	pairs := [][2]string{{"  --staged   HEAD ", "--cached HEAD"}, {"git diff main...HEAD", "main...HEAD"}, {"--no-color main", "main"}}
	for _, pair := range pairs {
		if a, b := mustParse(t, pair[0]).Key, mustParse(t, pair[1]).Key; a != b {
			t.Errorf("%q: %q, %q: %q", pair[0], a, pair[1], b)
		}
	}
	if key := mustParse(t, "--no-color main").Key; key != "main" {
		t.Errorf("key %q", key)
	}
}

func TestRejectsUnsupportedArguments(t *testing.T) {
	for _, input := range []string{"--stat", "--name-only", "-p main", "a b c", "--cached a..b", "--cached a b", "a..b c", "--word-diff"} {
		_, err := Parse(input, nil)
		if _, ok := err.(*Error); !ok {
			t.Errorf("%q: %v", input, err)
		}
	}
}

func TestQuote(t *testing.T) {
	for token, want := range map[string]string{"main": "main", "": "''", "a b": "'a b'", "it's": `'it'\''s'`, "HEAD~3^!": "HEAD~3^!"} {
		if got := Quote(token); got != want {
			t.Errorf("Quote(%q) = %q, want %q", token, got, want)
		}
	}
}
