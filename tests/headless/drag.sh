# Reordering tabs by drag and drop, with a fake Firefox: which commands a
# drop sends. Sourced by session.sh.

python3 "$HERE/fake-firefox.py" --windows 2 --tabs 12 2>"$WORK/fake.log" &
FAKE=$!
for _ in $(seq 50); do [ "$(ev 'T.indicator().visible')" = True ] && break; sleep 0.1; done
K='imports.gi.Clutter'
# Fake layout: window 2 (expanded: used last) has tabs 13-24 at indexes 0-11.
# 13-14 are pinned, 15 is about:preferences, 19-22 are in group 2000.

commands() { grep -c '^command:' "$WORK/fake.log"; }
last_commands() {  # N
    grep '^command:' "$WORK/fake.log" | tail -"$1" | sed 's/^command: //; s/, "id": [0-9]*//; s/, "type": "command"//'
}
open_menu() {
    ev 'T.pointerAway(); T.indicator().menu.open()' >/dev/null; sleep 0.6
}
# drop SOURCE_TAB 'JS for the target row' WHERE
drop() {
    open_menu
    ev "T.press(T.treeRow($1))" >/dev/null; sleep 0.2
    ev "T.moveTo($2, '$3')" >/dev/null; sleep 0.4
    ev 'T.release()' >/dev/null; sleep 0.4
}

open_menu
ev "T.press(T.treeRow(16))" >/dev/null; sleep 0.2
ev "T.moveTo(T.treeRow(18), 'after')" >/dev/null; sleep 0.4
check "dragging shows where the tab will land" \
    'T.treeRow(18).has_style_class_name("ff-drop-after") && T.indicator()._drag._marker.visible && T.treeRow(16).opacity < 255'
shot dragging
ev 'T.release()' >/dev/null; sleep 0.4
check "dropping keeps the menu open and clears the marks" \
    'T.indicator().menu.isOpen && !T.treeRow(18).has_style_class_name("ff-drop-after") && T.treeRow(16).opacity === 255'
[ "$(last_commands 2 | tr '\n' ' ')" = '{"args": {"index": 5, "tabIds": [16], "windowId": 2}, "op": "move"} {"args": {"tabIds": [16]}, "op": "ungroup"} ' ] &&
    echo "PASS a drop just above a group lands outside it" || echo "FAIL a drop just above a group lands outside it: $(last_commands 2)"

drop 17 'T.treeRow(20)' before
[ "$(last_commands 1)" = '{"args": {"index": 6, "tabIds": [17], "windowId": 2}, "op": "move"}' ] &&
    echo "PASS a drop between grouped tabs moves the tab into the group" || echo "FAIL a drop between grouped tabs moves the tab into the group: $(last_commands 1)"

# Lands right after tab 22, which is grouped: Firefox would pull it in.
drop 24 'T.treeRow(23)' before
[ "$(last_commands 2 | tr '\n' ' ')" = '{"args": {"index": 10, "tabIds": [24], "windowId": 2}, "op": "move"} {"args": {"tabIds": [24]}, "op": "ungroup"} ' ] &&
    echo "PASS a drop just below a group lands outside it" || echo "FAIL a drop just below a group lands outside it: $(last_commands 2)"

drop 23 'T.headerRow("Group 2000")' into
last_commands 1 | grep -q '"groupId": 2000, "tabIds": \[23\]' && last_commands 1 | grep -q '"op": "group"' &&
    echo "PASS dropping on a group header adds the tab to the group" || echo "FAIL dropping on a group header adds the tab to the group: $(last_commands 1)"

drop 24 'T.headers().find(h => h.dropTarget.kind === "window" && h.dropTarget.windowId === 1)' into
[ "$(last_commands 1)" = '{"args": {"index": -1, "tabIds": [24], "windowId": 1}, "op": "move"}' ] &&
    echo "PASS dropping on another window's header moves the tab to its end" || echo "FAIL dropping on another window's header moves the tab to its end: $(last_commands 1)"

drop 13 'T.headerRow("Group 2000")' into
before=$(commands)
check "a pinned tab can't be dropped into a group" '!T.headerRow("Group 2000").has_style_class_name("ff-drop-into")'

before=$(commands)
drop 16 'T.treeRow(16)' after
drop 16 'T.treeRow(17)' before
[ "$(commands)" = "$before" ] && echo "PASS dropping a tab where it already is does nothing" || echo "FAIL dropping a tab where it already is does nothing: $(last_commands 1)"

open_menu
before=$(commands)
ev "T.press(T.treeRow(16))" >/dev/null; sleep 0.2
ev "T.moveTo(null, 'into', [200, 400])" >/dev/null; sleep 0.3
ev 'T.release()' >/dev/null; sleep 0.4
check "releasing outside the menu cancels and keeps it open" 'T.indicator().menu.isOpen && T.treeRow(16).opacity === 255'
[ "$(commands)" = "$before" ] && echo "PASS no move is sent for a cancelled drag" || echo "FAIL no move is sent for a cancelled drag"

ev "T.press(T.treeRow(16))" >/dev/null; sleep 0.2
ev "T.moveTo(T.treeRow(18), 'after')" >/dev/null; sleep 0.3
ev "T.key($K.KEY_Escape)" >/dev/null; sleep 0.3
check "Escape cancels the drag, not the menu" 'T.indicator().menu.isOpen && T.treeRow(16).opacity === 255'
ev 'T.release()' >/dev/null; sleep 0.3
[ "$(commands)" = "$before" ] && echo "PASS no move is sent after Escape" || echo "FAIL no move is sent after Escape"

ev 'T.click(T.treeRow(16))' >/dev/null; sleep 0.4
check "a plain click still switches to the tab" '!T.indicator().menu.isOpen'

kill $FAKE
