#!/usr/bin/env bash
#
# claudee installer — symlinks bin/claudee into your PATH.
#
#   ./install.sh                 # installs to ~/.local/bin
#   PREFIX=/usr/local ./install.sh   # installs to /usr/local/bin
#
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/bin/claudee"
BIN_DIR="${PREFIX:-$HOME/.local}/bin"

mkdir -p "$BIN_DIR"
chmod +x "$SRC"
ln -sf "$SRC" "$BIN_DIR/claudee"

echo "✓ installed: $BIN_DIR/claudee -> $SRC"

# Warn if a shell alias would shadow the executable.
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
  if [ -f "$rc" ] && grep -qE '^[[:space:]]*alias[[:space:]]+claudee=' "$rc"; then
    echo "⚠ found 'alias claudee=' in $rc — remove it so this script takes precedence."
  fi
done

# Warn if the bin dir is not on PATH.
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) echo "⚠ $BIN_DIR is not on your PATH. Add: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

echo "Run 'claudee' to start, or 'claudee <args>' to pass straight through to claude."
