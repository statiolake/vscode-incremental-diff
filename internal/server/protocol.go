// Package server is Incremental Diff's core behind JSON-RPC 2.0 on stdio,
// one JSON object per line (docs/server.md). A client (the Neovim plugin,
// the VS Code extension) starts it as a child process and it ends with
// them: when stdin closes, every review is closed and it returns.
package server

// ProtocolVersion is answered by `initialize`.
const ProtocolVersion = 1

// WireSide is one side of the diff as resolved when the review was opened or
// refreshed: { kind: "commit", sha, label } | { kind: "index" } | { kind: "worktree" }.
type WireSide struct {
	Kind  string `json:"kind"`
	SHA   string `json:"sha,omitempty"`
	Label string `json:"label,omitempty"`
}

// WireFile is one changed file.
type WireFile struct {
	// Path on the right side, relative to the repository root, `/`-separated.
	Path   string `json:"path"`
	Status string `json:"status"`
	// OldPath is the left side's path of a rename or copy.
	OldPath   *string `json:"oldPath,omitempty"`
	Untracked bool    `json:"untracked,omitempty"`
	// OldBlob is absent when the left side is empty (added).
	OldBlob string `json:"oldBlob,omitempty"`
	// NewBlob is absent when the right side is empty (deleted).
	NewBlob string `json:"newBlob,omitempty"`
	Added   *int   `json:"added,omitempty"`
	Deleted *int   `json:"deleted,omitempty"`
	Binary  bool   `json:"binary,omitempty"`
	// Review is unreviewed | reviewed | changed (since it was reviewed).
	Review string `json:"review"`
	// Snapshot is, when reviewed, the right side's blob then ("deleted" for
	// a deletion); ReviewedAt when.
	Snapshot   string `json:"snapshot,omitempty"`
	ReviewedAt string `json:"reviewedAt,omitempty"`
}

// WireReview is a review's state.
type WireReview struct {
	ID    int    `json:"id"`
	Root  string `json:"root"`
	Title string `json:"title"`
	// Key is the canonical `git diff` arguments: the review's identity.
	Key   string     `json:"key"`
	Left  WireSide   `json:"left"`
	Right WireSide   `json:"right"`
	Files []WireFile `json:"files"`
	// Error: the last refresh failed with this; files are from before it.
	Error string `json:"error,omitempty"`
	// Warning (review/setReviewed only): the snapshots are not protected
	// from git gc.
	Warning string `json:"warning,omitempty"`
}

// WireCommit is one commit of a file's history.
type WireCommit struct {
	SHA     string `json:"sha"`
	Short   string `json:"short"`
	Author  string `json:"author"`
	Date    string `json:"date"`
	Subject string `json:"subject"`
	// Path is the file's path in this commit (before a later rename).
	Path string `json:"path"`
}

// WireBlob is a blob's text, or binary (it holds a NUL byte) and no text.
type WireBlob struct {
	Text   *string `json:"text,omitempty"`
	Binary bool    `json:"binary,omitempty"`
}

// Initialized is the answer to `initialize`.
type Initialized struct {
	Name     string `json:"name"`
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
}
