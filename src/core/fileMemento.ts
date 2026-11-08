// A Memento (see state.ts) kept in a JSON file, for frontends that have no
// editor storage of their own (the server). Every get reads what is on disk
// (cached by mtime) and every update rewrites the file atomically (write to a
// temporary file, then rename), so two processes on one repository see each
// other's marks; a write from both at the same instant keeps the later one.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Memento } from "./state";

export class FileMemento implements Memento {
  private cache: { mtimeMs: number; data: Record<string, unknown> } | undefined;

  constructor(readonly path: string) {}

  private read(): Record<string, unknown> {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      return {};
    }
    if (this.cache?.mtimeMs === mtimeMs) return this.cache.data;
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) data = parsed;
    } catch {
      // A damaged file reads as empty; the next update replaces it.
    }
    this.cache = { mtimeMs, data };
    return data;
  }

  get<T>(key: string): T | undefined {
    return this.read()[key] as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    const data = { ...this.read() };
    if (value === undefined) delete data[key];
    else data[key] = value;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 1) + "\n");
    renameSync(temporary, this.path);
    this.cache = undefined;
  }
}
