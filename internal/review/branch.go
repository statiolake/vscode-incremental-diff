package review

import (
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/statiolake/vscode-incremental-diff/internal/git"
)

var remotePrefix = regexp.MustCompile(`^refs/remotes/[^/]+/`)
var branchPrefix = regexp.MustCompile(`^refs/(heads|remotes)/`)

// DetectBaseBranch answers the branch that Branch Changes compares against:
// the configured one, else the branch HEAD forked from ("" when none).
//
// The fork point is the branch whose merge base with HEAD is closest to
// HEAD. Candidates are every local and remote-tracking branch except HEAD's
// own (the current branch, its upstream, and same-named remote branches)
// and branches that already contain HEAD and go further, which forked from
// HEAD rather than the other way round. Candidates tied on distance share
// the same merge base, so the diff is the same whichever name wins.
func DetectBaseBranch(root, configured string) (string, error) {
	if c := strings.TrimSpace(configured); c != "" {
		return c, nil
	}
	headOut, _ := git.Try(root, []string{"rev-parse", "--verify", "--quiet", "HEAD"})
	head := strings.TrimSpace(headOut)
	if head == "" {
		return "", nil
	}
	currentOut, _ := git.Try(root, []string{"symbolic-ref", "--quiet", "--short", "HEAD"})
	current := strings.TrimSpace(currentOut)
	upstreamOut, _ := git.Try(root, []string{"rev-parse", "--symbolic-full-name", "@{upstream}"})
	upstream := strings.TrimSpace(upstreamOut)
	own := func(ref string) bool {
		return ref == upstream || ref == "refs/heads/"+current || remotePrefix.ReplaceAllString(ref, "") == current
	}

	// Ref names cannot contain tabs or newlines.
	out, err := git.Run(root, []string{"for-each-ref", "--format=%(refname)%09%(symref)%09%(objectname)", "refs/heads", "refs/remotes"})
	if err != nil {
		return "", err
	}
	type candidate struct{ ref, tip string }
	var refs []candidate
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) != 3 || parts[1] != "" || own(parts[0]) {
			continue
		}
		refs = append(refs, candidate{parts[0], parts[2]})
	}

	distances := make([]int, len(refs))
	errs := make([]error, len(refs))
	var wg sync.WaitGroup
	limit := make(chan struct{}, 8)
	for i, c := range refs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			limit <- struct{}{}
			defer func() { <-limit }()
			distances[i] = -1
			// Exit status 1 means no common ancestor: not a fork point.
			baseOut, _ := git.Try(root, []string{"merge-base", head, c.tip})
			base := strings.TrimSpace(baseOut)
			if base == "" || (base == head && c.tip != head) {
				return
			}
			count, err := git.Run(root, []string{"rev-list", "--count", base + ".." + head})
			if err != nil {
				errs[i] = err
				return
			}
			distances[i], _ = strconv.Atoi(strings.TrimSpace(count))
		}()
	}
	wg.Wait()
	best := -1
	for i := range refs {
		if errs[i] != nil {
			return "", errs[i]
		}
		if distances[i] >= 0 && (best < 0 || distances[i] < distances[best]) {
			best = i
		}
	}
	if best < 0 {
		return "", nil
	}
	return branchPrefix.ReplaceAllString(refs[best].ref, ""), nil
}
