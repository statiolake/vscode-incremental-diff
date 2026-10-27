import Module from "node:module";

type Resolve = (request: string, ...rest: unknown[]) => string;
const moduleWithResolve = Module as unknown as { _resolveFilename: Resolve };
const original = moduleWithResolve._resolveFilename;
moduleWithResolve._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
  return request === "vscode" ? require.resolve("./vscodeMock") : original.call(this, request, ...rest);
};
