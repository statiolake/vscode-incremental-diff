import * as path from "node:path";
import * as vscode from "vscode";
import { ContentSide, blobUri, contentSide } from "./content";
import { CoreConnection } from "./core";
import { GitAPI } from "./gitApi";
import { DELETED, WireReview, WireSide } from "./protocol";
import { ReviewFile, buildTree, flattenTree, nextUnreviewed } from "./treeModel";

/** What to review: `git diff` arguments as typed, or Branch Changes. */
export type OpenRequest = { input: string } | { branch: true };

/** The review open in this workspace, reopened when the window reloads. */
export interface SessionRecord {
  folder: string;
  /** The arguments as typed, or undefined for Branch Changes. */
  input?: string;
  branch?: boolean;
}

const sessionKey = "incrementalDiff.session";

export function readSessionRecord(memento: vscode.Memento): SessionRecord | undefined {
  const stored = memento.get<SessionRecord>(sessionKey);
  if (typeof stored?.folder !== "string") return undefined;
  if (stored.branch === true) return { folder: stored.folder, branch: true };
  return typeof stored.input === "string" ? { folder: stored.folder, input: stored.input } : undefined;
}

interface Session {
  folder: vscode.WorkspaceFolder;
  review: WireReview;
}

export interface FileUris {
  label: vscode.Uri;
  left: vscode.Uri;
  right: vscode.Uri;
  snapshot?: vscode.Uri;
}

export type MultiDiffKind = "all" | "unreviewed" | "since";

const config = () => vscode.workspace.getConfiguration("incrementalDiff");

/**
 * The VS Code face of a review. The review itself is the core's
 * (incremental-diff, a child process: core.ts), which lists the files,
 * keeps their marks and snapshots, and says when they change; this adds
 * what only an editor knows — URIs for its diff editors, file watchers,
 * settings and context keys.
 */
export class ReviewController implements vscode.Disposable {
  private session: Session | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private watchers: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private readonly subscriptions: Array<{ dispose(): void }>;

  constructor(
    private readonly core: CoreConnection,
    private readonly memento: vscode.Memento,
    private readonly gitApi: GitAPI | undefined
  ) {
    this.subscriptions = [
      core.onDidChangeReview(review => {
        if (review.id !== this.session?.review.id) return;
        this.session.review = review;
        this.changed.fire();
      }),
      core.onDidExit(message => {
        if (!this.session) return;
        this.closeSession(false);
        void vscode.commands.executeCommand("setContext", "incrementalDiff.active", false);
        this.changed.fire();
        void vscode.window.showWarningMessage(`Incremental Diff: the review closed: ${message}`);
      })
    ];
  }

  get active(): boolean { return this.session !== undefined; }
  get title(): string | undefined { return this.session?.review.title; }
  get error(): string | undefined { return this.session?.review.error; }
  get files(): ReviewFile[] { return this.session?.review.files ?? []; }
  /** The open review's repository root. */
  get root(): string | undefined { return this.session?.review.root; }

  /** Files in the order the tree shows them. */
  order(): ReviewFile[] {
    return flattenTree(buildTree(this.files, config().get<"tree" | "flat">("viewMode", "tree")));
  }

  async open(folder: vscode.WorkspaceFolder, request: OpenRequest): Promise<void> {
    if (folder.uri.scheme !== "file") throw new Error("Incremental Diff only supports folders on the local file system.");
    // Validated before the current review is replaced.
    const review = await this.core.request("review/open", {
      root: folder.uri.fsPath,
      ...("branch" in request ? { branch: true, baseBranch: config().get<string>("baseBranch", "") } : { input: request.input }),
      stats: false
    });
    this.closeSession(true);
    this.session = { folder, review };
    this.watch();
    const record: SessionRecord = "branch" in request
      ? { folder: folder.uri.toString(), branch: true }
      : { folder: folder.uri.toString(), input: request.input };
    await this.memento.update(sessionKey, record);
    await vscode.commands.executeCommand("setContext", "incrementalDiff.active", true);
    this.changed.fire();
  }

  async close(): Promise<void> {
    this.closeSession(true);
    await this.memento.update(sessionKey, undefined);
    await vscode.commands.executeCommand("setContext", "incrementalDiff.active", false);
    this.changed.fire();
  }

  private closeSession(tellCore: boolean): void {
    this.stopWatching();
    if (this.session && tellCore) void this.core.request("review/close", { id: this.session.review.id }).catch(() => undefined);
    this.session = undefined;
  }

  private update(review: WireReview): void {
    if (review.id !== this.session?.review.id) return;
    this.session.review = review;
    this.changed.fire();
  }

  /** Re-runs the diff now (the core coalesces it with a refresh already running). */
  async refresh(): Promise<void> {
    if (!this.session) return;
    this.update(await this.core.request("review/refresh", { id: this.session.review.id }));
  }

  scheduleRefresh(): void {
    if (!this.session || !config().get<boolean>("autoRefresh", true)) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh().catch(() => undefined), Math.max(0, config().get<number>("refreshDelay", 500)));
  }

  /** Marks files reviewed (snapshotting their right side) or not reviewed. */
  async setReviewed(paths: string[], reviewed: boolean): Promise<void> {
    if (!this.session || paths.length === 0) return;
    const { warning, ...review } = await this.core.request("review/setReviewed", { id: this.session.review.id, paths, reviewed });
    this.update(review);
    if (warning) void vscode.window.showWarningMessage(`Incremental Diff: ${warning}`);
  }

  /** Forgets every reviewed mark of the open review. */
  async clearReviewed(): Promise<void> {
    if (!this.session) return;
    this.update(await this.core.request("review/clearReviewed", { id: this.session.review.id }));
  }

  /** The `git diff` arguments opened before in folder's repository, most recent first. */
  history(folder: vscode.WorkspaceFolder): Promise<string[]> {
    return this.core.request("history/list", { root: folder.uri.fsPath });
  }

  removeHistory(folder: vscode.WorkspaceFolder, input: string): Promise<string[]> {
    return this.core.request("history/remove", { root: folder.uri.fsPath, input });
  }

  file(filePath: string): ReviewFile | undefined {
    return this.files.find(file => file.path === filePath);
  }

  /** The review file shown by an editor URI (work tree, git, or snapshot document). */
  fileForUri(uri: vscode.Uri): ReviewFile | undefined {
    const root = this.root;
    if (!root) return undefined;
    if (!["file", "git", "incremental-diff"].includes(uri.scheme)) return undefined;
    const relative = path.relative(root, uri.fsPath).split(path.sep).join("/");
    return this.files.find(file => file.path === relative) ?? this.files.find(file => file.oldPath === relative);
  }

  uris(file: ReviewFile): FileUris {
    const review = this.session!.review;
    const root = review.root;
    const abs = (relative: string) => vscode.Uri.file(path.join(root, ...relative.split("/")));
    const fileUri = abs(file.path);
    const oldUri = abs(file.oldPath ?? file.path);
    const empty = (uri: vscode.Uri, side: ContentSide) => blobUri(uri, root, undefined, side);
    const sideUri = (side: WireSide, uri: vscode.Uri, blob: string | undefined, which: ContentSide): vscode.Uri => {
      if (!blob && side.kind !== "worktree") return empty(uri, which);
      if (side.kind === "worktree") return which === "right" && file.status !== "D" ? uri : empty(uri, which);
      const gitUri = this.gitUri(uri, side.kind === "commit" ? side.sha : "");
      return gitUri ?? blobUri(uri, root, blob, which);
    };
    const left = file.status === "A" ? empty(oldUri, "left") : sideUri(review.left, oldUri, file.oldBlob, "left");
    const right = file.status === "D" ? empty(fileUri, "right") : sideUri(review.right, fileUri, file.newBlob, "right");
    const snapshot = file.snapshot
      ? blobUri(fileUri, root, file.snapshot === DELETED ? undefined : file.snapshot, "snapshot")
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
    const root = this.session!.review.root;
    const rootUri = vscode.Uri.file(root);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(rootUri, "**/*"));
    const onFile = (uri: vscode.Uri) => {
      const relative = path.relative(root, uri.fsPath).split(path.sep);
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
        if (path.relative(repository.rootUri.fsPath, root) === "" && attach()) opened.dispose();
      });
      this.watchers.push(opened);
    }
  }

  private stopWatching(): void {
    clearTimeout(this.refreshTimer);
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
  }

  dispose(): void {
    this.closeSession(true);
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}
