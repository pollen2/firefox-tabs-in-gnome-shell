# Menu behaviour and speed, with a fake Firefox: needs no browser.
# Sourced by session.sh.

python3 "$HERE/fake-firefox.py" --windows 3 --tabs 200 2>"$WORK/fake.log" &
FAKE=$!
for _ in $(seq 50); do [ "$(ev 'T.indicator().visible')" = True ] && break; sleep 0.1; done
check "icon shows when Firefox runs" 'T.indicator().visible'

ev 'T.timeOpen()' >/dev/null; sleep 1
echo "INFO open with 600 tabs: $(ev 'T.lastOpenMs') ms, $(ev 'T.tabItems().length') rows built"
ev 'T.timeOpen()' >/dev/null; sleep 0.5
echo "INFO reopen, nothing changed: $(ev 'T.lastOpenMs') ms"
check "only the current window's first rows are built" 'T.tabItems().length <= 60'
shot menu

ev 'globalThis._rows = T.visibleTabItems().length; T.click(T.headers()[0])' >/dev/null; sleep 0.4
check "clicking a window header expands it and keeps the menu open" \
    'T.indicator().menu.isOpen && T.visibleTabItems().length > _rows'

ev 'globalThis._tab = T.visibleTabItems()[0].tab.id; T.click(T.visibleTabItems()[0], 2)' >/dev/null; sleep 0.4
check "middle-click closes the tab and keeps the menu open" \
    'T.indicator().menu.isOpen && !T.tabItems().some(i => i.tab.id === _tab)'

ev 'const item = T.visibleTabItems()[1]; globalThis._tab = item.tab.id; T.clickCloseIcon(item)' >/dev/null; sleep 0.4
check "the close icon closes the tab and keeps the menu open" \
    'T.indicator().menu.isOpen && !T.tabItems().some(i => i.tab.id === _tab)'

ev 'T.scrollToEnd()' >/dev/null; sleep 0.3
ev 'globalThis._rows = T.tabItems().length; T.click(T.moreItems().at(-1))' >/dev/null; sleep 0.4
check "Show more adds rows and keeps the menu open" \
    'T.indicator().menu.isOpen && T.tabItems().length > _rows'

ev 'T.scrollToStart()' >/dev/null; sleep 0.3
ev 'T.click(T.visibleTabItems()[2])' >/dev/null; sleep 0.4
check "clicking a tab closes the menu" '!T.indicator().menu.isOpen'

[ "$(grep -c '"op": "close"' "$WORK/fake.log")" = 2 ] && echo "PASS Firefox got both close commands" || echo "FAIL Firefox got both close commands"
grep -q '"op": "activate"' "$WORK/fake.log" && echo "PASS Firefox got the activate command" || echo "FAIL Firefox got the activate command"

kill $FAKE; sleep 0.5
check "icon hides when Firefox quits" '!T.indicator().visible'
