// The wire protocol between the Incremental Diff server and its clients:
// JSON-RPC 2.0, one JSON object per line on stdin / stdout (see
// docs/server.md). These types are the contract; the Lua client
// (lua/incremental_diff/client.lua) speaks them too.

export const protocolVersion = 1;

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
  status: "A" | "M" | "D" | "R" | "C" | "T" | "U";
  untracked?: boolean;
  /** Blob of the left side; absent when it is empty (added). */
  oldBlob?: string;
  /** Blob of the right side; absent when it is empty (deleted). */
  newBlob?: string;
  added?: number;
  deleted?: number;
  binary?: boolean;
  /** unreviewed | reviewed | changed (since it was reviewed). */
  review: "unreviewed" | "reviewed" | "changed";
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

export interface WireCommit {
  sha: string;
  short: string;
  author: string;
  date: string;
  subject: string;
  /** The file's path in this commit (before a later rename). */
  path: string;
}

/** Requests: method → [params, result]. */
export interface Methods {
  initialize: [{ client?: string }, { name: string; version: string; protocol: number }];
  /** Opens a review of the repository containing `root` (any folder in it). */
  "review/open": [{ root: string; input?: string; branch?: boolean; baseBranch?: string; stats?: boolean }, WireReview];
  "review/get": [{ id: number }, WireReview];
  "review/refresh": [{ id: number }, WireReview];
  "review/setReviewed": [{ id: number; paths: string[]; reviewed: boolean }, WireReview & { warning?: string }];
  "review/clearReviewed": [{ id: number }, WireReview];
  "review/close": [{ id: number }, null];
  /** A blob's text (`binary` when it holds a NUL byte, and then no text). */
  "git/blob": [{ root: string; blob: string }, { text?: string; binary?: boolean }];
  /** Commits that touched `path`, newest first, following renames. */
  "git/log": [{ root: string; path: string; limit?: number }, WireCommit[]];
  /** The `git diff` arguments opened before in this repository, most recent first. */
  "history/list": [{ root: string }, string[]];
  "history/remove": [{ root: string; input: string }, string[]];
}

/** Notifications from the server: method → params. */
export interface Notifications {
  /** A review's files or their state changed (a refresh, a mark, git's state). */
  "review/changed": WireReview;
}
