#!/bin/sh
# Development install for the current user: builds the host, registers it with
# Firefox, and links the shell extension so edits apply on the next shell start.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=firefox-tabs@pollen2.github.io
HOST_NAME=io.github.pollen2.firefox_tabs

cargo build --release --manifest-path "$ROOT/host/Cargo.toml"

MANIFEST_DIR="$HOME/.mozilla/native-messaging-hosts"
mkdir -p "$MANIFEST_DIR"
sed "s|@HOST_PATH@|$ROOT/host/target/release/firefox-tabs-host|" \
    "$ROOT/packaging/$HOST_NAME.json.in" > "$MANIFEST_DIR/$HOST_NAME.json"
echo "Native host registered: $MANIFEST_DIR/$HOST_NAME.json"

glib-compile-schemas --strict "$ROOT/shell-extension/$UUID/schemas"

EXT_DIR="$HOME/.local/share/gnome-shell/extensions"
mkdir -p "$EXT_DIR"
ln -sfn "$ROOT/shell-extension/$UUID" "$EXT_DIR/$UUID"
echo "Shell extension linked: $EXT_DIR/$UUID"

cat <<EOF

Next steps:
  1. Firefox: about:debugging > This Firefox > Load Temporary Add-on > $ROOT/webext/manifest.json
  2. GNOME (Wayland): log out and back in, then: gnome-extensions enable $UUID
     To try changes without logging out: tests/headless/run.sh
EOF
