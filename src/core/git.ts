import { execFile } from "node:child_process";

export class GitError extends Error {
  constructor(message: string, readonly args: string[], readonly stderr: string) {
    super(message);
  }
}

export interface RunOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  /** Resolve to undefined instead of throwing when git exits non-zero. */
  allowFailure?: boolean;
}

// Keep git from prompting, paging, or picking up unrelated user configuration
// that changes output formats.
const baseArgs = ["-c", "core.quotepath=off", "-c", "color.ui=false"];

export function git(cwd: string, args: string[], options?: RunOptions & { allowFailure?: false }): Promise<string>;
export function git(cwd: string, args: string[], options: RunOptions & { allowFailure: true }): Promise<string | undefined>;
export function git(cwd: string, args: string[], options: RunOptions = {}): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", [...baseArgs, ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...options.env }
    }, (error, stdout, stderr) => {
      if (error) {
        if (options.allowFailure) resolve(undefined);
        else reject(new GitError(`git ${args.join(" ")} failed: ${stderr.trim() || error.message}`, args, stderr));
        return;
      }
      resolve(stdout);
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/** Splits NUL-terminated output, dropping the trailing empty field. */
export function splitZ(output: string): string[] {
  const fields = output.split("\0");
  if (fields[fields.length - 1] === "") fields.pop();
  return fields;
}

/** The top level of the work tree containing `path`, or undefined outside git. */
export async function repositoryRoot(path: string): Promise<string | undefined> {
  const out = await git(path, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  return out?.trim() || undefined;
}
