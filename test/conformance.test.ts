// The protocol conformance scenarios in test/conformance/protocol.json (the
// fixture says how to read them), played against a server over stdio. The
// Go server's own runner (internal/server/conformance_test.go) plays the
// same file.
import assert from "node:assert/strict";
import { ChildProcessByStdio, execFileSync, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { describe, test } from "node:test";
import { TempRepo } from "./helpers";

const repoRoot = join(__dirname, "..", "..");
const fixture = JSON.parse(readFileSync(join(repoRoot, "test", "conformance", "protocol.json"), "utf8")) as {
  scenarios: Array<{ name: string; steps: Array<Record<string, any>> }>;
};

/** The server under test: the TypeScript one (src/server), compiled. */
const serverCommand = (): [string, string[]] => [process.execPath, [join(repoRoot, "dist-test", "src", "server", "main.js")]];

class Client {
  readonly child: ChildProcessByStdio<Writable, Readable, null>;
  private byId = new Map<string, any>();
  readonly notes: any[] = [];
  private waiters = new Set<() => void>();
  private nextId = 1000;

  constructor() {
    const [command, args] = serverCommand();
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
    createInterface({ input: this.child.stdout }).on("line", line => {
      const message = JSON.parse(line);
      if ("id" in message) this.byId.set(JSON.stringify(message.id), message);
      else this.notes.push(message);
      for (const waiter of this.waiters) waiter();
    });
  }

  send(line: string): void {
    this.child.stdin.write(line + "\n");
  }

  /** Waits until pick answers something (at most 10s); undefined on timeout. */
  wait<T>(pick: () => T | undefined): Promise<T | undefined> {
    return new Promise(resolve => {
      const check = () => {
        const value = pick();
        if (value === undefined) return;
        this.waiters.delete(check);
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => { this.waiters.delete(check); resolve(undefined); }, 10000);
      this.waiters.add(check);
      check();
    });
  }

  async response(key: string): Promise<any> {
    const message = await this.wait(() => {
      const found = this.byId.get(key);
      if (found !== undefined) this.byId.delete(key);
      return found;
    });
    assert.ok(message, `timed out waiting for the answer to ${key}`);
    return message;
  }

  async request(method: string, params: unknown): Promise<any> {
    const id = ++this.nextId;
    this.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return this.response(String(id));
  }

  close(): Promise<number | null> {
    const exited = new Promise<number | null>(resolve => this.child.on("exit", resolve));
    this.child.stdin.end();
    return exited;
  }
}

const oid = /^[0-9a-f]{40}$/;
const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;

/** Checks actual against an expectation of the fixture; answers what differs. */
function mismatch(expected: unknown, actual: unknown, path = "$"): string | undefined {
  if (expected === "<any>") return actual === undefined ? `${path} is missing` : undefined;
  if (expected === "<oid>") return typeof actual === "string" && oid.test(actual) ? undefined : `${path}: ${JSON.stringify(actual)} is not an object id`;
  if (expected === "<iso>") return typeof actual === "string" && iso.test(actual) ? undefined : `${path}: ${JSON.stringify(actual)} is not an ISO 8601 time`;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return `${path}: ${JSON.stringify(actual)}, want ${expected.length} items`;
    for (const [index, item] of expected.entries()) {
      const found = mismatch(item, actual[index], `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return `${path}: ${JSON.stringify(actual)} is not an object`;
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    for (const key of Object.keys(e).filter(key => key !== "<...>").sort()) {
      if (!(key in a)) return `${path}.${key} is missing`;
      const found = mismatch(e[key], a[key], `${path}.${key}`);
      if (found) return found;
    }
    if (e["<...>"] !== true) {
      for (const key of Object.keys(a)) if (!(key in e)) return `${path}.${key} is not expected (${JSON.stringify(a[key])})`;
    }
    return undefined;
  }
  return expected === actual ? undefined : `${path}: ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`;
}

class Player {
  readonly repo = new TempRepo();
  readonly client = new Client();
  private saved = new Map<string, unknown>();
  private seen = 0;

  substitute(value: unknown): unknown {
    if (typeof value === "string") {
      const whole = /^\{([A-Za-z]+)\}$/.exec(value);
      if (whole && this.saved.has(whole[1])) return this.saved.get(whole[1]);
      return value.replace(/\{(root|rev:[^}]*|hash:[^}]*|[A-Za-z]+)\}/g, (token, name: string) => {
        if (name === "root") return this.repo.root;
        if (name.startsWith("rev:")) return this.repo.git("rev-parse", name.slice(4)).trim();
        if (name.startsWith("hash:")) return this.repo.git("hash-object", "--no-filters", name.slice(5)).trim();
        return this.saved.has(name) ? String(this.saved.get(name)) : token;
      });
    }
    if (Array.isArray(value)) return value.map(item => this.substitute(item));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.substitute(key) as string, this.substitute(item)]));
    }
    return value;
  }

  expect(where: string, expected: unknown, actual: unknown): void {
    const found = mismatch(this.substitute(expected), actual);
    assert.equal(found, undefined, `${where}: ${found}\nactual: ${JSON.stringify(actual, null, 2)}`);
  }

  statePath(): string {
    const common = this.repo.git("rev-parse", "--path-format=absolute", "--git-common-dir").trim();
    return join(common, "incremental-diff", "state.json");
  }

  async step(index: number, s: Record<string, any>): Promise<void> {
    let where = `step ${index + 1}`;
    if (s.write) {
      for (const [path, content] of Object.entries(s.write as Record<string, string>)) this.repo.write(path, content);
    } else if (s.remove) {
      for (const path of s.remove as string[]) this.repo.remove(path);
    } else if (s.git) {
      execFileSync("git", s.git, { cwd: this.repo.root, stdio: ["ignore", "pipe", "pipe"] });
    } else if (s.commit !== undefined) {
      this.repo.commit(s.commit);
    } else if (s.request) {
      where += ` (${s.request})`;
      const message = await this.client.request(s.request, this.substitute(s.params));
      assert.equal(message.jsonrpc, "2.0", where);
      if (s.error) {
        this.expect(`${where}: error`, s.error, message.error);
        assert.ok(!("result" in message), `${where}: an error has no result`);
        return;
      }
      assert.ok(!message.error, `${where}: ${JSON.stringify(message.error)}`);
      assert.ok("result" in message, `${where}: no result`);
      this.expect(where, s.result, message.result);
      for (const [name, path] of Object.entries((s.save ?? {}) as Record<string, string>)) {
        this.saved.set(name, path.split(".").reduce<any>((value, part) => value?.[part], message.result));
      }
    } else if (s.raw !== undefined) {
      this.client.send(s.raw);
      this.expect(`${where}: response`, s.response, await this.client.response(JSON.stringify(s.response.id)));
    } else if (s.notification) {
      const expected = this.substitute(s.params);
      let last: string | undefined;
      const found = await this.client.wait(() => {
        for (; this.seen < this.client.notes.length; this.seen++) {
          const note = this.client.notes[this.seen];
          if (note.method !== s.notification || note.jsonrpc !== "2.0") continue;
          last = mismatch(expected, note.params, "params");
          if (!last) return ++this.seen;
        }
        return undefined;
      });
      assert.ok(found, `${where}: no matching ${s.notification} (the last one: ${last})`);
    } else if (s.stateFile) {
      this.expect(`${where}: state.json`, s.stateFile, JSON.parse(readFileSync(this.statePath(), "utf8")));
    } else if (s.writeState) {
      mkdirSync(dirname(this.statePath()), { recursive: true });
      writeFileSync(this.statePath(), JSON.stringify(this.substitute(s.writeState), null, 1));
    } else {
      assert.fail(`${where}: unknown step ${JSON.stringify(s)}`);
    }
  }
}

describe("protocol conformance", () => {
  for (const scenario of fixture.scenarios) {
    test(scenario.name, async () => {
      const player = new Player();
      try {
        for (const [index, step] of scenario.steps.entries()) await player.step(index, step);
      } finally {
        assert.equal(await player.client.close(), 0, "the server exits 0 when its stdin closes");
        player.repo.dispose();
      }
    });
  }
});
