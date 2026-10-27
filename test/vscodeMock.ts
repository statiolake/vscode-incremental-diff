// A minimal stand-in for the `vscode` module, enough to drive ReviewController
// outside an extension host. Installed by installVscodeMock.ts.

export class Uri {
  private constructor(readonly scheme: string, readonly path: string, readonly query: string) {}
  static file(path: string): Uri { return new Uri("file", path.replace(/\\/g, "/"), ""); }
  static from(parts: { scheme: string; path: string; query?: string }): Uri { return new Uri(parts.scheme, parts.path, parts.query ?? ""); }
  get fsPath(): string { return this.path; }
  with(change: { scheme?: string; path?: string; query?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.path ?? this.path, change.query ?? this.query);
  }
  toString(): string { return `${this.scheme}://${this.path}${this.query ? `?${this.query}` : ""}`; }
}

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];
  readonly event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter(item => item !== listener); } };
  };
  fire(value: T): void { for (const listener of this.listeners) listener(value); }
  dispose(): void { this.listeners = []; }
}

export class RelativePattern {
  constructor(readonly base: Uri, readonly pattern: string) {}
}

export const settings = new Map<string, unknown>();
export const executed: Array<{ command: string; args: unknown[] }> = [];
const disposable = { dispose() {} };

export const workspace = {
  getConfiguration: () => ({ get: <T>(key: string, fallback: T): T => (settings.has(key) ? settings.get(key) : fallback) as T }),
  createFileSystemWatcher: () => ({ onDidChange: () => disposable, onDidCreate: () => disposable, onDidDelete: () => disposable, dispose() {} }),
  onDidSaveTextDocument: () => disposable
};

export const commands = {
  executeCommand: async (command: string, ...args: unknown[]) => { executed.push({ command, args }); }
};

export const window = {
  showWarningMessage: async (message: string) => { throw new Error(message); }
};
