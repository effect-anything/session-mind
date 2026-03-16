#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_DIR="$REPO_ROOT/.repo"

print_usage() {
  cat <<'EOF'
Usage: .repo/clone-reference-repos.sh [--pull] [--depth N] [--full]

Clones a set of reference repositories into .repo/.
- Existing repos: always fetch; optionally pull (ff-only).
- Default clone mode: --depth 1.

Examples:
  .repo/clone-reference-repos.sh
  .repo/clone-reference-repos.sh --pull
  .repo/clone-reference-repos.sh --full
  .repo/clone-reference-repos.sh --depth 50
EOF
}

pull_after_fetch=0
depth=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      print_usage
      exit 0
      ;;
    --pull)
      pull_after_fetch=1
      shift
      ;;
    --full)
      depth=0
      shift
      ;;
    --depth)
      depth="${2:-}"
      if [[ -z "$depth" ]]; then
        echo "--depth requires a value" >&2
        exit 2
      fi
      if ! [[ "$depth" =~ ^[0-9]+$ ]]; then
        echo "--depth must be an integer" >&2
        exit 2
      fi
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      print_usage >&2
      exit 2
      ;;
  esac
done

mkdir -p "$TARGET_DIR"

clone_or_update() {
  local url="$1"
  local name="$2"
  local dest="$TARGET_DIR/$name"

  if [[ -d "$dest/.git" ]]; then
    echo "==> Updating $name"
    git -C "$dest" remote set-url origin "$url" >/dev/null 2>&1 || true
    git -C "$dest" fetch --prune

    if [[ "$pull_after_fetch" -eq 1 ]]; then
      if ! git -C "$dest" pull --ff-only; then
        echo "   (pull skipped: not on a branch with upstream)" >&2
      fi
    fi
    return 0
  fi

  if [[ -e "$dest" ]]; then
    echo "==> Skipping $name (path exists but is not a git repo): $dest" >&2
    return 0
  fi

  echo "==> Cloning $name"
  if [[ "$depth" -gt 0 ]]; then
    git clone --depth "$depth" "$url" "$dest"
  else
    git clone "$url" "$dest"
  fi
}

# Add/adjust reference repos here.
clone_or_update "https://github.com/Effect-TS/effect-smol" "effect-smol"
clone_or_update "https://github.com/tim-smart/lalph" "lalph"

echo "Done. Repositories are under: $TARGET_DIR"
