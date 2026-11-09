// The wire protocol of the core, incremental-diff (cmd/incremental-diff):
// JSON-RPC 2.0, one JSON object per line on stdin / stdout (docs/server.md).
// The Go server's types (internal/server/protocol.go) are the contract; the
// Lua client (lua/incremental_diff/client.lua) speaks them too.

export const protocolVersion = 1;

export type FileStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U";

export type ReviewStatus = "unreviewed" | "reviewed" | "changed";

/** One side of the diff as resolved when the review was opened or refreshed. */
export type WireSide =
  | { kind: "commit"; sha: string; label: string }
  | { kind: "index" }
  | { kind: "worktree" };

export interface WireFile {
  /** Right-side path, relative to the repository root, `/`-separated. */
  path: string;
  /** Left-side path of a rename or copy. */
  oldPath?: string;
  status: FileStatus;
  untracked?: boolean;
  /** Blob of the left side; absent when it is empty (added). */
  oldBlob?: string;
  /** Blob of the right side; absent when it is empty (deleted). */
  newBlob?: string;
  added?: number;
  deleted?: number;
  binary?: boolean;
  /** unreviewed | reviewed | changed (since it was reviewed). */
  review: ReviewStatus;
  /** When reviewed: the right side's blob then ("deleted" for a deletion) and when. */
  snapshot?: string;
  reviewedAt?: string;
}

export interface WireReview {
  id: number;
  root: string;
  title: string;
  /** The canonical `git diff` arguments: the review's identity. */
  key: string;
  left: WireSide;
  right: WireSide;
  files: WireFile[];
  /** The last refresh failed with this; files are from before it. */
  error?: string;
}

/** The snapshot of a file reviewed while deleted. */
export const DELETED = "deleted";

/** Requests: method → [params, result]. */
export interface Methods {
  initialize: [{ client?: string }, { name: string; version: string; protocol: number }];
  "review/open": [{ root: string; input?: string; branch?: boolean; baseBranch?: string; stats?: boolean }, WireReview];
  "review/get": [{ id: number }, WireReview];
  "review/refresh": [{ id: number }, WireReview];
  "review/setReviewed": [{ id: number; paths: string[]; reviewed: boolean }, WireReview & { warning?: string }];
  "review/clearReviewed": [{ id: number }, WireReview];
  "review/close": [{ id: number }, null];
  "git/blob": [{ root: string; blob: string }, { text?: string; binary?: boolean }];
  "history/list": [{ root: string }, string[]];
  "history/remove": [{ root: string; input: string }, string[]];
}
