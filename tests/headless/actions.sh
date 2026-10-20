# A tab's action view (right-click / Menu key), with a fake Firefox.
# Sourced by session.sh.

python3 "$HERE/fake-firefox.py" --windows 2 --tabs 12 2>"$WORK/fake.log" &
FAKE=$!
for _ in $(seq 50); do [ "$(ev 'T.indicator().visible')" = True ] && break; sleep 0.1; done
K='imports.gi.Clutter'
# Fake layout: window 1 has tabs 1-12, window 2 tabs 13-24. Tabs 1-2 and
# 13-14 are pinned; tabs 7-10 are in group 1000, 19-22 in group 2000.

open_actions_for() {  # tab id
    ev 'T.pointerAway(); T.indicator().menu.open()' >/dev/null; sleep 0.5
    ev "T.searchFor('Tab $1 ')" >/dev/null; sleep 0.2
    ev "T.click(T.resultItems().find(i => i.tab.id === $1), 3)" >/dev/null; sleep 0.4
}

last_command() {
    grep '^command:' "$WORK/fake.log" | tail -1 | sed 's/^command: //'
}

open_actions_for 8
check "right-click shows the tab's actions instead of the list" \
    'T.indicator()._actionsSection.actor.visible && !T.indicator()._searchBox.visible && !T.indicator()._resultsSection.actor.visible'
check "the view starts with the tab" 'T.actionItems()[0].label.text === "Tab 8 — window 1"'
echo "INFO actions for a grouped tab: $(ev 'T.actionItems().map(a => a.label.text).join(" | ")')"
shot actions
check "a grouped tab can leave its group, join the other one or a new one" \
    '!!T.action("Remove from group") && !!T.action("New group") && !!T.action("Group 2000") && !T.action("Group 1000")'
check "the other window is offered" '!!T.action("Tab 24 — window 2")'

ev 'T.click(T.actionItems()[0])' >/dev/null; sleep 0.3
check "Back returns to the search results" \
    '!T.indicator()._actionsSection.actor.visible && T.indicator()._resultsSection.actor.visible && T.indicator()._searchBox.visible'
check "and refocuses the tab's row" 'T.focused()?.tab?.id === 8'

ev "T.key($K.KEY_Menu)" >/dev/null; sleep 0.3
check "the Menu key shows the actions, focused on the tab at the top" \
    'T.indicator()._actionsSection.actor.visible && T.focused() === T.actionItems()[0]'
ev "T.type('x')" >/dev/null; sleep 0.2
check "typing there doesn't jump to the search box" \
    'T.indicator()._actionsSection.actor.visible && T.indicator()._entry.text === "Tab 8 "'
ev "T.key($K.KEY_Left)" >/dev/null; sleep 0.3
check "Left goes back" '!T.indicator()._actionsSection.actor.visible && T.focused()?.tab?.id === 8'
ev "T.combo($K.KEY_Shift_L, $K.KEY_F10)" >/dev/null; sleep 0.3
check "Shift+F10 shows the actions" 'T.indicator()._actionsSection.actor.visible'

ev 'T.click(T.action("Tab 24 — window 2"))' >/dev/null; sleep 0.4
check "choosing an action closes the menu" '!T.indicator().menu.isOpen'
[ "$(last_command)" = '{"args": {"index": -1, "tabIds": [8], "windowId": 2}, "id": 1, "op": "move", "type": "command"}' ] &&
    echo "PASS Move to window moves the tab to the end of that window" ||
    echo "FAIL Move to window moves the tab to the end of that window: $(last_command)"

open_actions_for 8
ev 'T.click(T.action("Group 2000"))' >/dev/null; sleep 0.4
last_command | grep -q '"groupId": 2000, "tabIds": \[8\]' && last_command | grep -q '"op": "group"' &&
    echo "PASS joining a group sends that group" || echo "FAIL joining a group sends that group: $(last_command)"

open_actions_for 8
ev 'T.click(T.action("New group"))' >/dev/null; sleep 0.4
last_command | grep -q '"groupId": -1, "tabIds": \[8\], "windowId": 1}' &&
    echo "PASS New group creates one in the tab's window" || echo "FAIL New group creates one in the tab's window: $(last_command)"

open_actions_for 8
ev 'T.click(T.action("Remove from group"))' >/dev/null; sleep 0.4
last_command | grep -q '"op": "ungroup"' && echo "PASS Remove from group ungroups" || echo "FAIL Remove from group ungroups: $(last_command)"

open_actions_for 8
ev 'T.click(T.action("Move to new window"))' >/dev/null; sleep 0.4
last_command | grep -q '"args": {"tabId": 8}, .*"op": "newWindow"' && echo "PASS Move to new window" || echo "FAIL Move to new window: $(last_command)"

open_actions_for 5
check "an ungrouped tab isn't offered Remove from group" '!T.action("Remove from group") && !!T.action("Group 1000")'
ev 'T.click(T.action("Close tab"))' >/dev/null; sleep 0.4
last_command | grep -q '"args": {"tabIds": \[5\]}, .*"op": "close"' && echo "PASS Close tab" || echo "FAIL Close tab: $(last_command)"

open_actions_for 1
check "a pinned tab has no group actions" '!T.action("New group") && !!T.action("Close tab")'
ev 'T.indicator().menu.close()' >/dev/null; sleep 0.3
ev 'T.indicator().menu.open()' >/dev/null; sleep 0.5
check "reopening the menu shows the list again" \
    '!T.indicator()._actionsSection.actor.visible && T.indicator()._searchBox.visible && T.indicator()._treeSection.actor.visible'
ev 'T.indicator().menu.close()' >/dev/null

ev 'T.indicator()._run(T.instance().moveTabs([3], 424242))' >/dev/null; sleep 0.6
check "a failed action is shown as a notification" \
    'Main.messageTray.getSources().some(s => s.notifications.some(n => n.body?.includes("Invalid window ID")))'

kill $FAKE
