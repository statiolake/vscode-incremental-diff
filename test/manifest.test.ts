import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

interface Manifest {
  contributes: {
    commands: Array<{ command: string; title: string; category?: string }>;
    menus: Record<string, Array<{ command: string; when?: string }>>;
    keybindings?: unknown[];
    configuration: { properties: Record<string, unknown> };
  };
}

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as Manifest;
const readme = readFileSync("README.md", "utf8");
const source = readFileSync("src/extension.ts", "utf8");

test("every menu entry refers to a contributed command", () => {
  const commands = new Set(manifest.contributes.commands.map(item => item.command));
  for (const [menu, items] of Object.entries(manifest.contributes.menus)) {
    for (const item of items) assert.ok(commands.has(item.command), `${menu}: ${item.command}`);
  }
});

test("every contributed command is registered", () => {
  for (const { command } of manifest.contributes.commands) {
    assert.ok(source.includes(`"${command}"`), command);
  }
});

test("offers the review commands in the Command Palette", () => {
  const titles = manifest.contributes.commands.filter(item => item.category === "Incremental Diff").map(item => item.title);
  for (const title of ["Open Diff…", "Open Branch Changes", "Open All Changes", "Open Unreviewed Changes", "Open Changes Since Review", "Mark Reviewed and Next", "Refresh", "Close Review"]) {
    assert.ok(titles.includes(title), title);
  }
});

test("leaves keybindings to the user", () => {
  assert.equal(manifest.contributes.keybindings, undefined);
});

test("documents every setting in the README", () => {
  for (const key of Object.keys(manifest.contributes.configuration.properties)) assert.ok(readme.includes(`\`${key}\``), key);
});
