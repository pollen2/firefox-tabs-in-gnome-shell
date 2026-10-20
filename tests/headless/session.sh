#!/bin/bash
# Inside the private D-Bus session: starts the shell, defines the helpers
# scenarios use, then sources the scenario given as $1.

gsettings set org.gnome.shell enabled-extensions "['unsafe-helper@test', 'firefox-tabs@pollen2.github.io']"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'

gnome-shell --headless --wayland --no-x11 --wayland-display="firefox-tabs-test-$$" \
    --virtual-monitor 1280x800 >"$OUT/$NAME.shell.log" 2>&1 &
SHELL_PID=$!
export WAYLAND_DISPLAY="firefox-tabs-test-$$"
# Apps started over D-Bus (the preferences window) need to find the shell,
# as gnome-session would arrange in a real session.
dbus-update-activation-environment WAYLAND_DISPLAY

# Evaluates JS in the shell and prints its result (strings unquoted).
ev() {
    gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell -m org.gnome.Shell.Eval "$1" |
        python3 -c '
import ast, json, sys
out = sys.stdin.read().strip()
ok, value = ast.literal_eval(out.replace("(true,", "(True,", 1).replace("(false,", "(False,", 1))
value = json.loads(value) if ok and value else value
print(value if ok else f"EVAL ERROR: {value}")'
}

# check "description" 'JS boolean expression'
check() {
    if [ "$(ev "!!($2)")" = True ]; then
        echo "PASS $1"
    else
        echo "FAIL $1"
    fi
}

shot() {
    sleep 0.5
    gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell/Screenshot \
        -m org.gnome.Shell.Screenshot.Screenshot false false "$OUT/$NAME-$1.png" >/dev/null
}

for _ in $(seq 100); do
    [ "$(ev 'global.context.unsafe_mode && !Main.layoutManager._startingUp' 2>/dev/null)" = True ] && break
    sleep 0.2
done
ev "Main.overview.hide(); $(cat "$HERE/helpers.js"); 'ready'" >/dev/null
# Without a keyboard device, Wayland clients never get focus events.
ev 'const C = imports.gi.Clutter; globalThis._keyboard = C.get_default_backend().get_default_seat().create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE); 0' >/dev/null

source "$1"

kill $SHELL_PID
wait $SHELL_PID 2>/dev/null
