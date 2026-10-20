#!/bin/bash
# Runs test scenarios against a throwaway headless GNOME Shell on a private
# D-Bus session, with the extension enabled. Your own session, settings and
# Firefox profile are not touched.
#
#   tests/headless/run.sh                       # all scenarios
#   tests/headless/run.sh tests/headless/menu.sh
#
# Screenshots and logs go to tests/headless/out/. Exits non-zero if any
# check fails or the shell logs a JS error.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT="$HERE/out"
mkdir -p "$OUT"

if [ $# -eq 0 ]; then
    set -- "$HERE/menu.sh" "$HERE/raise.sh"
fi

failed=0
for scenario in "$@"; do
    name=$(basename "$scenario" .sh)
    work=$(mktemp -d -t firefox-tabs-test.XXXXXX)
    mkdir -p "$work"/{data/gnome-shell/extensions,config,cache,state,runtime}
    chmod 700 "$work/runtime"
    ln -s "$ROOT/shell-extension/firefox-tabs@pollen2.github.io" "$work/data/gnome-shell/extensions/"
    ln -s "$HERE/unsafe-helper@test" "$work/data/gnome-shell/extensions/"

    echo "== $name"
    XDG_DATA_HOME="$work/data" XDG_CONFIG_HOME="$work/config" \
    XDG_CACHE_HOME="$work/cache" XDG_STATE_HOME="$work/state" XDG_RUNTIME_DIR="$work/runtime" \
    ROOT="$ROOT" HERE="$HERE" OUT="$OUT" WORK="$work" NAME="$name" \
        dbus-run-session -- "$HERE/session.sh" "$(realpath "$scenario")" 2>"$OUT/$name.session.log" |
        grep --line-buffered -E '^(PASS|FAIL|INFO)' | tee "$work/results"

    if grep -q '^FAIL' "$work/results"; then
        failed=1
    fi
    if grep -qE 'JS ERROR|Gjs-CRITICAL|JS WARNING' "$OUT/$name.shell.log"; then
        echo "FAIL shell logged JS errors, see $OUT/$name.shell.log"
        failed=1
    fi
    rm -rf "$work"
done
exit $failed
