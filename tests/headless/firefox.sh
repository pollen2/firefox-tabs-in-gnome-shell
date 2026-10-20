# Starts a throwaway Firefox with the add-on, for scenarios that need the real
# browser. Sourced by them; needs the native host registered
# (scripts/install-dev.sh). FIREFOX selects the browser binary.

FIREFOX=${FIREFOX:-$(command -v firefox-esr || command -v firefox)}
CTL="python3 $HERE/hostctl.py"

# start_firefox URL...: sets FF to its pid and returns once the host is up.
start_firefox() {
    if [ ! -e "$HOME/.mozilla/native-messaging-hosts/io.github.pollen2.firefox_tabs.json" ]; then
        echo "FAIL native host not registered: run scripts/install-dev.sh"
        return 1
    fi
    local profile="$WORK/profile"
    mkdir -p "$profile/extensions"
    python3 -I -c '
import os, sys, zipfile
src, dest = sys.argv[1:]
with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
    for name in os.listdir(src):
        z.write(os.path.join(src, name), name)
' "$ROOT/webext" "$profile/extensions/firefox-tabs@pollen2.github.io.xpi"
    printf 'user_pref("%s", %s);\n' \
        xpinstall.signatures.required false \
        extensions.autoDisableScopes 0 \
        browser.shell.checkDefaultBrowser false \
        browser.startup.homepage_override.mstone '"ignore"' \
        browser.aboutwelcome.enabled false \
        datareporting.policy.dataSubmissionEnabled false \
        toolkit.telemetry.reportingpolicy.firstRun false \
        toolkit.startup.max_resumed_crashes -1 >"$profile/user.js"

    MOZ_ENABLE_WAYLAND=1 "$FIREFOX" --no-remote --profile "$profile" "$@" >"$OUT/$NAME.firefox.log" 2>&1 &
    FF=$!
    for _ in $(seq 60); do [ -n "$($CTL name 2>/dev/null)" ] && break; sleep 0.5; done
    sleep 2
}
