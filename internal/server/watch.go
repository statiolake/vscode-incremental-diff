package server

import (
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/statiolake/vscode-incremental-diff/internal/git"
)

// watchGit watches git's own state for a review (HEAD, the index, refs being
// packed, a commit message written), cheaply: the regular files at the top
// level of its git directory, looked at every PollInterval. A change
// refreshes the review once WatchDelay has passed without another.
//
// Changes to work tree files are the client's to report (`review/refresh`
// on a save, focus or shell command): it knows them without watching a
// whole tree, which for a large repository costs more than it saves.
func (s *Service) watchGit(open *openReview) error {
	out, err := git.Run(open.session.Root, []string{"rev-parse", "--absolute-git-dir"})
	if err != nil {
		return err
	}
	dir := strings.TrimSpace(out)
	go func() {
		ticker := time.NewTicker(s.options.PollInterval)
		defer ticker.Stop()
		last := gitState(dir)
		var timer *time.Timer
		defer func() {
			if timer != nil {
				timer.Stop()
			}
		}()
		for {
			select {
			case <-open.stop:
				return
			case <-ticker.C:
				now := gitState(dir)
				if now == last {
					continue
				}
				last = now
				if timer != nil {
					timer.Stop()
				}
				timer = time.AfterFunc(s.options.WatchDelay, open.session.Refresh)
			}
		}
	}()
	return nil
}

// gitState sums up the top level of a git directory: each regular file's
// name, size and modification time, leaving out lock and temporary files.
func gitState(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	var parts []string
	for _, entry := range entries {
		name := entry.Name()
		if !entry.Type().IsRegular() || strings.HasSuffix(name, ".lock") || strings.HasSuffix(name, ".tmp") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		parts = append(parts, name+"\x00"+info.ModTime().Format(time.RFC3339Nano)+"\x00"+strconv.FormatInt(info.Size(), 10))
	}
	sort.Strings(parts)
	return strings.Join(parts, "\n")
}
