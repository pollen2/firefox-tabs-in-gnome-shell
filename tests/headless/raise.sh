# Raising the right window with a real Firefox, including windows whose
# titles are identical. Needs the native host registered
# (scripts/install-dev.sh) and network access for one page.
# Sourced by session.sh. FIREFOX selects the browser binary.

FIREFOX=${FIREFOX:-$(command -v firefox-esr || command -v firefox)}
CTL="python3 $HERE/hostctl.py"
if [ ! -e "$HOME/.mozilla/native-messaging-hosts/io.github.pollen2.firefox_tabs.json" ]; then
    echo "FAIL native host not registered: run scripts/install-dev.sh"
    return
fi

profile="$WORK/profile"
mkdir -p "$profile/extensions"
python3 -I - "$ROOT/webext" "$profile/extensions/firefox-tabs@pollen2.github.io.xpi" <<'EOF'
import os, sys, zipfile
src, dest = sys.argv[1:]
with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED) as z:
    for name in os.listdir(src):
        z.write(os.path.join(src, name), name)
EOF
cat > "$profile/user.js" <<'EOF'
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.aboutwelcome.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("toolkit.startup.max_resumed_crashes", -1);
EOF

MOZ_ENABLE_WAYLAND=1 "$FIREFOX" --no-remote --profile "$profile" \
    about:robots about:mozilla about:robots https://www.debian.org/ about:robots \
    https://github.com/ https://en.wikipedia.org/wiki/GNOME >"$OUT/$NAME.firefox.log" 2>&1 &
FF=$!
for _ in $(seq 60); do [ -n "$($CTL name 2>/dev/null)" ] && break; sleep 0.5; done
sleep 2
read -r R1 MOZ RA DEB RB _ <<< "$($CTL ids)"
check "Firefox instance found" '!!T.instance()'

$CTL group "$MOZ,$DEB" >/dev/null
$CTL new-window "$RA"; sleep 1.5
$CTL new-window "$RB"; sleep 2
$CTL snapshot | grep -q "^groups \[{" && echo "PASS the snapshot includes the new tab group" || echo "FAIL the snapshot includes the new tab group"
echo "INFO window titles: $(ev 'global.display.get_tab_list(0, null).map(w => w.get_title()).join(" | ")')"

# Opens the menu (fresh snapshot), activates a tab as a click would, then
# checks which window got focus.
activate() {
    ev 'T.indicator().menu.open()' >/dev/null; sleep 0.4
    ev "T.indicator().menu.close(); T.indicator()._activateTab(T.instance(), {id: $1})" >/dev/null; sleep 1.5
    local result
    result=$(ev "T.focusCheck($1)")
    [ "$result" = ok ] && echo "PASS $2" || echo "FAIL $2: $result"
}
activate "$MOZ" "3 windows titled alike: tab in the oldest window"
activate "$RA" "2 windows titled alike: the middle one"
activate "$RB" "2 windows titled alike: the newest one"
activate "$RA" "back to the middle one"
activate "$DEB" "tab in a group"
activate "$R1" "tab titled like the other windows, in the first window"
activate "$RB" "newest window again"

icons=$($CTL icons)
echo "$icons" | sed 's/^/INFO favicon: /'
echo "$icons" | grep -q 'debian.org.* 32x32$' && echo "PASS a web page's favicon is stored as a 32x32 PNG" || echo "FAIL a web page's favicon is stored as a 32x32 PNG"
echo "$icons" | grep -q 'github.com.* 32x32$' && echo "PASS an SVG favicon is stored as a 32x32 PNG" || echo "FAIL an SVG favicon is stored as a 32x32 PNG"
echo "INFO favicon files: $(ls "$XDG_RUNTIME_DIR/firefox-tabs/icons" | wc -l), sizes in bytes: $(stat -c %s "$XDG_RUNTIME_DIR"/firefox-tabs/icons/*.png | tr '\n' ' ')"
echo "$icons" | grep -q 'about:robots none$' && echo "PASS Firefox's own pages have no favicon file" || echo "FAIL Firefox's own pages have no favicon file"

ev 'T.indicator().menu.open()' >/dev/null; sleep 0.6
check "the group shows in the menu" 'T.headers().length > 0'
check "Firefox's own pages show Firefox's icon" \
    'T.tabItems().filter(i => i.tab.url.startsWith("about:")).length > 0 && T.tabItems().filter(i => i.tab.url.startsWith("about:")).every(i => i.icon.gicon && i.icon.gicon !== T.indicator()._icons.page)'
# Expand every window for the screenshot.
ev 'T.headers().filter(h => h._arrow.icon_name === "pan-end-symbolic").forEach(h => h.activate(null))' >/dev/null
shot menu

kill $FF; sleep 2
check "icon hides when Firefox quits" '!T.indicator().visible'
