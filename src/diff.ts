import { DiffSpec, DiffSpecError, Endpoint, comparesWithWorktree, parseDiffSpec, tokenize } from "./diffSpec";
import { git, splitZ } from "./git";

export type FileStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U";

/** One record of `git diff --raw -z`. */
export interface RawEntry {
  status: FileStatus;
  /** Similarity score for renames and copies. */
  score?: number;
  path: string;
  oldPath?: string;
  oldMode: string;
  newMode: string;
  oldBlob: string;
  newBlob: string;
}

/** A diff side after its revision was resolved. */
export type ResolvedSide =
  | { kind: "commit"; sha: string; label: string }
  | { kind: "index" }
  | { kind: "worktree" };

export interface ChangedFile {
  status: FileStatus;
  /** Path on the right side, relative to the repository root. */
  path: string;
  /** Path on the left side for renames and copies. */
  oldPath?: string;
  /** Left blob; undefined when the left side is empty (added files). */
  oldBlob?: string;
  /** Right blob; undefined when the right side is empty (deleted files). */
  newBlob?: string;
  /** Untracked work tree file reported as added. */
  untracked?: boolean;
}

export interface DiffResult {
  spec: DiffSpec;
  left: ResolvedSide;
  right: ResolvedSide;
  files: ChangedFile[];
}

const isNullOid = (oid: string) => /^0+$/.test(oid);

/** Parses `git diff --raw -z --no-abbrev` output. */
export function parseRawDiff(output: string): RawEntry[] {
  const fields = splitZ(output);
  const entries: RawEntry[] = [];
  for (let i = 0; i < fields.length;) {
    const meta = fields[i].replace(/^:/, "").trim().split(/\s+/);
    if (!fields[i].startsWith(":") || meta.length !== 5) throw new Error(`Unexpected git diff --raw record: ${JSON.stringify(fields[i])}`);
    const [oldMode, newMode, oldBlob, newBlob, statusField] = meta;
    const status = statusField[0] as FileStatus;
    if (!"AMDRCTU".includes(status)) throw new Error(`Unknown git diff status: ${statusField}`);
    const score = statusField.length > 1 ? Number(statusField.slice(1)) : undefined;
    if (status === "R" || status === "C") {
      if (i + 2 >= fields.length) throw new Error("Truncated git diff --raw output.");
      entries.push({ status, score, oldPath: fields[i + 1], path: fields[i + 2], oldMode, newMode, oldBlob, newBlob });
      i += 3;
    } else {
      if (i + 1 >= fields.length) throw new Error("Truncated git diff --raw output.");
      entries.push({ status, path: fields[i + 1], oldMode, newMode, oldBlob, newBlob });
      i += 2;
    }
  }
  return entries;
}

/** Resolves `rev` to a commit id, or undefined if it does not name one. */
export async function resolveCommit(root: string, rev: string): Promise<string | undefined> {
  const out = await git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], { allowFailure: true });
  return out?.trim() || undefined;
}

/**
 * Parses user input, deciding like git whether bare words are revisions or
 * paths: without `--`, a word that names no commit is a path; with `--`, every
 * word before it must be a revision.
 */
export async function resolveSpec(root: string, input: string | string[]): Promise<DiffSpec> {
  const tokens = typeof input === "string" ? tokenize(input) : input;
  const dashDash = tokens.indexOf("--");
  const revisions = new Set<string>();
  for (const [index, token] of tokens.entries()) {
    if (dashDash >= 0 && index > dashDash) break;
    if (token === "--" || token.startsWith("-") || index < 2 && (token === "git" || token === "diff")) continue;
    if (token.includes("..") || token.endsWith("^!") || await resolveCommit(root, token)) revisions.add(token);
    else if (dashDash >= 0) throw new DiffSpecError(`Unknown revision: ${token}`);
  }
  return parseDiffSpec(tokens, word => revisions.has(word));
}

async function resolveSide(root: string, endpoint: Endpoint): Promise<ResolvedSide> {
  switch (endpoint.kind) {
    case "index":
    case "worktree":
      return endpoint;
    case "rev": {
      const sha = await resolveCommit(root, endpoint.rev);
      if (!sha) throw new DiffSpecError(`Unknown revision: ${endpoint.rev}`);
      return { kind: "commit", sha, label: endpoint.rev };
    }
    case "mergeBase": {
      for (const rev of [endpoint.a, endpoint.b]) {
        if (!await resolveCommit(root, rev)) throw new DiffSpecError(`Unknown revision: ${rev}`);
      }
      const out = await git(root, ["merge-base", "--end-of-options", endpoint.a, endpoint.b], { allowFailure: true });
      const sha = out?.trim();
      if (!sha) throw new DiffSpecError(`${endpoint.a} and ${endpoint.b} have no common ancestor.`);
      return { kind: "commit", sha, label: `merge-base(${endpoint.a}, ${endpoint.b})` };
    }
  }
}

/** The `git diff` arguments comparing two resolved sides. */
export function diffArgs(left: ResolvedSide, right: ResolvedSide, spec: DiffSpec): string[] {
  const args = ["diff", "--raw", "-z", "--no-abbrev", "--no-ext-diff", "--no-color", ...spec.options];
  if (left.kind === "index" && right.kind === "worktree") {
    // plain `git diff`
  } else if (left.kind === "commit" && right.kind === "worktree") {
    args.push(left.sha);
  } else if (left.kind === "commit" && right.kind === "index") {
    args.push("--cached", left.sha);
  } else if (left.kind === "commit" && right.kind === "commit") {
    args.push(left.sha, right.sha);
  } else {
    throw new DiffSpecError(`Cannot compare ${left.kind} with ${right.kind}.`);
  }
  return [...args, "--", ...spec.pathspecs];
}

/** Lists the files changed by `spec`, with blob ids for both sides. */
export async function listChanges(root: string, spec: DiffSpec): Promise<DiffResult> {
  const left = await resolveSide(root, spec.left);
  const right = await resolveSide(root, spec.right);
  const raw = parseRawDiff(await git(root, diffArgs(left, right, spec)));
  const files: ChangedFile[] = raw
    .filter(entry => entry.oldMode !== "160000" && entry.newMode !== "160000") // submodules
    .map(entry => ({
      status: entry.status,
      path: entry.path,
      ...(entry.oldPath !== undefined ? { oldPath: entry.oldPath } : {}),
      ...(entry.status !== "A" && !isNullOid(entry.oldBlob) ? { oldBlob: entry.oldBlob } : {}),
      ...(entry.status !== "D" && !isNullOid(entry.newBlob) ? { newBlob: entry.newBlob } : {})
    }));

  if (comparesWithWorktree(spec)) {
    const listed = new Set(files.map(file => file.path));
    const untracked = splitZ(await git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...spec.pathspecs]))
      .filter(path => !path.endsWith("/") && !listed.has(path));
    for (const path of untracked) files.push({ status: "A", path, untracked: true });
    // Hash work tree content ourselves (without filters) so that the id always
    // matches what `git hash-object -w --no-filters` stores for a snapshot.
    const present = files.filter(file => file.status !== "D");
    const blobs = await hashWorktreeFiles(root, present.map(file => file.path));
    present.forEach((file, index) => {
      if (blobs[index]) file.newBlob = blobs[index];
      else delete file.newBlob;
    });
  }

  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { spec, left, right, files };
}

/**
 * Blob ids of work tree files, or undefined for files that vanished. With
 * `write`, the blobs are also stored in the object database.
 */
export async function hashWorktreeFiles(root: string, paths: string[], write = false): Promise<Array<string | undefined>> {
  if (paths.length === 0) return [];
  const args = ["hash-object", "--no-filters", ...(write ? ["-w"] : []), "--stdin-paths"];
  const out = await git(root, args, { input: paths.join("\n") + "\n", allowFailure: true });
  if (out !== undefined) return out.trim().split("\n");
  // Some file vanished between listing and hashing; fall back to one by one.
  return Promise.all(paths.map(async path => {
    const single = await git(root, ["hash-object", "--no-filters", ...(write ? ["-w"] : []), "--", path], { allowFailure: true });
    return single?.trim() || undefined;
  }));
}
