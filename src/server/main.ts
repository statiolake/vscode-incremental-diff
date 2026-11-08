// incremental-diff-server: the core behind JSON-RPC 2.0 on stdin / stdout,
// one JSON object per line (docs/server.md). Started by a client (the
// Neovim plugin) as a child process and ended with it: when stdin closes,
// every review is closed and the process exits.

import { createInterface } from "node:readline";
import { ReviewService, RequestError } from "./service";

declare const SERVER_VERSION: string;
const version = typeof SERVER_VERSION === "string" ? SERVER_VERSION : "dev";

function send(message: object): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

const service = new ReviewService((method, params) => send({ method, params }), { version });

// Requests run concurrently; each answers when it is done. A client that
// needs an order (refresh, then mark) waits for one answer before asking again.
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
  if (!line.trim()) return;
  let message: { id?: number | string; method?: string; params?: unknown };
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const { id, method, params } = message;
  if (typeof method !== "string") {
    if (id !== undefined) send({ id, error: { code: -32600, message: "Invalid request" } });
    return;
  }
  service.handle(method, params).then(
    result => { if (id !== undefined) send({ id, result: result ?? null }); },
    error => {
      if (id === undefined) return;
      const code = error instanceof RequestError ? -32602 : -32000;
      send({ id, error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  );
});
lines.on("close", () => {
  service.dispose();
  process.exit(0);
});
