# Raising the right window with a real Firefox, including windows whose
# titles are identical, and favicons. Needs network access for three pages.
# Sourced by session.sh.

source "$HERE/firefox.sh"
start_firefox about:robots about:mozilla about:robots https://www.debian.org/ about:robots \
    https://github.com/ https://en.wikipedia.org/wiki/GNOME || return
read -r R1 MOZ RA DEB RB _ <<< "$($CTL ids)"
check "Firefox instance found" '!!T.instance()'
check "the top bar uses the installed Firefox's monochrome icon" \
    'T.indicator()._panelIcon.gicon.get_names?.()[0] === "firefox-esr-symbolic"'
shot panel

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
