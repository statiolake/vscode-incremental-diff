import assert from "node:assert/strict";
import test from "node:test";
import { DiffSpecError, describeSpec, parseDiffSpec, tokenize } from "../src/diffSpec";

test("tokenizes like a shell", () => {
  assert.deepEqual(tokenize(`  main...HEAD -- "src/a b.ts" 'it''s' c\\ d `), ["main...HEAD", "--", "src/a b.ts", "its", "c d"]);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize(`""`), [""]);
  assert.throws(() => tokenize(`"open`), DiffSpecError);
});

test("no arguments compare the index with the work tree", () => {
  const spec = parseDiffSpec("");
  assert.deepEqual([spec.left, spec.right], [{ kind: "index" }, { kind: "worktree" }]);
  assert.equal(spec.key, "");
  assert.equal(describeSpec(spec), "Unstaged Changes");
});

test("--cached and --staged compare a revision with the index", () => {
  for (const input of ["--cached", "--staged"]) {
    const spec = parseDiffSpec(input);
    assert.deepEqual([spec.left, spec.right], [{ kind: "rev", rev: "HEAD" }, { kind: "index" }]);
    assert.equal(spec.key, "--cached");
  }
  const spec = parseDiffSpec("--staged main");
  assert.deepEqual([spec.left, spec.right], [{ kind: "rev", rev: "main" }, { kind: "index" }]);
  assert.equal(spec.key, "--cached main");
});

test("one revision compares it with the work tree", () => {
  const spec = parseDiffSpec("HEAD~3");
  assert.deepEqual([spec.left, spec.right], [{ kind: "rev", rev: "HEAD~3" }, { kind: "worktree" }]);
});

test("two-dot and three-dot ranges", () => {
  let spec = parseDiffSpec("a..b");
  assert.deepEqual([spec.left, spec.right], [{ kind: "rev", rev: "a" }, { kind: "rev", rev: "b" }]);
  spec = parseDiffSpec("a..");
  assert.deepEqual([spec.left, spec.right], [{ kind: "rev", rev: "a" }, { kind: "rev", rev: "HEAD" }]);
  spec = parseDiffSpec("main...feature");
  assert.deepEqual([spec.left, spec.right], [{ kind: "mergeBase", a: "main", b: "feature" }, { kind: "rev", rev: "feature" }]);
  spec = parseDiffSpec("main...");
  assert.deepEqual([spec.left, spec.right], [{ kind: "mergeBase", a: "main", b: "HEAD" }, { kind: "rev", rev: "HEAD" }]);
  spec = parseDiffSpec("abc^!");
  assert.deepEqual([spec.left, spec.right], [{ kind: "rev", rev: "abc^" }, { kind: "rev", rev: "abc" }]);
  spec = parseDiffSpec("a b");
  assert.deepEqual([spec.left, spec.right], [{ kind: "rev", rev: "a" }, { kind: "rev", rev: "b" }]);
});

test("--merge-base", () => {
  let spec = parseDiffSpec("--merge-base origin/main");
  assert.deepEqual([spec.left, spec.right], [{ kind: "mergeBase", a: "origin/main", b: "HEAD" }, { kind: "worktree" }]);
  spec = parseDiffSpec("--merge-base a b");
  assert.deepEqual([spec.left, spec.right], [{ kind: "mergeBase", a: "a", b: "b" }, { kind: "rev", rev: "b" }]);
  assert.throws(() => parseDiffSpec("--merge-base"), DiffSpecError);
  assert.throws(() => parseDiffSpec("--merge-base a..b"), DiffSpecError);
});

test("pathspecs and options", () => {
  const spec = parseDiffSpec("git diff -w main -- src 'docs/a b.md'");
  assert.deepEqual(spec.options, ["-w"]);
  assert.deepEqual(spec.pathspecs, ["src", "docs/a b.md"]);
  assert.equal(spec.key, "-w main -- src 'docs/a b.md'");
  const paths = parseDiffSpec("main src", word => word === "main");
  assert.deepEqual(paths.pathspecs, ["src"]);
  assert.deepEqual(paths.left, { kind: "rev", rev: "main" });
});

test("equivalent spellings share one key", () => {
  assert.equal(parseDiffSpec("  --staged   HEAD ").key, parseDiffSpec("--cached HEAD").key);
  assert.equal(parseDiffSpec("git diff main...HEAD").key, parseDiffSpec("main...HEAD").key);
  assert.equal(parseDiffSpec("--no-color main").key, "main");
});

test("rejects unsupported arguments", () => {
  for (const input of ["--stat", "--name-only", "-p main", "a b c", "--cached a..b", "--cached a b", "a..b c", "--word-diff"]) {
    assert.throws(() => parseDiffSpec(input), DiffSpecError, input);
  }
});
