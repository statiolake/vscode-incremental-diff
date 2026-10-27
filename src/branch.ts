import { resolveCommit } from "./diff";
import { git } from "./git";

/**
 * The branch that Branch Changes compares against: the configured one, else
 * the default branch of the `upstream` or `origin` remote (its HEAD, then
 * main / master), else a local main / master.
 */
export async function detectBaseBranch(root: string, configured = ""): Promise<string | undefined> {
  if (configured.trim()) return configured.trim();
  for (const remote of ["upstream", "origin"]) {
    const head = await git(root, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], { allowFailure: true });
    if (head?.trim() && await resolveCommit(root, head.trim())) return head.trim();
    for (const name of ["main", "master"]) {
      if (await resolveCommit(root, `refs/remotes/${remote}/${name}`)) return `${remote}/${name}`;
    }
  }
  for (const name of ["main", "master"]) {
    if (await resolveCommit(root, `refs/heads/${name}`)) return name;
  }
  return undefined;
}

/** `git diff` arguments for Branch Changes: merge-base with `base` to the work tree. */
export function branchChangesArgs(base: string): string[] {
  return ["--merge-base", base];
}
