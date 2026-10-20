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
        walk(indicator()._tabsSection.actor);
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
        moreItems: () => find(a => isA('MoreItem')(a) && a.visible),

        scrollToStart() {
            indicator()._tabsSection.actor.get_parent().vadjustment.value = 0;
        },

        scrollToEnd() {
            const adjustment = indicator()._tabsSection.actor.get_parent().vadjustment;
            adjustment.value = adjustment.upper - adjustment.page_size;
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
