#!/bin/sh
# Builds the core, incremental-diff (cmd/incremental-diff), into
# bin/<os>-<arch>/ for every platform the plugin ships. bin/ is committed:
# the Neovim plugin and the VSIX run it as is, so nothing is built on install.
# Run this after changing the core (cmd/, internal/, go.mod, go.sum) and
# commit bin/ with the change; on main, .github/workflows/bin.yml does it
# when you don't, and bin-check fails a pull request whose bin/ is stale.
#
#   scripts/build-bins.sh                 every target, into bin/
#   scripts/build-bins.sh host            this machine's target only
#   scripts/build-bins.sh --out DIR [...] into DIR instead of bin/
#   scripts/build-bins.sh --check         fail unless bin/ is what the source builds
#
# The build is reproducible: pure Go without cgo, -trimpath, no VCS stamp,
# stripped, and one Go release (GOTOOLCHAIN, below; Go fetches it if the
# installed one differs), so the same source gives the same bytes anywhere.
set -eu
cd "$(dirname "$0")/.."
name=incremental-diff
targets="darwin-arm64 linux-amd64 linux-arm64"
export GOTOOLCHAIN="${GOTOOLCHAIN_BINS:-go1.24.7}"
export CGO_ENABLED=0 GOFLAGS=

out=bin check=
while [ $# -gt 0 ]; do
  case $1 in
    --out) out=$2; shift 2 ;;
    --check) check=1; shift ;;
    host)
      host="$(go env GOHOSTOS)-$(go env GOHOSTARCH)"
      case " $targets " in
        *" $host "*) targets=$host ;;
        *) echo "build-bins: $host is not a supported target ($targets)" >&2; exit 1 ;;
      esac
      shift ;;
    *) echo "usage: $0 [host] [--out DIR] [--check]" >&2; exit 2 ;;
  esac
done

if [ -n "$check" ]; then
  fresh=$(mktemp -d)
  trap 'rm -rf "$fresh"' EXIT
  "$0" --out "$fresh"
  if diff -r "$fresh" bin > /dev/null && [ -z "$(find bin -type f ! -perm -u+x)" ]; then
    echo "bin/ matches the source ($(go version | cut -d' ' -f3))"
    exit 0
  fi
  echo "bin/ is stale: it is not what the source builds. Run scripts/build-bins.sh and commit bin/." >&2
  for f in $(cd "$fresh" && find . -type f) $(cd bin && find . -type f); do
    cmp -s "$fresh/$f" "bin/$f" || echo "  differs: bin/${f#./}"
  done | sort -u >&2
  exit 1
fi

for target in $targets; do
  goos=${target%-*} goarch=${target#*-}
  exe=$name
  if [ "$goos" = windows ]; then exe=$name.exe; fi
  rm -rf "$out/$target"
  mkdir -p "$out/$target"
  GOOS=$goos GOARCH=$goarch go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' \
    -o "$out/$target/$exe" "./cmd/$name"
  chmod 755 "$out/$target/$exe"
done
