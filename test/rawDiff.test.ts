import assert from "node:assert/strict";
import test from "node:test";
import { parseRawDiff } from "../src/diff";

const a = "a".repeat(40);
const b = "b".repeat(40);
const zero = "0".repeat(40);

test("parses NUL-separated raw records, including renames and odd paths", () => {
  const output = [
    `:100644 100644 ${a} ${zero} M`, "src/app.ts",
    `:000000 100644 ${zero} ${b} A`, "new file\twith tab.txt",
    `:100644 000000 ${a} ${zero} D`, "gone.md",
    `:100644 100644 ${a} ${b} R087`, "old/name.ts", "new/name.ts",
    `:100644 100644 ${a} ${a} C100`, "orig.ts", "copy.ts",
    `:100644 120000 ${a} ${b} T`, "link",
    ""
  ].join("\0");
  assert.deepEqual(parseRawDiff(output), [
    { status: "M", path: "src/app.ts", oldMode: "100644", newMode: "100644", oldBlob: a, newBlob: zero },
    { status: "A", path: "new file\twith tab.txt", oldMode: "000000", newMode: "100644", oldBlob: zero, newBlob: b },
    { status: "D", path: "gone.md", oldMode: "100644", newMode: "000000", oldBlob: a, newBlob: zero },
    { status: "R", score: 87, oldPath: "old/name.ts", path: "new/name.ts", oldMode: "100644", newMode: "100644", oldBlob: a, newBlob: b },
    { status: "C", score: 100, oldPath: "orig.ts", path: "copy.ts", oldMode: "100644", newMode: "100644", oldBlob: a, newBlob: a },
    { status: "T", path: "link", oldMode: "100644", newMode: "120000", oldBlob: a, newBlob: b }
  ]);
});

test("empty output means no changes", () => {
  assert.deepEqual(parseRawDiff(""), []);
});

test("rejects malformed output", () => {
  assert.throws(() => parseRawDiff("src/app.ts\0"));
  assert.throws(() => parseRawDiff(`:100644 100644 ${a} ${b} R100\0only-one\0`));
  assert.throws(() => parseRawDiff(`:100644 100644 ${a} ${b} X\0p\0`));
});
