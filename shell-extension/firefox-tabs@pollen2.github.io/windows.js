// Raises the Firefox window holding a tab. Firefox can't focus itself on
// Wayland, and WebExtension window ids don't map to Meta.Window, so we narrow
// the candidates to the host's Firefox pid and identify the window by its
// title, which Firefox sets to "<active tab title> — <brand>".
//
// In order:
//  1. before switching tabs, the only window titled after the target
//     window's active tab (known from the snapshot);
//  2. if several windows share that title, pair them up with Firefox's own
//     windows of that title by focus order: both sides track it;
//  3. the window whose title changed after switching, or that shows the
//     activated tab's title, waiting briefly if Firefox is slow to retitle.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Firefox throttles hidden windows to about one frame per second, which can
// delay their retitling that long.
const TITLE_WAIT_MS = 1100;

// Most recently used first.
function firefoxWindows(pid) {
    return global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)
        .filter(w => w.get_pid() === pid);
}

// Windows whose title shows `tabTitle`, in the order given. Prefers the exact
// "<title> — " form so "GitHub" doesn't also match "GitHub · Foo".
function titledAfter(windows, tabTitle, titleOf = w => w.get_title() ?? '') {
    if (!tabTitle)
        return [];
    const exact = windows.filter(w => titleOf(w) === tabTitle || titleOf(w).startsWith(`${tabTitle} — `));
    return exact.length ? exact : windows.filter(w => titleOf(w).startsWith(tabTitle));
}

const activeTitle = window => window.tabs.find(t => t.active)?.title;

export class WindowRaiser {
    constructor() {
        this._pending = null;
    }

    // Call before activating the tab. `snapshotWindows` are the instance's
    // windows from its latest snapshot.
    prepare(pid, windowId, snapshotWindows) {
        const titles = new Map(firefoxWindows(pid).map(w => [w, w.get_title() ?? '']));
        const target = snapshotWindows.find(w => w.id === windowId);
        const title = target && activeTitle(target);
        return {
            pid,
            titles,
            // Meta windows showing the target's active tab title, most recent first.
            sameTitle: titledAfter([...titles.keys()], title, w => titles.get(w)),
            // Firefox windows with that same active tab title.
            sameTitleIds: title ? snapshotWindows.filter(w => activeTitle(w) === title).map(w => w.id) : [],
        };
    }

    raise({pid, titles, sameTitle, sameTitleIds}, {windowId, title, focusOrder = []}) {
        this._cancelPending();
        const candidates = firefoxWindows(pid);
        const alive = w => candidates.includes(w);

        if (candidates.length <= 1) {
            this._activate(candidates[0]);
            return;
        }
        if (sameTitle.length === 1 && alive(sameTitle[0])) {
            this._activate(sameTitle[0]);
            return;
        }
        // Only when Firefox has seen every one of them focused: windows it
        // opened without user input may never have been.
        if (sameTitle.length > 1 && sameTitle.length === sameTitleIds.length && sameTitle.every(alive) &&
            sameTitleIds.every(id => focusOrder.includes(id))) {
            const byFocus = focusOrder.filter(id => sameTitleIds.includes(id));
            this._activate(sameTitle[byFocus.indexOf(windowId)]);
            return;
        }

        const changed = candidates.filter(w => (w.get_title() ?? '') !== titles.get(w));
        const found = (changed.length === 1 ? changed[0] : null) ?? titledAfter(candidates, title)[0];
        if (found) {
            this._activate(found);
            return;
        }

        // Firefox hasn't retitled the window yet: the first one that does is it.
        const handlers = candidates.map(w => [w, w.connect('notify::title', () => this._finishPending(w))]);
        const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TITLE_WAIT_MS, () => {
            this._pending.timeout = 0;
            this._finishPending(candidates[0]);
            return GLib.SOURCE_REMOVE;
        });
        this._pending = {handlers, timeout};
    }

    _activate(window) {
        if (window)
            Main.activateWindow(window);
    }

    _finishPending(window) {
        this._cancelPending();
        this._activate(window);
    }

    _cancelPending() {
        if (!this._pending)
            return;
        for (const [w, id] of this._pending.handlers)
            w.disconnect(id);
        if (this._pending.timeout)
            GLib.source_remove(this._pending.timeout);
        this._pending = null;
    }

    destroy() {
        this._cancelPending();
    }
}
