// One open review: a diff, its files and their reviewed state. This is the
// whole of Incremental Diff's logic without an editor: the VS Code extension
// holds one in process, the server (src/server) holds them for clients that
// talk JSON-RPC. Nothing here imports `vscode`.

import { branchChangesArgs, detectBaseBranch } from "./branch";
import { DiffResult, listChanges, resolveSpec } from "./diff";
import { DiffSpec, describeSpec, parseDiffSpec } from "./diffSpec";
import { DELETED, currentSnapshotValue, deleteSnapshotRef, snapshotRef, takeSnapshots, writeSnapshotRef } from "./snapshot";
import { ReviewStateStore, reviewScope, reviewStatus } from "./state";
import { ReviewFile, nextUnreviewed } from "./treeModel";

/** What to review: `git diff` arguments as typed, or Branch Changes. */
export type OpenRequest = { input: string } | { branch: true };

export interface OpenOptions {
  /** Base branch for Branch Changes; empty detects it. */
  baseBranch?: string;
  /**
   * What identifies the review's folder in the store (with the spec's key).
   * The VS Code extension passes its workspace folder's URI, so marks it
   * stored before stay found; the default is the repository root.
   */
  folder?: string;
  /** Named in the error when no base branch is found, e.g. a setting. */
  baseBranchSetting?: string;
  /** Count added and deleted lines per file (`git diff --numstat`). */
  stats?: boolean;
}

export class ReviewSession {
  result: DiffResult;
  files: ReviewFile[] = [];
  error: string | undefined;
  readonly ref: string;
  private listeners = new Set<() => void>();
  private refreshing: Promise<void> | undefined;
  private refreshAgain = false;
  private closed = false;

  private constructor(
    private readonly store: ReviewStateStore,
    readonly root: string,
    readonly request: OpenRequest,
    readonly spec: DiffSpec,
    readonly title: string,
    readonly scope: string,
    readonly stats: boolean,
    result: DiffResult
  ) {
    this.ref = snapshotRef(scope);
    this.result = result;
    this.apply(result);
  }

  /** Opens a review of the repository at `root`; rejects bad input without side effects. */
  static async open(store: ReviewStateStore, root: string, request: OpenRequest, options: OpenOptions = {}): Promise<ReviewSession> {
    let spec: DiffSpec;
    let title: string;
    if ("branch" in request) {
      const base = await detectBaseBranch(root, options.baseBranch ?? "");
      if (!base) throw new Error(`Could not find a base branch. Set ${options.baseBranchSetting ?? "the base branch"}.`);
      spec = parseDiffSpec(branchChangesArgs(base));
      title = `Branch Changes (${base})`;
    } else {
      spec = await resolveSpec(root, request.input);
      title = describeSpec(spec);
    }
    const stats = options.stats ?? false;
    const result = await listChanges(root, spec, { stats });
    const scope = reviewScope(options.folder ?? root, spec.key);
    return new ReviewSession(store, root, request, spec, title, scope, stats, result);
  }

  /** Calls `listener` whenever the files or their state change. Answers an unsubscribe. */
  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    if (this.closed) return;
    for (const listener of this.listeners) listener();
  }

  /** Re-runs the diff now (coalescing with a refresh already running). */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        await this.refreshOnce();
      } while (this.refreshAgain);
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async refreshOnce(): Promise<void> {
    if (this.closed) return;
    try {
      const result = await listChanges(this.root, this.spec, { stats: this.stats });
      if (this.closed) return;
      this.error = undefined;
      this.apply(result);
    } catch (error) {
      if (this.closed) return;
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.changed();
  }

  private apply(result: DiffResult): void {
    this.result = result;
    const marks = this.store.marks(this.scope);
    this.files = result.files.map(file => {
      const mark = marks.get(file.path);
      return { ...file, review: reviewStatus(currentSnapshotValue(file), mark), ...(mark ? { mark } : {}) };
    });
  }

  /**
   * Marks files reviewed (snapshotting their right side) or not reviewed.
   * Answers a warning when the snapshots could not be protected from `git gc`.
   */
  async setReviewed(paths: string[], reviewed: boolean): Promise<string | undefined> {
    if (paths.length === 0) return undefined;
    const wanted = new Set(paths);
    const files = this.files.filter(file => wanted.has(file.path));
    const changes = new Map<string, string | undefined>();
    if (reviewed) {
      const snapshots = await takeSnapshots(this.root, this.result.right, files);
      for (const file of files) {
        const snapshot = snapshots.get(file.path)!;
        changes.set(file.path, snapshot);
        // The snapshot is the file's content right now.
        if (snapshot === DELETED) delete file.newBlob;
        else file.newBlob = snapshot;
      }
    } else {
      for (const file of files) changes.set(file.path, undefined);
    }
    const marks = await this.store.update(this.scope, changes);
    if (this.closed) return undefined;
    let warning: string | undefined;
    try {
      await writeSnapshotRef(this.root, this.ref, [...marks.values()].map(mark => mark.snapshot));
    } catch (error) {
      warning = `Could not protect review snapshots from git gc: ${error instanceof Error ? error.message : error}`;
    }
    for (const file of this.files) {
      const mark = marks.get(file.path);
      file.review = reviewStatus(currentSnapshotValue(file), mark);
      if (mark) file.mark = mark;
      else delete file.mark;
    }
    this.changed();
    return warning;
  }

  /** Forgets every reviewed mark of this review. */
  async clearReviewed(): Promise<void> {
    await this.store.clear(this.scope);
    await deleteSnapshotRef(this.root, this.ref);
    this.apply(this.result);
    this.changed();
  }

  file(path: string): ReviewFile | undefined {
    return this.files.find(file => file.path === path);
  }

  /** The next file needing review after `path` in `order` (default: by path). */
  next(after: string | undefined, order: ReviewFile[] = this.files): ReviewFile | undefined {
    return nextUnreviewed(order, after);
  }

  /** Stops the review: results still on their way are dropped. */
  close(): void {
    this.closed = true;
    this.listeners.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
