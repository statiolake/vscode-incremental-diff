// Parsing of `git diff` arguments into the two sides being compared.
//
// This module is pure: it never runs git. Whether a bare word is a revision or
// a path is decided by the caller (see `classifyWords` in diff.ts), exactly as
// git itself would decide it.

/** One side of a diff before revisions are resolved to commits. */
export type Endpoint =
  | { kind: "rev"; rev: string }
  | { kind: "mergeBase"; a: string; b: string }
  | { kind: "index" }
  | { kind: "worktree" };

export interface DiffSpec {
  /** The canonical spelling of the arguments; review state is keyed by it. */
  key: string;
  left: Endpoint;
  right: Endpoint;
  /** Options passed through to `git diff` unchanged (e.g. `-w`, `--diff-filter=M`). */
  options: string[];
  /** Pathspecs (everything after `--`, plus bare words that are not revisions). */
  pathspecs: string[];
}

export class DiffSpecError extends Error {}

/** Splits a command line the way a POSIX shell would (quotes and backslashes). */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else current += char;
    } else if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "\\" && i + 1 < input.length && '"\\$`'.includes(input[i + 1])) current += input[++i];
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inToken = true;
    } else if (char === "\\" && i + 1 < input.length) {
      current += input[++i];
      inToken = true;
    } else if (/\s/.test(char)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
    } else {
      current += char;
      inToken = true;
    }
  }
  if (quote) throw new DiffSpecError(`Unterminated ${quote} quote.`);
  if (inToken) tokens.push(current);
  return tokens;
}

/** Quotes a token only when needed, so `key` stays readable. */
export function quote(token: string): string {
  if (token !== "" && /^[A-Za-z0-9@%+=:,./^~_{}*?!-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

// Options that change the output format would break parsing of the raw diff.
const rejectedOptions = /^(-p|-u|-s|-z|--patch|--raw|--stat.*|--numstat|--shortstat|--dirstat.*|--summary|--name-only|--name-status|--check|--color.*|--output.*|--word-diff.*|--patch-with-.*|--no-patch|--compact-summary|--cumulative|--ext-diff|--textconv|--no-index|--format.*|--pretty.*)$/;
const ignoredOptions = new Set(["--no-color", "--no-ext-diff", "--no-textconv", "--no-abbrev"]);

/**
 * Parses `git diff` arguments.
 *
 * @param input the arguments as typed (a leading `git diff` is ignored).
 * @param isRevision decides whether a bare word before `--` names a revision
 *   (true) or a path (false). Words containing `..` or ending in `^!` are
 *   always revisions.
 */
export function parseDiffSpec(input: string | string[], isRevision: (word: string) => boolean = () => true): DiffSpec {
  let tokens = typeof input === "string" ? tokenize(input) : [...input];
  if (tokens[0] === "git" && tokens[1] === "diff") tokens = tokens.slice(2);
  else if (tokens[0] === "diff") tokens = tokens.slice(1);

  const options: string[] = [];
  const revisions: string[] = [];
  const pathspecs: string[] = [];
  let cached = false;
  let mergeBase = false;
  let afterDashDash = false;
  for (const token of tokens) {
    if (afterDashDash) {
      pathspecs.push(token);
    } else if (token === "--") {
      afterDashDash = true;
    } else if (token.startsWith("-") && token !== "-") {
      if (token === "--cached" || token === "--staged") cached = true;
      else if (token === "--merge-base") mergeBase = true;
      else if (rejectedOptions.test(token)) throw new DiffSpecError(`${token} changes git diff's output format and is not supported.`);
      else if (!ignoredOptions.has(token)) options.push(token);
    } else if (isRevisionWord(token) || isRevision(token)) {
      if (pathspecs.length > 0) throw new DiffSpecError(`Revision ${token} must come before paths.`);
      revisions.push(token);
    } else {
      pathspecs.push(token);
    }
  }

  const { left, right } = endpoints(revisions, cached, mergeBase);
  const keyTokens = [
    ...(cached ? ["--cached"] : []),
    ...(mergeBase ? ["--merge-base"] : []),
    ...options,
    ...revisions,
    ...(pathspecs.length > 0 ? ["--", ...pathspecs] : [])
  ];
  return { key: keyTokens.map(quote).join(" "), left, right, options, pathspecs };
}

function isRevisionWord(word: string): boolean {
  return word.includes("..") || word.endsWith("^!");
}

function endpoints(revisions: string[], cached: boolean, mergeBase: boolean): { left: Endpoint; right: Endpoint } {
  const head = (rev: string) => rev === "" ? "HEAD" : rev;
  if (revisions.length === 0) {
    if (mergeBase) throw new DiffSpecError("--merge-base needs a revision.");
    return cached
      ? { left: { kind: "rev", rev: "HEAD" }, right: { kind: "index" } }
      : { left: { kind: "index" }, right: { kind: "worktree" } };
  }
  if (revisions.length === 1) {
    const [word] = revisions;
    const threeDot = word.indexOf("...");
    const twoDot = word.indexOf("..");
    if (threeDot >= 0 || twoDot >= 0 || word.endsWith("^!")) {
      if (cached) throw new DiffSpecError("--cached cannot be combined with a revision range.");
      if (mergeBase && threeDot < 0) throw new DiffSpecError("--merge-base cannot be combined with a revision range.");
    }
    if (threeDot >= 0) {
      const a = head(word.slice(0, threeDot));
      const b = head(word.slice(threeDot + 3));
      return { left: { kind: "mergeBase", a, b }, right: { kind: "rev", rev: b } };
    }
    if (twoDot >= 0) {
      return {
        left: { kind: "rev", rev: head(word.slice(0, twoDot)) },
        right: { kind: "rev", rev: head(word.slice(twoDot + 2)) }
      };
    }
    if (word.endsWith("^!")) {
      const rev = word.slice(0, -2);
      return { left: { kind: "rev", rev: `${rev}^` }, right: { kind: "rev", rev } };
    }
    const left: Endpoint = mergeBase ? { kind: "mergeBase", a: word, b: "HEAD" } : { kind: "rev", rev: word };
    return { left, right: cached ? { kind: "index" } : { kind: "worktree" } };
  }
  if (revisions.length === 2) {
    if (cached) throw new DiffSpecError("--cached compares a revision with the index; give at most one revision.");
    if (revisions.some(isRevisionWord)) throw new DiffSpecError("A revision range must be the only revision.");
    const [a, b] = revisions;
    return {
      left: mergeBase ? { kind: "mergeBase", a, b } : { kind: "rev", rev: a },
      right: { kind: "rev", rev: b }
    };
  }
  throw new DiffSpecError("Combined diffs of more than two revisions are not supported.");
}

/** A short human description of a spec, e.g. `main...HEAD`, `Unstaged Changes`. */
export function describeSpec(spec: DiffSpec): string {
  return spec.key === "" ? "Unstaged Changes" : spec.key === "--cached" ? "Staged Changes" : `git diff ${spec.key}`;
}

/** Whether the right side is the work tree, so untracked files count as added. */
export function comparesWithWorktree(spec: DiffSpec): boolean {
  return spec.right.kind === "worktree";
}
