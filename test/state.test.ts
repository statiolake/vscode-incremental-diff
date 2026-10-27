import assert from "node:assert/strict";
import test from "node:test";
import { Memento, ReviewStateStore, historyLimit, reviewScope, reviewStatus } from "../src/state";

class MemoryMemento implements Memento {
  readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return structuredClone(this.data.get(key)) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, Math.random() * 3));
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, structuredClone(value));
  }
}

const now = () => new Date("2026-01-02T03:04:05.000Z");

test("stores marks per folder and diff spec and survives a new store", async () => {
  const memento = new MemoryMemento();
  const store = new ReviewStateStore(memento, now);
  const scope = reviewScope("file:///repo", "main...HEAD");
  const other = reviewScope("file:///repo", "HEAD~");
  await store.update(scope, new Map([["a.ts", "1111"], ["b.ts", "deleted"]]));
  assert.deepEqual([...new ReviewStateStore(memento).marks(scope)], [
    ["a.ts", { snapshot: "1111", reviewedAt: "2026-01-02T03:04:05.000Z" }],
    ["b.ts", { snapshot: "deleted", reviewedAt: "2026-01-02T03:04:05.000Z" }]
  ]);
  assert.equal(store.marks(other).size, 0);
  await store.update(scope, new Map([["a.ts", undefined]]));
  assert.deepEqual([...store.marks(scope).keys()], ["b.ts"]);
  await store.update(scope, new Map([["b.ts", undefined]]));
  assert.equal(memento.data.size, 0, "an empty review leaves nothing behind");
});

test("concurrent updates are not lost", async () => {
  const store = new ReviewStateStore(new MemoryMemento(), now);
  const scope = reviewScope("file:///repo", "");
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.update(scope, new Map([[`f${index}`, `${index}`]]))));
  assert.equal(store.marks(scope).size, 20);
});

test("clear forgets one review", async () => {
  const store = new ReviewStateStore(new MemoryMemento(), now);
  const scope = reviewScope("file:///repo", "");
  await store.update(scope, new Map([["a", "1"]]));
  await store.clear(scope);
  assert.equal(store.marks(scope).size, 0);
});

test("ignores malformed stored data", () => {
  const memento = new MemoryMemento();
  const scope = reviewScope("file:///repo", "");
  memento.data.set(`incrementalDiff.review:${scope}`, { version: 1, marks: { good: { snapshot: "1", reviewedAt: "x" }, bad: { snapshot: 3 }, empty: { snapshot: "", reviewedAt: "x" } } });
  assert.deepEqual([...new ReviewStateStore(memento).marks(scope).keys()], ["good"]);
  memento.data.set(`incrementalDiff.review:${scope}`, "garbage");
  assert.equal(new ReviewStateStore(memento).marks(scope).size, 0);
});

test("keeps a bounded, deduplicated history", async () => {
  const store = new ReviewStateStore(new MemoryMemento());
  for (let index = 0; index < historyLimit + 5; index++) await store.addHistory(`HEAD~${index}`);
  await store.addHistory("HEAD~3");
  const history = store.history();
  assert.equal(history.length, historyLimit);
  assert.equal(history[0], "HEAD~3");
  assert.equal(history.filter(item => item === "HEAD~3").length, 1);
  await store.removeHistory("HEAD~3");
  assert.ok(!store.history().includes("HEAD~3"));
});

test("remembers the open review", async () => {
  const store = new ReviewStateStore(new MemoryMemento());
  assert.equal(store.session(), undefined);
  await store.setSession({ folder: "file:///repo", input: "" });
  assert.deepEqual(store.session(), { folder: "file:///repo", input: "" });
  await store.setSession({ folder: "file:///repo", branch: true });
  assert.deepEqual(store.session(), { folder: "file:///repo", branch: true });
  await store.setSession(undefined);
  assert.equal(store.session(), undefined);
});

test("review status follows the snapshot", () => {
  assert.equal(reviewStatus("1", undefined), "unreviewed");
  assert.equal(reviewStatus("1", { snapshot: "1", reviewedAt: "" }), "reviewed");
  assert.equal(reviewStatus("2", { snapshot: "1", reviewedAt: "" }), "changed");
  assert.equal(reviewStatus("deleted", { snapshot: "deleted", reviewedAt: "" }), "reviewed");
});
