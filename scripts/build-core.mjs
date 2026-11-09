// Builds the core, incremental-diff (cmd/incremental-diff), into
// bin/<os>-<arch>/, where the extension and the Neovim plugin look for it.
//   node scripts/build-core.mjs        this machine's platform
//   node scripts/build-core.mjs --all  every platform the VSIX ships
// Pure Go without cgo, so it cross-compiles from anywhere; needs Go.
import { mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const allTargets = [["darwin", "arm64"], ["linux", "amd64"], ["linux", "arm64"]];
const hostPlatform = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
const hostArch = { arm64: "arm64", x64: "amd64" }[process.arch];
const targets = process.argv.includes("--all") ? allTargets : [[hostPlatform, hostArch]];

for (const [goos, goarch] of targets) {
  if (!goos || !goarch) throw new Error(`Unsupported build host: ${process.platform}-${process.arch}`);
  const directory = join("bin", `${goos}-${goarch}`);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const output = join(directory, goos === "windows" ? "incremental-diff.exe" : "incremental-diff");
  const result = spawnSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", output, "./cmd/incremental-diff"], {
    stdio: "inherit", env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" }
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
