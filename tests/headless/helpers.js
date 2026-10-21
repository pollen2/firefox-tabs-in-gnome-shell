// Evaluated once inside the test shell; scenarios reach it as `T`.
(() => {
    const Clutter = imports.gi.Clutter;
    const GLib = imports.gi.GLib;
    const seat = Clutter.get_default_backend().get_default_seat();
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);

    const indicator = () => Main.panel.statusArea['firefox-tabs@pollen2.github.io'];
    const find = pred => {
        const out = [];
        const walk = actor => {
            if (pred(actor))
                out.push(actor);
            actor.get_children().forEach(walk);
        };
        walk(indicator()._listSection.actor);
        return out;
    };
    const isA = name => actor => actor.constructor.name.includes(name);

    const clickAt = (x, y, button) => {
        const t = GLib.get_monotonic_time();
        pointer.notify_absolute_motion(t, x, y);
        pointer.notify_button(t + 1000, button, Clutter.ButtonState.PRESSED);
        pointer.notify_button(t + 2000, button, Clutter.ButtonState.RELEASED);
    };

    globalThis.T = {
        indicator,
        instance: () => [...indicator()._watcher.instances.values()][0],
        tabItems: () => find(isA('TabItem')),
        visibleTabItems: () => find(a => isA('TabItem')(a) && a.is_mapped()),
        headers: () => find(isA('HeaderItem')),
        moreItems: () => find(a => isA('MoreItem')(a) && a.is_mapped()),
        resultItems: () => find(a => isA('TabItem')(a) && a.is_mapped() &&
            indicator()._resultsSection.actor.contains(a)),
        focused: () => global.stage.get_key_focus(),
        actionItems: () => find(a => (isA('ActionItem')(a) || isA('BackItem')(a)) && a.is_mapped()),
        action: label => T.actionItems().find(a => a.label.text === label),

        searchFor(text) {
            indicator()._entry.text = text;
        },

        tab: tabId => T.instance().snapshot.windows.flatMap(w => w.tabs).find(t => t.id === tabId),

        // Right-clicks the tab's row in the search results; search for its
        // title first and let the results be laid out.
        rightClickResult(tabId) {
            T.click(T.resultItems().find(i => i.tab.id === tabId), Clutter.BUTTON_SECONDARY);
        },

        // The other window's entry under "Move to window".
        otherWindowTitle(tabId) {
            const other = T.instance().snapshot.windows.find(w => !w.tabs.some(t => t.id === tabId));
            return other.tabs.find(t => t.active).title;
        },

        // Key presses through the virtual keyboard session.sh creates.
        key(keyval) {
            const t = GLib.get_monotonic_time();
            globalThis._keyboard.notify_keyval(t, keyval, Clutter.KeyState.PRESSED);
            globalThis._keyboard.notify_keyval(t + 1000, keyval, Clutter.KeyState.RELEASED);
        },

        // Presses keys in order and releases them in reverse: a combination.
        combo(...keyvals) {
            const t = GLib.get_monotonic_time();
            keyvals.forEach((k, i) => globalThis._keyboard.notify_keyval(t + i * 1000, k, Clutter.KeyState.PRESSED));
            [...keyvals].reverse().forEach((k, i) =>
                globalThis._keyboard.notify_keyval(t + (keyvals.length + i) * 1000, k, Clutter.KeyState.RELEASED));
        },

        // The extension's own settings object, as prefs and the shell use it.
        settings: () => Main.extensionManager.lookup('firefox-tabs@pollen2.github.io').stateObj.getSettings(),

        type(text) {
            for (const char of text)
                T.key(Clutter.unicode_to_keysym(char.codePointAt(0)));
        },

        scrollToStart() {
            indicator()._listSection.actor.get_parent().vadjustment.value = 0;
        },

        scrollToEnd() {
            const adjustment = indicator()._listSection.actor.get_parent().vadjustment;
            adjustment.value = adjustment.upper - adjustment.page_size;
        },

        // A tab's row in the tree (not the search results).
        treeRow: tabId => find(a => isA('TabItem')(a) && a.is_mapped() && a.tab.id === tabId &&
            indicator()._treeSection.actor.contains(a))[0],
        headerRow: label => T.headers().find(h => h.label.text === label),

        // A drag in three steps, with pauses between them as a hand would:
        // press(source), moveTo(target, where), release(). `where` is the
        // target's top quarter ('before'), bottom quarter ('after') or
        // middle ('into'); moveTo(null, ..., [x, y]) goes to a point.
        press(source) {
            const [x, y] = source.get_transformed_position();
            const [w, h] = source.get_transformed_size();
            T._at = [x + w / 3, y + h / 2];
            const t = GLib.get_monotonic_time();
            pointer.notify_absolute_motion(t, ...T._at);
            pointer.notify_button(t + 1000, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        },

        moveTo(target, where = 'into', [toX, toY] = [0, 0]) {
            if (target) {
                const [x, y] = target.get_transformed_position();
                const [w, h] = target.get_transformed_size();
                toX = x + w / 3;
                toY = y + h * {before: 0.25, after: 0.75, into: 0.5}[where];
            }
            const [fromX, fromY] = T._at;
            let t = GLib.get_monotonic_time();
            for (let i = 1; i <= 10; i++)
                pointer.notify_absolute_motion(t += 1000, fromX + (toX - fromX) * i / 10, fromY + (toY - fromY) * i / 10);
            T._at = [toX, toY];
        },

        release() {
            pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        },

        // Hovering a row moves keyboard focus to it, as in any shell menu.
        pointerAway() {
            pointer.notify_absolute_motion(GLib.get_monotonic_time(), 10, 790);
        },

        click(actor, button = Clutter.BUTTON_PRIMARY) {
            const [x, y] = actor.get_transformed_position();
            const [w, h] = actor.get_transformed_size();
            clickAt(x + w / 3, y + h / 2, button);
        },

        clickCloseIcon(item) {
            item.active = true;
            const [x, y] = item._closeIcon.get_transformed_position();
            const [w, h] = item._closeIcon.get_transformed_size();
            clickAt(x + w / 2, y + h / 2, Clutter.BUTTON_PRIMARY);
        },

        // Time from opening the menu until it shows the current snapshot.
        timeOpen() {
            const ind = indicator();
            ind.menu.close();
            const start = GLib.get_monotonic_time();
            ind.menu.open();
            ind._refresh().then(() => {
                T.lastOpenMs = ((GLib.get_monotonic_time() - start) / 1000).toFixed(1);
            });
        },

        // Index, in creation order, of the focused window among Firefox's,
        // and of the window holding `tabId` among the snapshot's windows.
        // Both sides number windows in creation order.
        focusCheck(tabId) {
            const inst = T.instance();
            const ids = inst.snapshot.windows.map(w => w.id).sort((a, b) => a - b);
            const want = ids.indexOf(inst.snapshot.windows.find(w => w.tabs.some(t => t.id === tabId)).id);
            const windows = global.display.get_tab_list(0, null)
                .filter(w => w.get_pid() === inst.pid)
                .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
            const got = windows.indexOf(global.display.focus_window);
            return got === want ? 'ok' : `focused window #${got}, expected #${want}`;
        },
    };
})();
