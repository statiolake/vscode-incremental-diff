import "./installVscodeMock";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type * as vscode from "vscode";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CoreConnection } from "../src/vscode/core";
import { ReviewController, readSessionRecord } from "../src/vscode/review";
import { TempRepo } from "./helpers";
import { Uri, executed } from "./vscodeMock";

class MemoryMemento {
  readonly data = new Map<string, unknown>();
  keys(): readonly string[] { return [...this.data.keys()]; }
  get<T>(key: string): T | undefined { return this.data.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, value);
  }
}

// The core as the extension ships it (npm run build:core).
const executable = join(__dirname, "..", "..", "bin",
  `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`,
  process.platform === "win32" ? "incremental-diff.exe" : "incremental-diff");
assert.ok(existsSync(executable), `${executable} is missing: run npm run build:core`);
const core = new CoreConnection(executable);
const git = (...args: string[]) => repo.git(...args);

const repo = new TempRepo();
after(() => {
  core.dispose();
  repo.dispose();
});
const memento = () => new MemoryMemento() as unknown as vscode.Memento;
const folder = { uri: Uri.file(repo.root), name: "repo", index: 0 } as unknown as vscode.WorkspaceFolder;
const statuses = (controller: ReviewController) => controller.files.map(file => `${file.path}:${file.review}`);
const lastCommand = () => executed[executed.length - 1];

test("reviews files incrementally against the work tree", async () => {
  repo.write("a.txt", "a\n");
  repo.write("src/b.txt", "b\n");
  repo.write("gone.txt", "gone\n");
  repo.commit("base");
  repo.write("a.txt", "a1\n");
  repo.write("src/b.txt", "b1\n");
  repo.remove("gone.txt");
  repo.write("new.txt", "new\n");

  const state = memento();
  const controller = new ReviewController(core, state, undefined);
  await controller.open(folder, { input: "HEAD" });
  assert.deepEqual(readSessionRecord(state), { folder: folder.uri.toString(), input: "HEAD" });
  assert.equal(controller.title, "git diff HEAD");
  assert.deepEqual(statuses(controller), ["a.txt:unreviewed", "gone.txt:unreviewed", "new.txt:unreviewed", "src/b.txt:unreviewed"]);

  await controller.setReviewed(["a.txt", "gone.txt", "src/b.txt"], true);
  assert.deepEqual(statuses(controller), ["a.txt:reviewed", "gone.txt:reviewed", "new.txt:unreviewed", "src/b.txt:reviewed"]);
  const refs = git("for-each-ref", "--format=%(refname)", "refs/incremental-diff/");
  assert.equal(refs.trim().split("\n").length, 1);

  // Edit a reviewed file: it is unchecked and shows snapshot -> current.
  repo.write("a.txt", "a2\n");
  await controller.refresh();
  assert.deepEqual(statuses(controller), ["a.txt:changed", "gone.txt:reviewed", "new.txt:unreviewed", "src/b.txt:reviewed"]);
  const changed = controller.file("a.txt")!;
  await controller.openFile(changed, "auto");
  const [snapshot, current, title] = lastCommand().args as [Uri, Uri, string];
  assert.equal(lastCommand().command, "vscode.diff");
  assert.equal(snapshot.scheme, "incremental-diff");
  assert.equal(git("cat-file", "blob", JSON.parse(snapshot.query).blob), "a1\n");
  assert.equal(current.scheme, "file");
  assert.equal(title, "a.txt (Since Review)");
  await controller.openFile(changed, "full");
  assert.equal(JSON.parse((lastCommand().args[0] as Uri).query).side, "left");

  // Added and deleted files get an empty side.
  await controller.openFile(controller.file("new.txt")!, "full");
  assert.equal(JSON.parse((lastCommand().args[0] as Uri).query).blob, "");
  await controller.openFile(controller.file("gone.txt")!, "full");
  assert.equal(JSON.parse((lastCommand().args[1] as Uri).query).blob, "");

  assert.equal(await controller.openMulti("since"), 1);
  assert.equal(lastCommand().command, "vscode.changes");
  const [multiTitle, resources] = lastCommand().args as [string, Uri[][]];
  assert.equal(multiTitle, "Changes Since Review: git diff HEAD");
  assert.equal(resources[0][0].path, `${repo.root}/a.txt`);
  assert.equal(await controller.openMulti("unreviewed"), 2);
  assert.equal(await controller.openMulti("all"), 4);
  assert.equal(controller.next("a.txt")?.path, "new.txt");

  // The file is found from any of its editor URIs.
  assert.equal(controller.fileForUri(snapshot as unknown as vscode.Uri)?.path, "a.txt");
  assert.equal(controller.fileForUri(Uri.file(`${repo.root}/src/b.txt`) as unknown as vscode.Uri)?.path, "src/b.txt");

  // Review state survives a reload (in the repository, shared with every
  // frontend); a reverted change disappears from the list.
  repo.git("checkout", "--", "src/b.txt");
  const reloadedState = memento();
  const secondCore = new CoreConnection(executable);
  const reloaded = new ReviewController(secondCore, reloadedState, undefined);
  await reloaded.open(folder, { input: "  HEAD " });
  assert.deepEqual(await reloaded.history(folder), ["  HEAD ", "HEAD"]);
  assert.deepEqual(statuses(reloaded), ["a.txt:changed", "gone.txt:reviewed", "new.txt:unreviewed"]);

  await reloaded.setReviewed(["a.txt"], true);
  assert.equal(reloaded.file("a.txt")?.review, "reviewed");
  await reloaded.setReviewed(["a.txt"], false);
  assert.equal(reloaded.file("a.txt")?.review, "unreviewed");

  await reloaded.clearReviewed();
  assert.ok(reloaded.files.every(file => file.review === "unreviewed"));
  assert.equal(git("for-each-ref", "refs/incremental-diff/").trim(), "");
  await reloaded.close();
  assert.equal(reloaded.active, false);
  assert.equal(readSessionRecord(reloadedState), undefined, "a closed review is not reopened");
  controller.dispose();
  reloaded.dispose();
  secondCore.dispose();
});

test("rejects folders outside git and bad revisions without closing the open review", async () => {
  const controller = new ReviewController(core, memento(), undefined);
  await controller.open(folder, { input: "" });
  await assert.rejects(controller.open(folder, { input: "no-such-rev --" }), /Unknown revision/);
  assert.equal(controller.title, "Unstaged Changes");
  controller.dispose();
});
