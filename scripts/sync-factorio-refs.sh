#!/usr/bin/env bash
#
# Pin the local Factorio reference material to the version of the installed
# binary.
#
#   pnpm refs:sync            pin everything to the local binary's version
#   pnpm refs:sync 2.1.11     pin everything to an explicit version
#   pnpm refs:sync --check    report drift, change nothing, exit 1 on mismatch
#
# Two references are synced:
#
#   ~/GitHub/factorio-data    game data Lua (wube/factorio-data), checked out
#                             at the matching tag
#   factorioLuaAPI/           the Lua API docs, from the official
#                             lua-api.factorio.com/<version>/static/archive.zip
#
# The binary is the authority. It is the one piece Steam updates without
# asking, so it decides the version and the other two follow - fetching
# "latest" instead would race the updater and silently leave the references
# describing a different game than the one the fixtures were captured from.
#
# Overrides: FACTORIO_BIN, FACTORIO_DATA_DIR.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCS_DIR="$REPO_ROOT/factorioLuaAPI"
DATA_DIR="${FACTORIO_DATA_DIR:-$HOME/GitHub/factorio-data}"
DATA_REMOTE="https://github.com/wube/factorio-data.git"

CHECK_ONLY=0
FIXTURES_ONLY=0
WANT_VERSION=""

for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --fixtures) FIXTURES_ONLY=1 ;;
    -h | --help)
      sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
    *) WANT_VERSION="$arg" ;;
  esac
done

die() {
  echo "error: $*" >&2
  exit 1
}

# --- the binary ---------------------------------------------------------

find_binary() {
  if [ -n "${FACTORIO_BIN:-}" ]; then
    [ -x "$FACTORIO_BIN" ] || die "FACTORIO_BIN is set but not executable: $FACTORIO_BIN"
    echo "$FACTORIO_BIN"
    return
  fi
  local candidates=(
    "$HOME/Library/Application Support/Steam/steamapps/common/Factorio/factorio.app/Contents/MacOS/factorio"
    "/Applications/factorio.app/Contents/MacOS/factorio"
    "$HOME/.steam/steam/steamapps/common/Factorio/bin/x64/factorio"
    "$HOME/.factorio/bin/x64/factorio"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    [ -x "$candidate" ] && {
      echo "$candidate"
      return
    }
  done
  return 1
}

binary_version() {
  # "Version: 2.1.12 (build 87038, mac-arm64, steam)" -> "2.1.12"
  "$1" --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

BINARY_VERSION=""
if BINARY="$(find_binary)"; then
  BINARY_VERSION="$(binary_version "$BINARY")"
  [ -n "$BINARY_VERSION" ] || die "could not parse a version out of: $BINARY --version"
fi

if [ -z "$WANT_VERSION" ]; then
  [ -n "$BINARY_VERSION" ] || die "no Factorio binary found - pass a version explicitly (pnpm refs:sync 2.1.12) or set FACTORIO_BIN"
  WANT_VERSION="$BINARY_VERSION"
fi

# --- current state ------------------------------------------------------

data_version() {
  [ -d "$DATA_DIR/.git" ] || {
    echo ""
    return
  }
  grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$DATA_DIR/base/info.json" 2>/dev/null |
    grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

docs_version() {
  cat "$DOCS_DIR/VERSION" 2>/dev/null || echo ""
}

DATA_NOW="$(data_version)"
DOCS_NOW="$(docs_version)"

report() {
  printf '  %-14s %s\n' "binary" "${BINARY_VERSION:-(not found)}"
  printf '  %-14s %s\n' "factorio-data" "${DATA_NOW:-(not cloned)}"
  printf '  %-14s %s\n' "lua-api docs" "${DOCS_NOW:-(missing)}"
}

# --- fixture staleness ---------------------------------------------------

# Which oracle fixtures were captured on an older Factorio than the one
# installed. This is a REPORT, not a gate: a fixture captured on 2.1.11 is not
# wrong just because the binary moved on - it means that ground truth has not
# been re-validated since. Deciding whether the gap matters needs a human, so
# this never runs inside `verify` and always exits 0.
if [ "$FIXTURES_ONLY" = 1 ]; then
  MANIFEST="$REPO_ROOT/test/fixtures/PROVENANCE.json"
  [ -f "$MANIFEST" ] || die "no fixture manifest at $MANIFEST"
  [ -n "$BINARY_VERSION" ] || die "no Factorio binary found - nothing to compare fixtures against"

  python3 - "$MANIFEST" "$BINARY_VERSION" <<'PY'
import json, sys
from collections import defaultdict

manifest, binary = sys.argv[1], sys.argv[2]
fixtures = json.load(open(manifest))["fixtures"]


def key(v):
    return tuple(int(p) for p in v.split("."))


groups, unknown = defaultdict(list), []
for name, entry in sorted(fixtures.items()):
    v = entry["factorioVersion"]
    (unknown if v == "unknown" else groups[v]).append(name)

print(f"Fixture ground truth vs the installed binary ({binary}):")
for v in sorted(groups, key=key):
    n = len(groups[v])
    mark = "current" if v == binary else f"{binary} is newer"
    print(f"  {v:9} {n:3} fixture(s)   {mark}")
if unknown:
    print(f"  {'unknown':9} {len(unknown):3} fixture(s)   provenance never recorded")
    for name in unknown:
        print(f"              {name}")

stale = sorted((v for v in groups if key(v) < key(binary)), key=key)
if stale:
    total = sum(len(groups[v]) for v in stale)
    print(f"\n{total} fixture(s) predate the installed binary. Not necessarily wrong -")
    print("re-capture only where the subsystem changed between those versions.")
else:
    print("\nAll dated fixtures match the installed binary.")
PY
  exit 0
fi

if [ "$CHECK_ONLY" = 1 ]; then
  echo "Factorio reference versions (target $WANT_VERSION):"
  report
  if [ "$DATA_NOW" = "$WANT_VERSION" ] && [ "$DOCS_NOW" = "$WANT_VERSION" ]; then
    echo "  -> in sync"
    exit 0
  fi
  echo "  -> DRIFT: run 'pnpm refs:sync' to pin everything to $WANT_VERSION" >&2
  exit 1
fi

if [ "$DATA_NOW" = "$WANT_VERSION" ] && [ "$DOCS_NOW" = "$WANT_VERSION" ]; then
  echo "Factorio references already at $WANT_VERSION - nothing to do."
  report
  exit 0
fi

echo "Pinning Factorio references to $WANT_VERSION"
[ -n "$BINARY_VERSION" ] && [ "$BINARY_VERSION" != "$WANT_VERSION" ] &&
  echo "  note: local binary is $BINARY_VERSION, syncing to $WANT_VERSION anyway (explicit override)"

# --- game data ----------------------------------------------------------

if [ "$DATA_NOW" = "$WANT_VERSION" ]; then
  echo "  factorio-data  already $WANT_VERSION"
else
  if [ ! -d "$DATA_DIR/.git" ]; then
    echo "  factorio-data  cloning into $DATA_DIR"
    mkdir -p "$(dirname "$DATA_DIR")"
    git clone --quiet "$DATA_REMOTE" "$DATA_DIR"
  fi

  if [ -n "$(git -C "$DATA_DIR" status --porcelain)" ]; then
    die "$DATA_DIR has uncommitted changes - refusing to check out $WANT_VERSION over them"
  fi

  git -C "$DATA_DIR" fetch --quiet --tags origin
  git -C "$DATA_DIR" rev-parse -q --verify "refs/tags/$WANT_VERSION" >/dev/null ||
    die "wube/factorio-data has no tag $WANT_VERSION"
  git -C "$DATA_DIR" checkout --quiet "$WANT_VERSION"

  # The checkout is not the proof - base/info.json is. CLAUDE.md tells you to
  # confirm this by hand; do it here so a bad checkout cannot pass silently.
  got="$(data_version)"
  [ "$got" = "$WANT_VERSION" ] ||
    die "checked out tag $WANT_VERSION but base/info.json reads $got"
  echo "  factorio-data  ${DATA_NOW:-(none)} -> $WANT_VERSION"
fi

# --- api docs -----------------------------------------------------------

if [ "$DOCS_NOW" = "$WANT_VERSION" ]; then
  echo "  lua-api docs   already $WANT_VERSION"
else
  ARCHIVE_URL="https://lua-api.factorio.com/$WANT_VERSION/static/archive.zip"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  echo "  lua-api docs   downloading $ARCHIVE_URL"
  curl -fsSL "$ARCHIVE_URL" -o "$TMP_DIR/archive.zip" ||
    die "download failed - does lua-api.factorio.com publish $WANT_VERSION?"

  unzip -q "$TMP_DIR/archive.zip" -d "$TMP_DIR/extracted"

  # The archive nests everything under files/. Flatten it so the paths
  # CLAUDE.md documents resolve: factorioLuaAPI/auxiliary/noise-expressions.html,
  # factorioLuaAPI/runtime-api.json, factorioLuaAPI/types/MapGenSettings.html.
  SRC="$TMP_DIR/extracted/files"
  [ -d "$SRC" ] || SRC="$TMP_DIR/extracted"
  [ -f "$SRC/runtime-api.json" ] ||
    die "archive layout changed - no runtime-api.json at the expected depth"

  echo "$WANT_VERSION" >"$SRC/VERSION"

  # Swap only after a clean extract, so an interrupted run cannot leave a
  # partial mirror that greps as though it were complete.
  rm -rf "$DOCS_DIR.new"
  mv "$SRC" "$DOCS_DIR.new"
  rm -rf "$DOCS_DIR"
  mv "$DOCS_DIR.new" "$DOCS_DIR"

  echo "  lua-api docs   ${DOCS_NOW:-(missing)} -> $WANT_VERSION ($(du -sh "$DOCS_DIR" | cut -f1))"
fi

echo "All Factorio references pinned to $WANT_VERSION."
