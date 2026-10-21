# Menu behaviour and speed, with a fake Firefox: needs no browser.
# Sourced by session.sh.

python3 "$HERE/fake-firefox.py" --windows 3 --tabs 200 2>"$WORK/fake.log" &
FAKE=$!
for _ in $(seq 50); do [ "$(ev 'T.indicator().visible')" = True ] && break; sleep 0.1; done
check "icon shows when Firefox runs" 'T.indicator().visible'
for _ in $(seq 20); do [ "$(ev 'T.indicator()._countLabel.text')" = 600 ] && break; sleep 0.1; done
check "the top bar shows the number of tabs" 'T.indicator()._countLabel.text === "600" && T.indicator()._countLabel.visible'
ev 'T.settings().set_boolean("show-tab-count", false)' >/dev/null; sleep 0.2
check "the count can be hidden" '!T.indicator()._countLabel.visible'
ev 'T.settings().reset("show-tab-count")' >/dev/null; sleep 0.2

ev 'T.timeOpen()' >/dev/null; sleep 1
echo "INFO open with 600 tabs: $(ev 'T.lastOpenMs') ms, $(ev 'T.tabItems().length') rows built"
ev 'T.timeOpen()' >/dev/null; sleep 0.5
echo "INFO reopen, nothing changed: $(ev 'T.lastOpenMs') ms"
check "only the current window's first rows are built" 'T.tabItems().length <= 60'
check "tabs show their favicon file" \
    'T.tabItems().filter(i => i.tab.icon).length > 0 && T.tabItems().filter(i => i.tab.icon).every(i => i.icon.gicon.get_file?.()?.query_exists(null))'
check "tabs without a favicon show the placeholder" \
    'T.tabItems().filter(i => !i.tab.icon).every(i => i.icon.gicon === T.indicator()._icons.page)'
shot menu

ev 'globalThis._rows = T.visibleTabItems().length; T.click(T.headers()[0])' >/dev/null; sleep 0.4
check "clicking a window header expands it and keeps the menu open" \
    'T.indicator().menu.isOpen && T.visibleTabItems().length > _rows'

ev 'globalThis._tab = T.visibleTabItems()[0].tab.id; T.click(T.visibleTabItems()[0], 2)' >/dev/null; sleep 0.4
check "middle-click closes the tab and keeps the menu open" \
    'T.indicator().menu.isOpen && !T.tabItems().some(i => i.tab.id === _tab)'
sleep 0.3
check "the count follows closed tabs" 'T.indicator()._countLabel.text === "599"'

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

# Search
ev 'T.pointerAway(); T.indicator().menu.open()' >/dev/null; sleep 0.6
check "the search box has focus when the menu opens" 'T.indicator()._entry.clutter_text.has_key_focus()'
ev 'T.type("tab 42")' >/dev/null; sleep 0.4
check "typing filters to tabs matching every word" \
    'T.indicator()._entry.text === "tab 42" && !T.indicator()._treeSection.actor.visible && T.resultItems().length > 0 &&
     T.resultItems().every(i => /tab/i.test(i.tab.title) && i.tab.title.includes("42"))'
shot search
ev 'const e = T.indicator()._entry; const t0 = GLib.get_monotonic_time(); e.text = "1"; globalThis._ms = (GLib.get_monotonic_time() - t0) / 1000' >/dev/null
echo "INFO search for \"1\" over 600 tabs, results shown: $(ev '_ms.toFixed(1)') ms"
ev 'T.indicator()._entry.text = "SÉTTINGS"' >/dev/null; sleep 0.2
check "search ignores case and accents" 'T.resultItems().length > 0 && T.resultItems().every(i => i.tab.title === "Settings")'
ev 'T.indicator()._entry.text = "site3.example"' >/dev/null; sleep 0.2
check "search matches URLs" 'T.resultItems().length > 0 && T.resultItems().every(i => i.tab.url.includes("site3.example"))'
ev 'T.indicator()._entry.text = "zzzz"' >/dev/null; sleep 0.2
check "no match says so" 'T.resultItems().length === 0 && T.indicator()._resultsSection.box.get_first_child()?.label?.text === "No matching tabs"'

ev 'T.indicator()._entry.text = "tab 40"' >/dev/null; sleep 0.3
ev 'globalThis._tab = T.resultItems().find(r => T.tabItems().filter(i => i.tab.id === r.tab.id).length === 2).tab.id; T.click(T.resultItems().find(r => r.tab.id === _tab), 2)' >/dev/null; sleep 0.4
check "closing a tab from the results also removes it from the tree" '!T.tabItems().some(i => i.tab.id === _tab)'

ev 'T.indicator()._entry.grab_key_focus(); T.key(imports.gi.Clutter.KEY_Down)' >/dev/null; sleep 0.3
check "Down moves from the search box to the first result" 'T.focused() === T.resultItems()[0]'
ev 'T.type("1")' >/dev/null; sleep 0.3
check "typing on a row goes back to the search box" \
    'T.indicator()._entry.clutter_text.has_key_focus() && T.indicator()._entry.text === "tab 401"'
ev 'globalThis._tab = T.resultItems()[0].tab.id; T.key(imports.gi.Clutter.KEY_Return)' >/dev/null; sleep 0.4
check "Enter switches to the first result and closes the menu" '!T.indicator().menu.isOpen'
grep -q "\"tabId\": $(ev '_tab')}" "$WORK/fake.log" && echo "PASS Firefox got the first result's tab" || echo "FAIL Firefox got the first result's tab"

ev 'T.pointerAway(); T.indicator().menu.open()' >/dev/null; sleep 0.6
check "reopening starts with an empty search and the tree" \
    'T.indicator()._entry.text === "" && T.indicator()._treeSection.actor.visible && !T.indicator()._resultsSection.actor.visible'
ev 'T.tabItems()[0].grab_key_focus(); T.key(imports.gi.Clutter.KEY_Left)' >/dev/null; sleep 0.4
check "Left on a row still moves to the neighbouring panel menu" \
    '!T.indicator().menu.isOpen && Main.panel.menuManager.activeMenu !== null'
ev 'Main.panel.menuManager.activeMenu?.close()' >/dev/null

[ "$(grep -c '"op": "close"' "$WORK/fake.log")" -ge 2 ] && echo "PASS Firefox got the close commands" || echo "FAIL Firefox got the close commands"
grep -q '"op": "activate"' "$WORK/fake.log" && echo "PASS Firefox got the activate command" || echo "FAIL Firefox got the activate command"

kill $FAKE; sleep 0.5
check "icon hides when Firefox quits" '!T.indicator().visible'
