import * as path from "node:path";
import * as vscode from "vscode";
import { branchChangesArgs, detectBaseBranch } from "./branch";
import { ContentSide, blobUri, contentSide } from "./content";
import { DiffResult, ResolvedSide, listChanges, resolveSpec } from "./diff";
import { DiffSpec, describeSpec, parseDiffSpec } from "./diffSpec";
import { repositoryRoot } from "./git";
import { GitAPI } from "./gitApi";
import { DELETED, currentSnapshotValue, deleteSnapshotRef, snapshotRef, takeSnapshots, writeSnapshotRef } from "./snapshot";
import { ReviewStateStore, SessionRecord, reviewScope, reviewStatus } from "./state";
import { ReviewFile, buildTree, flattenTree, nextUnreviewed } from "./treeModel";

export type OpenRequest = { input: string } | { branch: true };

interface Session {
  folder: vscode.WorkspaceFolder;
  root: string;
  request: OpenRequest;
  spec: DiffSpec;
  title: string;
  scope: string;
  ref: string;
  result?: DiffResult;
  files: ReviewFile[];
  error?: string;
}

export interface FileUris {
  label: vscode.Uri;
  left: vscode.Uri;
  right: vscode.Uri;
  snapshot?: vscode.Uri;
}

export type MultiDiffKind = "all" | "unreviewed" | "since";

const config = () => vscode.workspace.getConfiguration("incrementalDiff");

export class ReviewController implements vscode.Disposable {
  private session: Session | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private watchers: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> | undefined;
  private refreshAgain = false;
  private generation = 0;

  constructor(private readonly store: ReviewStateStore, private readonly gitApi: GitAPI | undefined) {}

  get active(): boolean { return this.session !== undefined; }
  get title(): string | undefined { return this.session?.title; }
  get error(): string | undefined { return this.session?.error; }
  get files(): ReviewFile[] { return this.session?.files ?? []; }

  /** Files in the order the tree shows them. */
  order(): ReviewFile[] {
    return flattenTree(buildTree(this.files, config().get<"tree" | "flat">("viewMode", "tree")));
  }

  async open(folder: vscode.WorkspaceFolder, request: OpenRequest): Promise<void> {
    if (folder.uri.scheme !== "file") throw new Error("Incremental Diff only supports folders on the local file system.");
    const root = await repositoryRoot(folder.uri.fsPath);
    if (!root) throw new Error(`${folder.name} is not inside a git repository.`);
    let spec: DiffSpec;
    let title: string;
    if ("branch" in request) {
      const base = await detectBaseBranch(root, config().get<string>("baseBranch", ""));
      if (!base) throw new Error("Could not find a base branch. Set incrementalDiff.baseBranch.");
      spec = parseDiffSpec(branchChangesArgs(base));
      title = `Branch Changes (${base})`;
    } else {
      spec = await resolveSpec(root, request.input);
      title = describeSpec(spec);
    }
    // Validate before replacing the current review.
    const result = await listChanges(root, spec);
    const scope = reviewScope(folder.uri.toString(), spec.key);
    this.dispose(false);
    this.generation++;
    this.session = { folder, root, request, spec, title, scope, ref: snapshotRef(scope), result, files: [] };
    this.applyResult(result);
    this.watch();
    const record: SessionRecord = "branch" in request
      ? { folder: folder.uri.toString(), branch: true }
      : { folder: folder.uri.toString(), input: request.input };
    await this.store.setSession(record);
    await vscode.commands.executeCommand("setContext", "incrementalDiff.active", true);
    this.changed.fire();
  }

  async close(): Promise<void> {
    this.dispose(false);
    this.session = undefined;
    this.generation++;
    await this.store.setSession(undefined);
    await vscode.commands.executeCommand("setContext", "incrementalDiff.active", false);
    this.changed.fire();
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

  scheduleRefresh(): void {
    if (!this.session || !config().get<boolean>("autoRefresh", true)) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), Math.max(0, config().get<number>("refreshDelay", 500)));
  }

  private async refreshOnce(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const generation = this.generation;
    try {
      const result = await listChanges(session.root, session.spec);
      if (generation !== this.generation) return;
      session.error = undefined;
      this.applyResult(result);
    } catch (error) {
      if (generation !== this.generation) return;
      session.error = error instanceof Error ? error.message : String(error);
    }
    this.changed.fire();
  }

  private applyResult(result: DiffResult): void {
    const session = this.session!;
    session.result = result;
    const marks = this.store.marks(session.scope);
    session.files = result.files.map(file => {
      const mark = marks.get(file.path);
      return { ...file, review: reviewStatus(currentSnapshotValue(file), mark), ...(mark ? { mark } : {}) };
    });
  }

  /** Marks files reviewed (snapshotting their right side) or not reviewed. */
  async setReviewed(paths: string[], reviewed: boolean): Promise<void> {
    const session = this.session;
    if (!session?.result || paths.length === 0) return;
    const wanted = new Set(paths);
    const files = session.files.filter(file => wanted.has(file.path));
    const changes = new Map<string, string | undefined>();
    if (reviewed) {
      const snapshots = await takeSnapshots(session.root, session.result.right, files);
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
    const marks = await this.store.update(session.scope, changes);
    if (this.session !== session) return;
    try {
      await writeSnapshotRef(session.root, session.ref, [...marks.values()].map(mark => mark.snapshot));
    } catch (error) {
      void vscode.window.showWarningMessage(`Incremental Diff could not protect review snapshots from git gc: ${error instanceof Error ? error.message : error}`);
    }
    for (const file of session.files) {
      const mark = marks.get(file.path);
      file.review = reviewStatus(currentSnapshotValue(file), mark);
      if (mark) file.mark = mark;
      else delete file.mark;
    }
    this.changed.fire();
  }

  /** Forgets every reviewed mark of the open review. */
  async clearReviewed(): Promise<void> {
    const session = this.session;
    if (!session) return;
    await this.store.clear(session.scope);
    await deleteSnapshotRef(session.root, session.ref);
    if (session.result) this.applyResult(session.result);
    this.changed.fire();
  }

  file(filePath: string): ReviewFile | undefined {
    return this.files.find(file => file.path === filePath);
  }

  /** The review file shown by an editor URI (work tree, git, or snapshot document). */
  fileForUri(uri: vscode.Uri): ReviewFile | undefined {
    const session = this.session;
    if (!session) return undefined;
    if (!["file", "git", "incremental-diff"].includes(uri.scheme)) return undefined;
    const relative = path.relative(session.root, uri.fsPath).split(path.sep).join("/");
    return this.files.find(file => file.path === relative) ?? this.files.find(file => file.oldPath === relative);
  }

  uris(file: ReviewFile): FileUris {
    const session = this.session!;
    const result = session.result!;
    const abs = (relative: string) => vscode.Uri.file(path.join(session.root, ...relative.split("/")));
    const fileUri = abs(file.path);
    const oldUri = abs(file.oldPath ?? file.path);
    const empty = (uri: vscode.Uri, side: ContentSide) => blobUri(uri, session.root, undefined, side);
    const sideUri = (side: ResolvedSide, uri: vscode.Uri, blob: string | undefined, which: ContentSide): vscode.Uri => {
      if (!blob && side.kind !== "worktree") return empty(uri, which);
      if (side.kind === "worktree") return which === "right" && file.status !== "D" ? uri : empty(uri, which);
      const gitUri = this.gitUri(uri, side.kind === "commit" ? side.sha : "");
      return gitUri ?? blobUri(uri, session.root, blob, which);
    };
    const left = file.status === "A" ? empty(oldUri, "left") : sideUri(result.left, oldUri, file.oldBlob, "left");
    const right = file.status === "D" ? empty(fileUri, "right") : sideUri(result.right, fileUri, file.newBlob, "right");
    const snapshot = file.mark
      ? blobUri(fileUri, session.root, file.mark.snapshot === DELETED ? undefined : file.mark.snapshot, "snapshot")
      : undefined;
    return { label: file.status === "D" ? oldUri : fileUri, left, right, ...(snapshot ? { snapshot } : {}) };
  }

  private gitUri(uri: vscode.Uri, ref: string): vscode.Uri | undefined {
    if (!this.gitApi?.getRepository(uri)) return undefined;
    return this.gitApi.toGitUri(uri, ref);
  }

  /**
   * Opens one file's diff. "auto" shows snapshot → current for files changed
   * since review (unless disabled in settings), else the full diff.
   */
  async openFile(file: ReviewFile, mode: "auto" | "full" | "since", options: vscode.TextDocumentShowOptions = {}): Promise<void> {
    const uris = this.uris(file);
    const since = uris.snapshot && file.review === "changed"
      && (mode === "since" || (mode === "auto" && config().get<boolean>("openChangesSinceReview", true)));
    const name = path.posix.basename(file.path);
    if (since) {
      await vscode.commands.executeCommand("vscode.diff", uris.snapshot, uris.right, `${name} (Since Review)`, { preview: true, ...options });
    } else {
      const rename = file.oldPath ? `${path.posix.basename(file.oldPath)} → ` : "";
      await vscode.commands.executeCommand("vscode.diff", uris.left, uris.right, `${rename}${name} (${this.title})`, { preview: true, ...options });
    }
  }

  async openMulti(kind: MultiDiffKind): Promise<number> {
    const files = this.order().filter(file => kind === "all" || (kind === "unreviewed" ? file.review !== "reviewed" : file.review === "changed"));
    if (files.length === 0) return 0;
    const resources = files.map(file => {
      const uris = this.uris(file);
      return kind === "since" ? [uris.label, uris.snapshot!, uris.right] : [uris.label, uris.left, uris.right];
    });
    const label = kind === "all" ? "All Changes" : kind === "unreviewed" ? "Unreviewed Changes" : "Changes Since Review";
    await vscode.commands.executeCommand("vscode.changes", `${label}: ${this.title}`, resources);
    return files.length;
  }

  /** Whether `uri` is the left side of a snapshot → current diff. */
  isSnapshotSide(uri: vscode.Uri): boolean {
    return contentSide(uri) === "snapshot";
  }

  next(after: string | undefined): ReviewFile | undefined {
    return nextUnreviewed(this.order(), after);
  }

  private watch(): void {
    const session = this.session!;
    const rootUri = vscode.Uri.file(session.root);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(rootUri, "**/*"));
    const onFile = (uri: vscode.Uri) => {
      const relative = path.relative(session.root, uri.fsPath).split(path.sep);
      // Git metadata changes come through the git extension, except when it is
      // unavailable; then HEAD, the index and refs still matter.
      if (relative[0] === ".git" && this.gitApi?.getRepository(rootUri)) return;
      if (relative[0] === ".git" && !["HEAD", "index", "refs", "packed-refs"].includes(relative[1] ?? "")) return;
      if (relative[0] === ".git" && relative[1] === "refs" && relative[2] === "incremental-diff") return;
      this.scheduleRefresh();
    };
    this.watchers.push(
      watcher,
      watcher.onDidChange(onFile),
      watcher.onDidCreate(onFile),
      watcher.onDidDelete(onFile),
      vscode.workspace.onDidSaveTextDocument(document => onFile(document.uri))
    );
    const attach = () => {
      const repository = this.gitApi?.getRepository(rootUri);
      if (repository) this.watchers.push(repository.state.onDidChange(() => this.scheduleRefresh()));
      return !!repository;
    };
    if (this.gitApi && !attach()) {
      const opened = this.gitApi.onDidOpenRepository(repository => {
        if (path.relative(repository.rootUri.fsPath, session.root) === "" && attach()) opened.dispose();
      });
      this.watchers.push(opened);
    }
  }

  dispose(final = true): void {
    clearTimeout(this.refreshTimer);
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
    if (final) this.changed.dispose();
  }
}
