import { ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Methods, WireReview } from "./protocol";

/**
 * The core, `incremental-diff serve` (bin/<os>-<arch>/ of the extension): a
 * child process holding the reviews, speaking JSON-RPC on stdio. It is
 * started on the first request and ends with the extension host (its stdin
 * closes); when it exits, the next request starts it again, and whoever
 * held a review learns of it through onDidExit.
 */
export class CoreConnection {
  private child: ChildProcess | undefined;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private nextId = 1;
  private stderr = "";
  private readonly changeListeners = new Set<(review: WireReview) => void>();
  private readonly exitListeners = new Set<(message: string) => void>();

  constructor(private readonly executable: string) {}

  request<M extends keyof Methods>(method: M, params: Methods[M][0]): Promise<Methods[M][1]> {
    const child = this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** `review/changed`: a review's files or their state changed. */
  onDidChangeReview(listener: (review: WireReview) => void): { dispose(): void } {
    this.changeListeners.add(listener);
    return { dispose: () => this.changeListeners.delete(listener) };
  }

  /** The process ended; every review it held is gone. */
  onDidExit(listener: (message: string) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  private start(): ChildProcess {
    if (this.child) return this.child;
    const child = spawn(this.executable, ["serve"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.stderr = "";
    let ended = false;
    const end = (message: string) => {
      if (ended) return;
      ended = true;
      if (this.child === child) this.child = undefined;
      const error = new Error(message);
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
      for (const listener of this.exitListeners) listener(message);
    };
    child.on("error", error => end(`Could not run ${this.executable}: ${error.message}`));
    child.on("exit", code => end(`incremental-diff exited (${code ?? "signal"})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`));
    child.stdin!.on("error", () => undefined);
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-4096); });
    createInterface({ input: child.stdout! }).on("line", line => this.receive(line));
    return child;
  }

  private receive(line: string): void {
    let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
    } else if (message.method === "review/changed") {
      for (const listener of this.changeListeners) listener(message.params as WireReview);
    }
  }

  dispose(): void {
    this.child?.stdin?.end();
    this.child = undefined;
  }
}
