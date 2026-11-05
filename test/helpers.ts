import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A throwaway git repository. */
export class TempRepo {
  // Canonical, as git reports it: the OS temp dir may sit behind a symlink
  // (macOS /var -> /private/var).
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), "incremental-diff-")));

  constructor() {
    this.git("init", "-q", "-b", "main");
    this.git("config", "user.name", "Test");
    this.git("config", "user.email", "test@example.com");
    this.git("config", "commit.gpgsign", "false");
  }

  git(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  write(path: string, content: string): void {
    const file = join(this.root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  remove(path: string): void {
    rmSync(join(this.root, path));
  }

  commit(message: string): string {
    this.git("add", "-A");
    this.git("commit", "-q", "--allow-empty", "-m", message);
    return this.git("rev-parse", "HEAD").trim();
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
