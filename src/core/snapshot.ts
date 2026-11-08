import { createHash } from "node:crypto";
import { ChangedFile, ResolvedSide, hashWorktreeFiles } from "./diff";
import { git } from "./git";

/** Snapshot value for a file whose right side is empty (a deletion). */
export const DELETED = "deleted";

const identity = {
  GIT_AUTHOR_NAME: "Incremental Diff",
  GIT_AUTHOR_EMAIL: "incremental-diff@localhost",
  GIT_COMMITTER_NAME: "Incremental Diff",
  GIT_COMMITTER_EMAIL: "incremental-diff@localhost"
};

/** The ref that keeps one review's snapshot blobs reachable. */
export function snapshotRef(scope: string): string {
  return `refs/incremental-diff/${createHash("sha256").update(scope).digest("hex").slice(0, 16)}`;
}

/**
 * Records the current right side of each file as a snapshot value: a blob id
 * written to the object database, or DELETED.
 */
export async function takeSnapshots(root: string, right: ResolvedSide, files: ChangedFile[]): Promise<Map<string, string>> {
  const snapshots = new Map<string, string>();
  const fromWorktree: ChangedFile[] = [];
  for (const file of files) {
    if (file.status === "D" || (right.kind !== "worktree" && !file.newBlob)) snapshots.set(file.path, DELETED);
    else if (right.kind === "worktree") fromWorktree.push(file);
    else snapshots.set(file.path, file.newBlob!);
  }
  const blobs = await hashWorktreeFiles(root, fromWorktree.map(file => file.path), true);
  fromWorktree.forEach((file, index) => snapshots.set(file.path, blobs[index] ?? DELETED));
  return snapshots;
}

/** The value the right side of `file` has now, comparable with a snapshot. */
export function currentSnapshotValue(file: ChangedFile): string {
  return file.newBlob ?? DELETED;
}

/**
 * Points `ref` at a commit whose tree holds every snapshot blob, so that
 * `git gc` keeps them, or deletes the ref when there are none.
 */
export async function writeSnapshotRef(root: string, ref: string, blobs: Iterable<string>): Promise<void> {
  const unique = [...new Set([...blobs].filter(blob => blob !== DELETED))].sort();
  if (unique.length === 0) {
    await git(root, ["update-ref", "-d", ref], { allowFailure: true });
    return;
  }
  const tree = (await git(root, ["mktree"], { input: unique.map(blob => `100644 blob ${blob}\t${blob}\n`).join("") })).trim();
  const existing = await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{tree}`], { allowFailure: true });
  if (existing?.trim() === tree) return;
  const commit = (await git(root, ["commit-tree", tree, "-m", "Incremental Diff review snapshots"], { env: identity })).trim();
  await git(root, ["update-ref", ref, commit]);
}

/** Deletes a review's snapshot ref. */
export async function deleteSnapshotRef(root: string, ref: string): Promise<void> {
  await git(root, ["update-ref", "-d", ref], { allowFailure: true });
}
