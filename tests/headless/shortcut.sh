# The keyboard shortcut and its preferences page, with a fake Firefox.
# Sourced by session.sh.

python3 "$HERE/fake-firefox.py" --windows 1 --tabs 20 2>"$WORK/fake.log" &
FAKE=$!
for _ in $(seq 50); do [ "$(ev 'T.indicator().visible')" = True ] && break; sleep 0.1; done
K='imports.gi.Clutter'

check "no shortcut is set by default" 'T.settings().get_strv("toggle-menu").length === 0'

ev 'T.settings().set_strv("toggle-menu", ["<Super>y"])' >/dev/null; sleep 0.3
ev "T.pointerAway(); T.combo($K.KEY_Super_L, $K.KEY_y)" >/dev/null; sleep 0.5
check "the shortcut opens the menu" 'T.indicator().menu.isOpen'
check "the search box has focus" 'T.indicator()._entry.clutter_text.has_key_focus()'
ev "T.combo($K.KEY_Super_L, $K.KEY_y)" >/dev/null; sleep 0.5
check "pressing it again closes the menu" '!T.indicator().menu.isOpen'

ev 'T.settings().set_strv("toggle-menu", ["<Control><Alt>j"])' >/dev/null; sleep 0.3
ev "T.combo($K.KEY_Super_L, $K.KEY_y)" >/dev/null; sleep 0.5
check "the old shortcut stops working once changed" '!T.indicator().menu.isOpen'
ev "T.combo($K.KEY_Control_L, $K.KEY_Alt_L, $K.KEY_j)" >/dev/null; sleep 0.5
check "the new shortcut works without restarting" 'T.indicator().menu.isOpen'
ev 'T.indicator().menu.close()' >/dev/null

ev 'Main.extensionManager.disableExtension("firefox-tabs@pollen2.github.io")' >/dev/null; sleep 0.5
ev "T.combo($K.KEY_Control_L, $K.KEY_Alt_L, $K.KEY_j)" >/dev/null; sleep 0.5
check "disabling the extension removes the shortcut" '!Main.panel.statusArea["firefox-tabs@pollen2.github.io"]'
ev 'Main.extensionManager.enableExtension("firefox-tabs@pollen2.github.io")' >/dev/null; sleep 1
ev "T.combo($K.KEY_Control_L, $K.KEY_Alt_L, $K.KEY_j)" >/dev/null; sleep 0.5
check "it works again after re-enabling" 'T.indicator().menu.isOpen'
ev 'T.indicator().menu.close()' >/dev/null

ev 'T.settings().set_strv("toggle-menu", [])' >/dev/null; sleep 0.3
ev "T.combo($K.KEY_Control_L, $K.KEY_Alt_L, $K.KEY_j)" >/dev/null; sleep 0.5
check "clearing the shortcut disables it" '!T.indicator().menu.isOpen'

# Preferences window, driven from the keyboard like a user would.
gnome-extensions prefs firefox-tabs@pollen2.github.io
for _ in $(seq 50); do
    [ "$(ev 'global.display.get_tab_list(0, null).some(w => w.get_title() === "Firefox tabs in top bar")')" = True ] && break
    sleep 0.2
done
sleep 1
check "the preferences window opens" 'global.display.focus_window?.get_title() === "Firefox tabs in top bar"'
shot prefs
# Tab goes to the tab count row, then its switch, then the shortcut row.
for _ in 1 2 3; do ev "T.key($K.KEY_Tab)" >/dev/null; sleep 0.3; done
ev "T.key($K.KEY_Return)" >/dev/null; sleep 0.8
shot prefs-capture
ev "T.combo($K.KEY_Control_L, $K.KEY_Alt_L, $K.KEY_k)" >/dev/null; sleep 0.8
check "a shortcut pressed in the dialog is saved" 'T.settings().get_strv("toggle-menu")[0] === "<Control><Alt>k"'
shot prefs-set
ev "T.combo($K.KEY_Control_L, $K.KEY_Alt_L, $K.KEY_k)" >/dev/null; sleep 0.5
check "and works right away" 'T.indicator().menu.isOpen'
ev 'T.indicator().menu.close(); global.display.get_tab_list(0, null).find(w => w.get_title() === "Firefox tabs in top bar")?.delete(global.get_current_time())' >/dev/null

kill $FAKE
