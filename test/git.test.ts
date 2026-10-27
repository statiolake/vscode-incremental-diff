import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { branchChangesArgs, detectBaseBranch } from "../src/branch";
import { listChanges, resolveSpec } from "../src/diff";
import { DiffSpecError, parseDiffSpec } from "../src/diffSpec";
import { git } from "../src/git";
import { DELETED, currentSnapshotValue, snapshotRef, takeSnapshots, writeSnapshotRef } from "../src/snapshot";
import { TempRepo } from "./helpers";

const summary = (files: Array<{ status: string; path: string; oldPath?: string; untracked?: boolean }>) =>
  files.map(file => `${file.status} ${file.oldPath ? `${file.oldPath} -> ` : ""}${file.path}${file.untracked ? " (untracked)" : ""}`);

describe("listing changes", () => {
  const repo = new TempRepo();
  let base = "";
  before(() => {
    repo.write("keep.txt", "keep\n");
    repo.write("src/app.ts", "one\ntwo\nthree\nfour\nfive\nsix\n");
    repo.write("old/name.ts", "export const value = 1;\nexport const other = 2;\nexport const third = 3;\n");
    repo.write("gone.md", "bye\n");
    base = repo.commit("base");
    repo.git("switch", "-q", "-c", "feature");
    repo.write("src/app.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
    repo.write("new/name.ts", "export const value = 1;\nexport const other = 2;\nexport const third = 3;\n");
    repo.remove("old/name.ts");
    repo.remove("gone.md");
    repo.write("added.ts", "added\n");
    repo.commit("feature");
  });
  after(() => repo.dispose());

  test("compares two commits, detecting renames", async () => {
    const result = await listChanges(repo.root, await resolveSpec(repo.root, "main..feature"));
    assert.deepEqual(summary(result.files), ["A added.ts", "D gone.md", "R old/name.ts -> new/name.ts", "M src/app.ts"]);
    assert.equal(result.left.kind === "commit" && result.left.sha, base);
    const added = result.files[0];
    assert.equal(added.oldBlob, undefined);
    assert.equal(added.newBlob, (await git(repo.root, ["rev-parse", "feature:added.ts"])).trim());
    assert.equal(result.files[1].newBlob, undefined);
  });

  test("three dots start at the merge base", async () => {
    repo.git("switch", "-q", "main");
    repo.write("main-only.txt", "x\n");
    repo.commit("main moves on");
    repo.git("switch", "-q", "feature");
    const threeDot = await listChanges(repo.root, await resolveSpec(repo.root, "main...feature"));
    assert.ok(!threeDot.files.some(file => file.path === "main-only.txt"));
    const twoDot = await listChanges(repo.root, await resolveSpec(repo.root, "main..feature"));
    assert.ok(twoDot.files.some(file => file.path === "main-only.txt" && file.status === "D"));
  });

  test("work tree side includes uncommitted and untracked files", async () => {
    repo.write("keep.txt", "edited\n");
    repo.write("brand new.txt", "fresh\n");
    try {
      const result = await listChanges(repo.root, await resolveSpec(repo.root, "HEAD"));
      assert.deepEqual(summary(result.files), ["A brand new.txt (untracked)", "M keep.txt"]);
      const hashed = (await git(repo.root, ["hash-object", "--no-filters", "keep.txt"])).trim();
      assert.equal(result.files[1].newBlob, hashed);
      const unstaged = await listChanges(repo.root, await resolveSpec(repo.root, ""));
      assert.deepEqual(summary(unstaged.files), ["A brand new.txt (untracked)", "M keep.txt"]);
      const staged = await listChanges(repo.root, await resolveSpec(repo.root, "--cached"));
      assert.deepEqual(summary(staged.files), []);
      repo.git("add", "keep.txt");
      const stagedNow = await listChanges(repo.root, await resolveSpec(repo.root, "--cached"));
      assert.deepEqual(summary(stagedNow.files), ["M keep.txt"]);
      assert.equal(stagedNow.files[0].newBlob, hashed);
    } finally {
      repo.git("reset", "-q", "--hard");
      repo.remove("brand new.txt");
    }
  });

  test("bare words that are not revisions are paths", async () => {
    const spec = await resolveSpec(repo.root, "main src");
    assert.deepEqual(spec.pathspecs, ["src"]);
    const result = await listChanges(repo.root, spec);
    assert.deepEqual(summary(result.files), ["M src/app.ts"]);
    await assert.rejects(resolveSpec(repo.root, "nope --"), DiffSpecError);
    await assert.rejects(listChanges(repo.root, parseDiffSpec("nope..main")), DiffSpecError);
  });

  test("branch changes run from the merge base with the default branch to the work tree", async () => {
    assert.equal(await detectBaseBranch(repo.root), "main");
    assert.equal(await detectBaseBranch(repo.root, " develop "), "develop");
    repo.git("update-ref", "refs/remotes/origin/trunk", "main");
    repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    assert.equal(await detectBaseBranch(repo.root), "origin/trunk");
    repo.write("wip.txt", "wip\n");
    try {
      const result = await listChanges(repo.root, parseDiffSpec(branchChangesArgs("origin/trunk")));
      assert.deepEqual(summary(result.files), ["A added.ts", "D gone.md", "R old/name.ts -> new/name.ts", "M src/app.ts", "A wip.txt (untracked)"]);
    } finally {
      repo.remove("wip.txt");
    }
  });
});

describe("snapshots", () => {
  const repo = new TempRepo();
  before(() => {
    repo.write("a.txt", "a\n");
    repo.write("b.txt", "b\n");
    repo.commit("base");
  });
  after(() => repo.dispose());

  test("snapshots the work tree, survives gc, and detects later edits", async () => {
    repo.write("a.txt", "a changed\r\n");
    repo.remove("b.txt");
    const spec = parseDiffSpec("");
    const before = await listChanges(repo.root, spec);
    const snapshots = await takeSnapshots(repo.root, before.right, before.files);
    const blob = snapshots.get("a.txt")!;
    assert.equal(snapshots.get("b.txt"), DELETED);
    assert.equal(await git(repo.root, ["cat-file", "blob", blob]), "a changed\r\n");
    assert.equal(currentSnapshotValue(before.files.find(file => file.path === "a.txt")!), blob);

    const ref = snapshotRef("folder\nkey");
    assert.match(ref, /^refs\/incremental-diff\/[0-9a-f]{16}$/);
    await writeSnapshotRef(repo.root, ref, snapshots.values());
    const tree = await git(repo.root, ["ls-tree", ref]);
    assert.equal(tree.trim(), `100644 blob ${blob}\t${blob}`);
    const commit = (await git(repo.root, ["rev-parse", ref])).trim();
    await writeSnapshotRef(repo.root, ref, [blob]);
    assert.equal((await git(repo.root, ["rev-parse", ref])).trim(), commit, "an unchanged tree keeps the ref");

    repo.git("gc", "-q", "--prune=now");
    assert.equal(await git(repo.root, ["cat-file", "blob", blob]), "a changed\r\n");

    repo.write("a.txt", "a changed again\n");
    const afterEdit = await listChanges(repo.root, spec);
    assert.notEqual(currentSnapshotValue(afterEdit.files.find(file => file.path === "a.txt")!), blob);
    assert.equal(currentSnapshotValue(afterEdit.files.find(file => file.path === "b.txt")!), DELETED);

    await writeSnapshotRef(repo.root, ref, [DELETED]);
    assert.equal(await git(repo.root, ["rev-parse", "--verify", "--quiet", ref], { allowFailure: true }), undefined);
  });

  test("snapshots of commit sides reuse the existing blob", async () => {
    repo.git("checkout", "-q", "--", ".");
    repo.write("a.txt", "committed\n");
    repo.commit("second");
    const result = await listChanges(repo.root, parseDiffSpec("HEAD~..HEAD"));
    const snapshots = await takeSnapshots(repo.root, result.right, result.files);
    assert.equal(snapshots.get("a.txt"), (await git(repo.root, ["rev-parse", "HEAD:a.txt"])).trim());
  });
});
