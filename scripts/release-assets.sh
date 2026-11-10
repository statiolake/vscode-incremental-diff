#!/bin/sh
# Builds the release's prebuilt cores into DIR (default: release/):
# incremental-diff-<os>-<arch>.tar.gz, each holding the one executable, and
# SHA256SUMS over them, the layout build.lua downloads from a GitHub release.
# Pure Go without cgo, so it cross-compiles from anywhere; needs Go.
set -eu
cd "$(dirname "$0")/.."
name=incremental-diff
out=${1:-release}
targets="darwin-arm64 linux-amd64 linux-arm64"
rm -rf "$out"
mkdir -p "$out"
for target in $targets; do
  goos=${target%-*} goarch=${target#*-}
  stage="$out/stage-$target"
  mkdir -p "$stage"
  CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch \
    go build -trimpath -ldflags='-s -w' -o "$stage/$name" "./cmd/$name"
  tar -czf "$out/$name-$target.tar.gz" -C "$stage" "$name"
  rm -rf "$stage"
done
(cd "$out" && sha256sum -- *.tar.gz > SHA256SUMS)
