import assert from "node:assert/strict";
import test from "node:test";
import { FolderNode, ReviewFile, TreeNode, buildTree, flattenTree, folderChecked, nextUnreviewed } from "../src/treeModel";
import { ReviewStatus } from "../src/state";

const file = (path: string, review: ReviewStatus = "unreviewed"): ReviewFile => ({ status: "M", path, review });

const shape = (nodes: TreeNode[]): unknown[] => nodes.map(node => node.kind === "folder"
  ? { [node.label]: shape(node.children) }
  : node.file.path);

test("builds a compacted folder hierarchy with folders first", () => {
  const files = [file("z.ts"), file("src/util/deep/a.ts"), file("src/b.ts"), file("src/util/deep/c.ts"), file("README.md"), file("docs/x/y/z.md")];
  assert.deepEqual(shape(buildTree(files, "tree")), [
    { "docs/x/y": ["docs/x/y/z.md"] },
    { src: [{ "util/deep": ["src/util/deep/a.ts", "src/util/deep/c.ts"] }, "src/b.ts"] },
    "README.md",
    "z.ts"
  ]);
  const src = buildTree(files, "tree")[1] as FolderNode;
  assert.equal(src.path, "src");
  assert.equal((src.children[0] as FolderNode).path, "src/util/deep");
  assert.deepEqual(src.files.map(item => item.path), ["src/util/deep/a.ts", "src/util/deep/c.ts", "src/b.ts"]);
});

test("flat mode sorts by path", () => {
  assert.deepEqual(shape(buildTree([file("b/a.ts"), file("a.ts"), file("b.ts")], "flat")), ["a.ts", "b.ts", "b/a.ts"]);
});

test("a folder is checked only when every file below it is reviewed", () => {
  const [folder] = buildTree([file("src/a.ts", "reviewed"), file("src/b/c.ts", "reviewed")], "tree") as FolderNode[];
  assert.equal(folderChecked(folder), true);
  const [partial] = buildTree([file("src/a.ts", "reviewed"), file("src/b.ts", "changed")], "tree") as FolderNode[];
  assert.equal(folderChecked(partial), false);
});

test("next unreviewed file follows display order and wraps", () => {
  const order = flattenTree(buildTree([file("a.ts", "reviewed"), file("src/x.ts"), file("src/y.ts", "reviewed"), file("b.ts", "changed")], "tree"));
  assert.deepEqual(order.map(item => item.path), ["src/x.ts", "src/y.ts", "a.ts", "b.ts"]);
  assert.equal(nextUnreviewed(order, "src/x.ts")?.path, "b.ts");
  assert.equal(nextUnreviewed(order, "b.ts")?.path, "src/x.ts");
  assert.equal(nextUnreviewed(order, undefined)?.path, "src/x.ts");
  assert.equal(nextUnreviewed([file("only.ts")], "only.ts"), undefined);
});
