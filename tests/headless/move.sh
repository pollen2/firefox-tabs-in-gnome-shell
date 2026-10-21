# Moving tabs through the action view with a real Firefox, checking what
# Firefox actually did. Offline pages only. Sourced by session.sh.

source "$HERE/firefox.sh"
start_firefox about:robots about:mozilla about:license about:rights about:buildconfig || return
read -r ROBOTS MOZILLA LICENSE RIGHTS BUILDCONFIG _ <<< "$($CTL ids)"
check "Firefox instance found" '!!T.instance()'

# act TAB 'JS expression for the action label' — through the menu, as a user would.
act() {
    ev 'T.pointerAway(); T.indicator().menu.open()' >/dev/null; sleep 0.6
    ev "T.searchFor(T.tab($1).title)" >/dev/null; sleep 0.3
    ev "T.rightClickResult($1)" >/dev/null; sleep 0.4
    ev "T.click(T.action($2))" >/dev/null; sleep 1.5
}
expect_tab() {  # tab, expected "window N of M, group G|none" (G may be a pattern), description
    local got
    got=$($CTL tab "$1")
    case "$got" in $2) echo "PASS $3";; *) echo "FAIL $3: tab is in $got";; esac
}

act "$BUILDCONFIG" '"Move to new window"'
expect_tab "$BUILDCONFIG" "window 2 of 2, group none" "Move to new window"

act "$RIGHTS" "T.otherWindowTitle($RIGHTS)"
expect_tab "$RIGHTS" "window 2 of 2, group none" "Move to window"

act "$LICENSE" '"New group"'
expect_tab "$LICENSE" "window 1 of 2, group [0-9]*" "New group"
GROUP=$($CTL tab "$LICENSE" | sed 's/.*group //')

act "$MOZILLA" '"Unnamed group"'
expect_tab "$MOZILLA" "window 1 of 2, group $GROUP" "Add to a group in the same window"

act "$RIGHTS" '"Unnamed group"'
expect_tab "$RIGHTS" "window 1 of 2, group $GROUP" "Add to a group in another window brings the tab over"

act "$LICENSE" '"Remove from group"'
expect_tab "$LICENSE" "* group none" "Remove from group"

# Drag and drop. Now: window 1 = Gort, Licenses, group [Mozilla, Rights];
# window 2 = Build Configuration.
order() {  # tab ids per window, "[g]" after grouped ones
    $CTL order | sed 's/^window [0-9]*: //; s/\[g[0-9]*\]/[g]/g' | tr '\n' '|'
}
expect_order() {  # expected, description
    local got
    got=$(order)
    [ "$got" = "$1" ] && echo "PASS $2" || echo "FAIL $2: order is $got, expected $1"
}
expand_all='T.headers().filter(h => h._arrow.icon_name === "pan-end-symbolic").forEach(h => h.activate(null))'
dnd() {  # SOURCE TARGET_ROW_JS WHERE
    ev 'T.pointerAway(); T.indicator().menu.open()' >/dev/null; sleep 0.6
    ev "$expand_all" >/dev/null; sleep 0.3
    ev "T.press(T.treeRow($1))" >/dev/null; sleep 0.2
    ev "T.moveTo($2, '$3')" >/dev/null; sleep 0.4
    ev 'T.release()' >/dev/null; sleep 1.5
}

dnd "$ROBOTS" "T.treeRow($LICENSE)" after
expect_order "$LICENSE $ROBOTS $MOZILLA[g] $RIGHTS[g]|$BUILDCONFIG|" "drag a tab down, just above a group: it stays out of the group"
shown='T.tabItems().filter(i => T.indicator()._treeSection.actor.contains(i)).map(i => i.tab.id).join()'
[ "$(ev "$shown")" = "$LICENSE,$ROBOTS,$MOZILLA,$RIGHTS,$BUILDCONFIG" ] && [ "$(ev 'T.indicator().menu.isOpen')" = True ] &&
    echo "PASS the open menu redraws in the new order" ||
    echo "FAIL the open menu redraws in the new order: shows $(ev "$shown"), snapshot serial $(ev 'T.instance().serial')"
ev 'T.indicator().menu.close()' >/dev/null

dnd "$LICENSE" "T.treeRow($RIGHTS)" before
expect_order "$ROBOTS $MOZILLA[g] $LICENSE[g] $RIGHTS[g]|$BUILDCONFIG|" "drag a tab between two grouped tabs: it joins the group"
ev 'T.indicator().menu.close()' >/dev/null

dnd "$BUILDCONFIG" "T.treeRow($ROBOTS)" before
expect_order "$BUILDCONFIG $ROBOTS $MOZILLA[g] $LICENSE[g] $RIGHTS[g]|" "drag a tab into another window, before its first tab"

ev 'T.pointerAway(); T.indicator().menu.open()' >/dev/null; sleep 0.6
shot after-moves
ev 'T.indicator().menu.close()' >/dev/null

kill $FF; sleep 1
