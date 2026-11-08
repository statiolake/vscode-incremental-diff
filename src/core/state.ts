// Persistence of reviewed marks, input history and the open review.
// Backed by a VS Code Memento (workspaceState); kept free of `vscode` imports
// so it can be unit tested.

export interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface ReviewMark {
  /** Blob id of the right side when it was marked reviewed, or "deleted". */
  snapshot: string;
  /** ISO timestamp. */
  reviewedAt: string;
}

export interface SessionRecord {
  folder: string;
  /** The arguments as typed, or undefined for Branch Changes. */
  input?: string;
  branch?: boolean;
}

interface StoredReview {
  version: 1;
  marks: Record<string, ReviewMark>;
}

const reviewPrefix = "incrementalDiff.review:";
const historyKey = "incrementalDiff.history";
const sessionKey = "incrementalDiff.session";
export const historyLimit = 20;

/** A review's identity: one workspace folder and one normalized diff spec. */
export function reviewScope(folder: string, specKey: string): string {
  return `${folder}\n${specKey}`;
}

function isMark(value: unknown): value is ReviewMark {
  return typeof value === "object" && value !== null
    && typeof (value as ReviewMark).snapshot === "string" && (value as ReviewMark).snapshot !== ""
    && typeof (value as ReviewMark).reviewedAt === "string";
}

export class ReviewStateStore {
  // Writes are serialized so concurrent toggles never lose each other.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly memento: Memento, private readonly now: () => Date = () => new Date()) {}

  /** Reviewed marks by path. Malformed stored data is ignored entry by entry. */
  marks(scope: string): Map<string, ReviewMark> {
    const stored = this.memento.get<StoredReview>(reviewPrefix + scope);
    const marks = new Map<string, ReviewMark>();
    if (stored?.version !== 1 || typeof stored.marks !== "object" || stored.marks === null) return marks;
    for (const [path, mark] of Object.entries(stored.marks)) {
      if (isMark(mark)) marks.set(path, { snapshot: mark.snapshot, reviewedAt: mark.reviewedAt });
    }
    return marks;
  }

  /** Sets (a snapshot value) or clears (undefined) the marks of several paths at once. */
  update(scope: string, changes: Map<string, string | undefined>): Promise<Map<string, ReviewMark>> {
    return this.enqueue(async () => {
      const marks = this.marks(scope);
      const reviewedAt = this.now().toISOString();
      for (const [path, snapshot] of changes) {
        if (snapshot === undefined) marks.delete(path);
        else marks.set(path, { snapshot, reviewedAt });
      }
      await this.write(scope, marks);
      return marks;
    });
  }

  clear(scope: string): Promise<void> {
    return this.enqueue(() => this.memento.update(reviewPrefix + scope, undefined));
  }

  history(): string[] {
    const stored = this.memento.get<unknown>(historyKey);
    return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : [];
  }

  /** Moves `input` to the front of the history. */
  addHistory(input: string): Promise<void> {
    return this.enqueue(() => this.memento.update(historyKey,
      [input, ...this.history().filter(item => item !== input)].slice(0, historyLimit)));
  }

  removeHistory(input: string): Promise<void> {
    return this.enqueue(() => this.memento.update(historyKey, this.history().filter(item => item !== input)));
  }

  session(): SessionRecord | undefined {
    const stored = this.memento.get<SessionRecord>(sessionKey);
    if (typeof stored?.folder !== "string") return undefined;
    if (stored.branch === true) return { folder: stored.folder, branch: true };
    return typeof stored.input === "string" ? { folder: stored.folder, input: stored.input } : undefined;
  }

  setSession(session: SessionRecord | undefined): Promise<void> {
    return this.enqueue(() => this.memento.update(sessionKey, session));
  }

  private async write(scope: string, marks: Map<string, ReviewMark>): Promise<void> {
    const value: StoredReview | undefined = marks.size === 0 ? undefined : { version: 1, marks: Object.fromEntries(marks) };
    await this.memento.update(reviewPrefix + scope, value);
  }

  private enqueue<T>(task: () => Thenable<T> | Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

export type ReviewStatus = "unreviewed" | "reviewed" | "changed";

/**
 * A file is reviewed while its right side still equals the snapshot taken when
 * it was marked; once it differs it is "changed" (since review).
 */
export function reviewStatus(current: string, mark: ReviewMark | undefined): ReviewStatus {
  if (!mark) return "unreviewed";
  return mark.snapshot === current ? "reviewed" : "changed";
}
