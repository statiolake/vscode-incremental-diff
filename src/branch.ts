import { git } from "./git";

/**
 * The branch that Branch Changes compares against: the configured one, else
 * the branch HEAD forked from.
 *
 * The fork point is the branch whose merge base with HEAD is closest to HEAD.
 * Candidates are every local and remote-tracking branch except HEAD's own
 * (the current branch, its upstream, and same-named remote branches) and
 * branches that already contain HEAD and go further, which forked from HEAD
 * rather than the other way round. Candidates tied on distance share the same
 * merge base, so the diff is the same whichever name wins.
 */
export async function detectBaseBranch(root: string, configured = ""): Promise<string | undefined> {
  if (configured.trim()) return configured.trim();
  const head = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFailure: true }))?.trim();
  if (!head) return undefined;
  const current = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true }))?.trim();
  const upstream = (await git(root, ["rev-parse", "--symbolic-full-name", "@{upstream}"], { allowFailure: true }))?.trim();

  const own = (ref: string) =>
    ref === upstream || ref === `refs/heads/${current}` || ref.replace(/^refs\/remotes\/[^/]+\//, "") === current;
  // Ref names cannot contain tabs or newlines.
  const refs = (await git(root, ["for-each-ref", "--format=%(refname)%09%(symref)%09%(objectname)", "refs/heads", "refs/remotes"]))
    .split("\n").filter(Boolean)
    .map(line => line.split("\t"))
    .filter(([ref, symref]) => !symref && !own(ref));

  const scored = await Promise.all(refs.map(async ([ref, , tip]) => {
    // Exit status 1 means no common ancestor: not a fork point.
    const base = (await git(root, ["merge-base", head, tip], { allowFailure: true }))?.trim();
    if (!base || (base === head && tip !== head)) return undefined;
    const distance = Number((await git(root, ["rev-list", "--count", `${base}..${head}`])).trim());
    return { ref, distance };
  }));

  let best: { ref: string; distance: number } | undefined;
  for (const candidate of scored) {
    if (candidate && (!best || candidate.distance < best.distance)) best = candidate;
  }
  return best && shortName(best.ref);
}

function shortName(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes)\//, "");
}

/** `git diff` arguments for Branch Changes: merge-base with `base` to the work tree. */
export function branchChangesArgs(base: string): string[] {
  return ["--merge-base", base];
}
