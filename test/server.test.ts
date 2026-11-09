import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseNumstat } from "../src/core/diff";
import { git } from "../src/core/git";
import { WireReview } from "../src/server/protocol";
import { ReviewService } from "../src/server/service";
import { TempRepo } from "./helpers";

const repo = new TempRepo();
after(() => repo.dispose());

test("parses numstat records, renames and binary files", () => {
  const stats = parseNumstat("3\t1\ta.txt\0-\t-\timg.png\0" + "2\t0\t\0old.txt\0new.txt\0");
  assert.deepEqual(stats.get("a.txt"), { added: 3, deleted: 1 });
  assert.deepEqual(stats.get("img.png"), { binary: true });
  assert.deepEqual(stats.get("new.txt"), { added: 2, deleted: 0 });
});

test("the service opens reviews, marks files and keeps state in the git directory", async () => {
  repo.write("a.txt", "a\nb\n");
  repo.write("src/b.txt", "b\n");
  const base = repo.commit("base");
  repo.write("a.txt", "a\nB\nc\n");
  repo.write("new.txt", "1\n2\n");
  const notified: WireReview[] = [];
  const service = new ReviewService((_method, params) => notified.push(params), { version: "t", watchDelay: 10 });
  const review = await service.handle("review/open", { root: join(repo.root, "src"), input: "HEAD" }) as WireReview;
  assert.equal(review.root, repo.root);
  assert.deepEqual(review.left, { kind: "commit", sha: base, label: "HEAD" });
  assert.deepEqual(review.right, { kind: "worktree" });
  assert.deepEqual(review.files.map(f => [f.path, f.status, f.added, f.deleted, f.review]),
    [["a.txt", "M", 2, 1, "unreviewed"], ["new.txt", "A", 2, 0, "unreviewed"]]);
  assert.equal(review.files[1].untracked, true);

  const marked = await service.handle("review/setReviewed", { id: review.id, paths: ["a.txt"], reviewed: true }) as WireReview;
  assert.equal(marked.files[0].review, "reviewed");
  const snapshot = marked.files[0].snapshot!;
  assert.deepEqual(await service.handle("git/blob", { root: repo.root, blob: snapshot }), { text: "a\nB\nc\n" });
  assert.ok(notified.length >= 1, "a change is notified");
  const common = (await git(repo.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  assert.ok(existsSync(join(common, "incremental-diff", "state.json")));

  repo.write("a.txt", "a\nB\nc\nd\n");
  const refreshed = await service.handle("review/refresh", { id: review.id }) as WireReview;
  assert.equal(refreshed.files[0].review, "changed");
  assert.equal(refreshed.files[0].snapshot, snapshot);

  // A second service (another editor) sees the same marks.
  const other = new ReviewService(() => undefined, { version: "t" });
  const again = await other.handle("review/open", { root: repo.root, input: "HEAD" }) as WireReview;
  assert.equal(again.files[0].review, "changed");
  assert.deepEqual(await other.handle("history/list", { root: repo.root }), ["HEAD"]);

  const log = await service.handle("git/log", { root: repo.root, path: "a.txt" }) as Array<{ sha: string; subject: string; path: string }>;
  assert.deepEqual(log.map(c => [c.sha, c.subject, c.path]), [[base, "base", "a.txt"]]);

  await assert.rejects(service.handle("review/get", { id: 99 }), /No open review/);
  await assert.rejects(service.handle("git/blob", { root: repo.root, blob: "../x" }), /object id/);
  await assert.rejects(service.handle("review/open", { root: repo.root, input: "no-such-rev --" }), /Unknown revision/);
  assert.equal(await service.handle("review/close", { id: review.id }), null);
  service.dispose();
  other.dispose();
});
