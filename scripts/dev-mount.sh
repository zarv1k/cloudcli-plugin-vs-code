#!/usr/bin/env bash
#
# Expose this working copy to CloudCLI as an installed plugin.
#
# A symlink does NOT work: CloudCLI's plugin scanner uses Dirent.isDirectory(),
# which is false for a symlink, so the directory is silently skipped. A bind
# mount looks like a real directory to both the scanner and the realpath
# containment check on the asset route.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGINS_DIR="${PLUGINS_DIR:-$HOME/.claude-code-ui/plugins}"
TARGET="$PLUGINS_DIR/$(basename "$REPO_DIR")"

usage() {
  cat <<EOF
Usage: $0 [--umount] [--persist]

  (no args)   Bind-mount $REPO_DIR onto $TARGET
  --umount    Undo the bind mount and remove the empty mount point
  --persist   Also add an /etc/fstab entry so the mount survives a reboot

Afterwards, restart CloudCLI so it rescans the plugins directory, e.g.:
  sudo systemctl restart cloudcli   # or however you run CloudCLI
EOF
}

FSTAB_LINE="$REPO_DIR $TARGET none bind 0 0"

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --umount)
    if mountpoint -q "$TARGET"; then
      sudo umount "$TARGET"
      echo "unmounted $TARGET"
    else
      echo "$TARGET is not a mount point"
    fi
    if [ -d "$TARGET" ] && [ -z "$(ls -A "$TARGET")" ]; then
      rmdir "$TARGET"
      echo "removed empty $TARGET"
    fi
    if grep -qF "$FSTAB_LINE" /etc/fstab 2>/dev/null; then
      echo "note: an /etc/fstab entry still exists — remove it by hand:"
      echo "  $FSTAB_LINE"
    fi
    exit 0
    ;;
  --persist) PERSIST=1 ;;
  "") PERSIST=0 ;;
  *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
esac

mkdir -p "$TARGET"

if mountpoint -q "$TARGET"; then
  echo "already mounted: $TARGET"
else
  sudo mount --bind "$REPO_DIR" "$TARGET"
  echo "mounted $REPO_DIR -> $TARGET"
fi

if [ "$PERSIST" -eq 1 ]; then
  if grep -qF "$FSTAB_LINE" /etc/fstab 2>/dev/null; then
    echo "/etc/fstab entry already present"
  else
    printf '%s\n' "$FSTAB_LINE" | sudo tee -a /etc/fstab >/dev/null
    echo "added /etc/fstab entry"
  fi
fi

echo
echo "Next:"
echo "  npm install && npm run build"
echo "  restart CloudCLI (e.g. sudo systemctl restart cloudcli)"
