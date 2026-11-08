// The server's request handlers over the core: open reviews by id, answer
// with their wire state, and notify clients when a review changes. Kept
// apart from the transport (main.ts) so it is tested by calling it.

import { FSWatcher, watch } from "node:fs";
import { isAbsolute, join } from "node:path";
import { FileMemento } from "../core/fileMemento";
import { git, repositoryRoot } from "../core/git";
import { ReviewSession } from "../core/session";
import { ReviewStateStore } from "../core/state";
import { Methods, Notifications, WireCommit, WireReview, protocolVersion } from "./protocol";

export class RequestError extends Error {}

interface Open {
  id: number;
  review: ReviewSession;
  watcher?: FSWatcher;
  timer?: NodeJS.Timeout;
  unsubscribe: () => void;
}

type Params<M extends keyof Methods> = Methods[M][0];
type Result<M extends keyof Methods> = Methods[M][1];

const objectId = /^[0-9a-f]{4,64}$/;

export class ReviewService {
  private reviews = new Map<number, Open>();
  private stores = new Map<string, ReviewStateStore>();
  private nextId = 1;

  constructor(
    private readonly notify: <N extends keyof Notifications>(method: N, params: Notifications[N]) => void,
    private readonly options: { version: string; watchDelay?: number } = { version: "0" }
  ) {}

  /** Runs one request; throws RequestError for a bad request. */
  async handle(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "initialize": return this.initialize();
      case "review/open": return this.open(p as Params<"review/open">);
      case "review/get": return this.wire(this.get(p.id));
      case "review/refresh": {
        const open = this.get(p.id);
        await open.review.refresh();
        return this.wire(open);
      }
      case "review/setReviewed": {
        const open = this.get(p.id);
        if (!Array.isArray(p.paths) || !p.paths.every(path => typeof path === "string")) throw new RequestError("paths must be a list of paths.");
        const warning = await open.review.setReviewed(p.paths as string[], p.reviewed !== false);
        return { ...this.wire(open), ...(warning ? { warning } : {}) };
      }
      case "review/clearReviewed": {
        const open = this.get(p.id);
        await open.review.clearReviewed();
        return this.wire(open);
      }
      case "review/close": {
        this.close(Number(p.id));
        return null;
      }
      case "git/blob": return this.blob(p as Params<"git/blob">);
      case "git/log": return this.log(p as Params<"git/log">);
      case "history/list": return (await this.store(await this.root(p.root))).history();
      case "history/remove": {
        const store = await this.store(await this.root(p.root));
        await store.removeHistory(String(p.input ?? ""));
        return store.history();
      }
      default:
        throw new RequestError(`Unknown method: ${method}`);
    }
  }

  private initialize(): Result<"initialize"> {
    return { name: "incremental-diff", version: this.options.version, protocol: protocolVersion };
  }

  private async root(value: unknown): Promise<string> {
    if (typeof value !== "string" || !isAbsolute(value)) throw new RequestError("root must be an absolute path.");
    const root = await repositoryRoot(value);
    if (!root) throw new RequestError(`${value} is not inside a git work tree.`);
    return root;
  }

  /**
   * One store per repository, in `<git common dir>/incremental-diff/state.json`:
   * next to the objects and refs that hold the snapshots it names, shared by
   * the repository's worktrees (each review's scope names its root), and gone
   * with the clone.
   */
  private async store(root: string): Promise<ReviewStateStore> {
    const common = (await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    let store = this.stores.get(common);
    if (!store) {
      store = new ReviewStateStore(new FileMemento(join(common, "incremental-diff", "state.json")));
      this.stores.set(common, store);
    }
    return store;
  }

  private async open(p: Params<"review/open">): Promise<WireReview> {
    const root = await this.root(p.root);
    const store = await this.store(root);
    const request: { input: string } | { branch: true } = p.branch ? { branch: true } : { input: typeof p.input === "string" ? p.input : "" };
    const review = await ReviewSession.open(store, root, request, { baseBranch: p.baseBranch ?? "", stats: p.stats !== false });
    if ("input" in request) await store.addHistory(request.input);
    const id = this.nextId++;
    const open: Open = { id, review, unsubscribe: () => undefined };
    open.unsubscribe = review.onDidChange(() => this.notify("review/changed", this.wire(open)));
    this.reviews.set(id, open);
    await this.watchGit(open);
    return this.wire(open);
  }

  /**
   * Git's own state (HEAD, the index, refs being packed, a commit message
   * written) is watched here, cheaply: the git directory's top level only.
   * Changes to work tree files are the client's to report (`review/refresh`
   * on a save, focus or shell command): it knows them without watching a
   * whole tree, which for a large repository costs more than it saves.
   */
  private async watchGit(open: Open): Promise<void> {
    const gitDir = (await git(open.review.root, ["rev-parse", "--absolute-git-dir"])).trim();
    try {
      open.watcher = watch(gitDir, { persistent: false }, (_event, name) => {
        if (name && (name.endsWith(".lock") || name.endsWith(".tmp"))) return;
        clearTimeout(open.timer);
        open.timer = setTimeout(() => void open.review.refresh(), this.options.watchDelay ?? 300);
      });
      open.watcher.on("error", () => open.watcher?.close());
    } catch {
      // No watching on this file system: refreshes come from the client only.
    }
  }

  private get(id: unknown): Open {
    const open = this.reviews.get(Number(id));
    if (!open) throw new RequestError(`No open review with id ${String(id)}.`);
    return open;
  }

  private close(id: number): void {
    const open = this.reviews.get(id);
    if (!open) return;
    this.reviews.delete(id);
    clearTimeout(open.timer);
    open.watcher?.close();
    open.unsubscribe();
    open.review.close();
  }

  /** Closes every review (the client went away). */
  dispose(): void {
    for (const id of [...this.reviews.keys()]) this.close(id);
  }

  private wire(open: Open): WireReview {
    const review = open.review;
    const side = (s: ReviewSession["result"]["left"]) => s.kind === "commit" ? { kind: s.kind, sha: s.sha, label: s.label } : { kind: s.kind };
    return {
      id: open.id,
      root: review.root,
      title: review.title,
      key: review.spec.key,
      left: side(review.result.left),
      right: side(review.result.right),
      files: review.files.map(file => ({
        path: file.path,
        status: file.status,
        ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
        ...(file.untracked ? { untracked: true } : {}),
        ...(file.oldBlob ? { oldBlob: file.oldBlob } : {}),
        ...(file.newBlob ? { newBlob: file.newBlob } : {}),
        ...(file.added !== undefined ? { added: file.added, deleted: file.deleted } : {}),
        ...(file.binary ? { binary: true } : {}),
        review: file.review,
        ...(file.mark ? { snapshot: file.mark.snapshot, reviewedAt: file.mark.reviewedAt } : {})
      })),
      ...(review.error ? { error: review.error } : {})
    };
  }

  private async blob(p: Params<"git/blob">): Promise<Result<"git/blob">> {
    const root = await this.root(p.root);
    if (typeof p.blob !== "string" || !objectId.test(p.blob)) throw new RequestError("blob must be an object id.");
    const text = await git(root, ["cat-file", "blob", p.blob]);
    return text.slice(0, 8000).includes("\0") ? { binary: true } : { text };
  }

  private async log(p: Params<"git/log">): Promise<WireCommit[]> {
    const root = await this.root(p.root);
    if (typeof p.path !== "string" || p.path === "") throw new RequestError("path must be a path relative to the root.");
    const limit = Math.max(1, Math.min(Number(p.limit) || 200, 2000));
    // --name-only gives the file's name in each commit (it changes across renames).
    const out = await git(root, ["log", "--follow", `-n${limit}`, "--name-only", "--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s", "--", p.path], { allowFailure: true });
    return (out ?? "").split("\x1e").filter(record => record.trim()).map(record => {
      const [header, ...rest] = record.split("\n");
      const [sha, short, author, date, subject] = header.split("\x1f");
      const path = rest.map(line => line.trim()).find(Boolean) ?? p.path;
      return { sha, short, author, date, subject, path };
    });
  }
}
