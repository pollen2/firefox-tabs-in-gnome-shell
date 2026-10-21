import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {renderActions} from './actions.js';
import {DragDetector, TabDrag} from './drag.js';
import {InstanceWatcher} from './instances.js';
import {TabItem, renderResults, renderTree} from './menu.js';
import {TabIndex} from './search.js';
import {WindowRaiser} from './windows.js';

// Printable characters typed while a row has focus go to the search box.
const PRINTABLE = /^[\p{L}\p{N}\p{P}\p{S}]$/u;

// How long after a drop the list follows Firefox's snapshots.
const REDRAW_WINDOW_MS = 1500;

// Monochrome Firefox icons installed by the various Firefox packages (we
// don't ship Mozilla's logo). The installed Firefox's own name goes first.
const FIREFOX_SYMBOLIC_ICONS = ['firefox-symbolic', 'org.mozilla.firefox-symbolic', 'firefox-esr-symbolic'];

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension, settings) {
        super._init(0.0, 'Firefox tabs in top bar');
        this._icons = {
            panel: Gio.icon_new_for_string(`${extension.path}/icons/firefox-tabs-symbolic.svg`),
            page: Gio.icon_new_for_string(`${extension.path}/icons/page-symbolic.svg`),
        };
        this._panelIcon = new St.Icon({
            gicon: Gio.ThemedIcon.new_from_names(FIREFOX_SYMBOLIC_ICONS),
            fallback_gicon: this._icons.panel,
            style_class: 'system-status-icon',
        });
        this._panelIconFromApp = false;
        this._countLabel = new St.Label({style_class: 'ff-panel-count', y_align: Clutter.ActorAlign.CENTER});
        settings.bind('show-tab-count', this._countLabel, 'visible', Gio.SettingsBindFlags.GET);
        const panelBox = new St.BoxLayout({style_class: 'ff-panel-box'});
        panelBox.add_child(this._panelIcon);
        panelBox.add_child(this._countLabel);
        this.add_child(panelBox);
        this._iconDir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'firefox-tabs', 'icons']);

        this._expansion = {user: new Map(), shown: new Map()};
        this._renderedKey = null;
        this._rendered = [];
        this._index = null;
        // "<bus name>:<tab id>" -> rows showing that tab (tree and results).
        this._rows = new Map();
        this._focusSource = 0;
        this._showingActions = false;
        this._actionsOrigin = null;
        this._drag = null;
        this._cancelRedrawWait = null;
        this._raiser = new WindowRaiser();
        this._buildMenu();

        this._watcher = new InstanceWatcher(() => this._sync());
        this._sync();
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._refresh();
                this._focusSearchSoon();
            } else {
                this._expansion.shown.clear();
                this._drag?.cancel();
                this._hideActions();
                this._entry.text = '';
            }
        });
        this.menu.actor.connect('key-press-event', (_actor, event) => this._redirectTypingToSearch(event));
    }

    _buildMenu() {
        this._entry = new St.Entry({
            style_class: 'ff-search-entry',
            hint_text: 'Search tabs…',
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'ff-search-icon'}),
        });
        this._entry.clutter_text.connect('text-changed', () => this._onSearchChanged());
        this._entry.clutter_text.connect('key-press-event', (_actor, event) => this._onEntryKeyPress(event));
        this._searchBox = new St.Bin({style_class: 'ff-search-box', child: this._entry, x_expand: true});
        this.menu.box.add_child(this._searchBox);

        // The menu's max-height comes from PanelMenu.Button; the tab list
        // scrolls inside it. Adding the section first wires its items to the
        // menu (activation closes it), then it is moved into the scroll view.
        this._listSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._listSection);
        this.menu.box.remove_child(this._listSection.actor);
        this._scrollView = new St.ScrollView({
            style_class: 'ff-tabs-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: false,
            child: this._listSection.actor,
        });
        this.menu.box.add_child(this._scrollView);

        // The tree stays built while searching; results replace it on screen.
        this._treeSection = new PopupMenu.PopupMenuSection();
        this._listSection.addMenuItem(this._treeSection);
        this._resultsSection = new PopupMenu.PopupMenuSection();
        this._resultsSection.actor.hide();
        this._listSection.addMenuItem(this._resultsSection);
        // A tab's actions (right-click) replace both while shown.
        this._actionsSection = new PopupMenu.PopupMenuSection();
        this._actionsSection.actor.hide();
        this._listSection.addMenuItem(this._actionsSection);

        // Clutter only delivers events to reactive actors: the scroll view
        // is, the menu sections inside it aren't.
        this._dragDetector = new DragDetector(this._scrollView,
            () => this._dropRows().filter(r => r.dropTarget.kind === 'tab'),
            (row, x, y) => this._startDrag(row.dropTarget.instance, row.tab, row, x, y));
    }

    // Shows the tree, the search results or a tab's actions.
    _syncView() {
        const searching = this._entry.text.trim() !== '';
        this._searchBox.visible = !this._showingActions;
        this._treeSection.actor.visible = !this._showingActions && !searching;
        this._resultsSection.actor.visible = !this._showingActions && searching;
        this._actionsSection.actor.visible = this._showingActions;
    }

    // Panel button: shown while Firefox runs, with the number of tabs.
    _sync() {
        this.visible = this._watcher.instances.size > 0;
        if (!this.visible)
            this.menu.close();
        const count = this._watcher.tabCount;
        this._countLabel.text = String(count);
        this.accessible_name = `Firefox tabs in top bar: ${count} tabs`;
        if (this.visible && !this._panelIconFromApp)
            this._usePanelIconOfRunningFirefox();
    }

    // Prefers the monochrome icon matching the running Firefox's own app icon
    // ("firefox-esr" -> "firefox-esr-symbolic").
    _usePanelIconOfRunningFirefox() {
        const pids = new Set([...this._watcher.instances.values()].map(i => i.pid));
        const window = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null).find(w => pids.has(w.get_pid()));
        const appIcon = window && Shell.WindowTracker.get_default().get_window_app(window)?.get_app_info()?.get_icon();
        if (!(appIcon instanceof Gio.ThemedIcon))
            return;
        const names = appIcon.get_names().map(n => `${n}-symbolic`);
        this._panelIcon.gicon = Gio.ThemedIcon.new_from_names([...names, ...FIREFOX_SYMBOLIC_ICONS]);
        this._panelIconFromApp = true;
    }

    // The menu manager focuses the menu itself right after opening it.
    _focusSearchSoon() {
        if (this._focusSource)
            return;
        this._focusSource = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusSource = 0;
            if (this.menu.isOpen)
                this._entry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        const instances = [...this._watcher.instances.values()].sort((a, b) => a.pid - b.pid);
        const results = await Promise.allSettled(instances.map(i => i.refresh()));
        if (!this._watcher || !this.menu.isOpen)
            return;

        for (const [i, r] of results.entries()) {
            if (r.status === 'rejected')
                console.error(`firefox-tabs: ${instances[i].name} did not answer`, r.reason);
        }
        const ready = instances.filter(i => i.snapshot);
        const key = ready.map(i => `${i.name}:${i.serial}`).join(' ');
        if (key === this._renderedKey)
            return;
        this._renderedKey = key;
        this._rendered = ready;
        this._index = null;
        this._tabIcon = this._tabIconLookup(ready);

        const scroll = this._scrollView.vadjustment.value;
        this._treeSection.removeAll();
        if (ready.length === 0) {
            this._treeSection.addMenuItem(new PopupMenu.PopupMenuItem('Firefox is not answering', {reactive: false}));
            return;
        }
        renderTree(this._treeSection, ready, {
            expansion: this._expansion,
            makeTabItem: (instance, tab, depth) => this._makeTabItem(instance, tab, depth, {draggable: true}),
        });
        this._restoreScroll(scroll);
        // Typed before the snapshot arrived.
        this._onSearchChanged();
    }

    // Tree rows can be dragged; search results are in no meaningful order.
    _makeTabItem(instance, tab, depth, {draggable = false} = {}) {
        const item = new TabItem(tab, {
            depth,
            icon: this._tabIcon(instance, tab),
            fallbackIcon: this._icons.page,
            onActivate: () => this._activateTab(instance, tab),
            onClose: () => this._closeTab(instance, tab),
            onShowActions: origin => this._showActions(instance, tab, origin),
        });
        if (draggable) {
            const windowId = instance.snapshot.windows.find(w => w.tabs.includes(tab)).id;
            item.dropTarget = {kind: 'tab', instance, windowId, tab};
        }
        const key = `${instance.name}:${tab.id}`;
        if (!this._rows.has(key))
            this._rows.set(key, new Set());
        this._rows.get(key).add(item);
        item.connect('destroy', () => {
            this._rows.get(key)?.delete(item);
            if (this._rows.get(key)?.size === 0)
                this._rows.delete(key);
        });
        return item;
    }

    // Favicons are files the host writes, named by the snapshot's `icon` key.
    // Firefox's own pages (about:) have no readable favicon: they get
    // Firefox's app icon.
    _tabIconLookup(instances) {
        const fileIcons = new Map();
        const appIcons = new Map(instances.map(instance => {
            const window = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)
                .find(w => w.get_pid() === instance.pid);
            const app = window && Shell.WindowTracker.get_default().get_window_app(window);
            return [instance, app?.get_icon() ?? null];
        }));
        return (instance, tab) => {
            if (tab.icon) {
                if (!fileIcons.has(tab.icon)) {
                    const path = GLib.build_filenamev([this._iconDir, `${tab.icon}.png`]);
                    fileIcons.set(tab.icon, new Gio.FileIcon({file: Gio.File.new_for_path(path)}));
                }
                return fileIcons.get(tab.icon);
            }
            if (tab.url?.startsWith('about:'))
                return appIcons.get(instance) ?? this._icons.page;
            return this._icons.page;
        };
    }

    // After a re-render the content is laid out later; set the value then too.
    _restoreScroll(value) {
        const adjustment = this._scrollView.vadjustment;
        adjustment.value = value;
        if (value === 0)
            return;
        const id = adjustment.connect('changed', () => {
            adjustment.disconnect(id);
            adjustment.value = Math.min(value, adjustment.upper - adjustment.page_size);
        });
    }

    // Shown tree rows that take drops: tabs, group and window headers.
    _dropRows() {
        const rows = [];
        const collect = actor => {
            if (actor.dropTarget && actor.is_mapped())
                rows.push(actor);
            actor.get_children().forEach(collect);
        };
        if (this._treeSection.actor.is_mapped())
            collect(this._treeSection.actor);
        return rows;
    }

    _startDrag(instance, tab, row, x, y) {
        this._drag?.cancel();
        const rows = this._dropRows();
        const incognito = id => !!instance.snapshot.windows.find(w => w.id === id)?.incognito;
        const from = instance.snapshot.windows.find(w => w.tabs.includes(tab));

        this._drag = new TabDrag(row, {
            container: this._scrollView,
            scrollView: this._scrollView,
            rows: () => rows.filter(r => r.is_mapped()),
            // Firefox can't move tabs between profiles, or between private
            // and normal windows; pinned tabs can't join groups.
            accepts: target => target.instance === instance &&
                incognito(target.windowId) === !!from.incognito &&
                !(tab.pinned && target.kind === 'group'),
            onDrop: target => this._dropTab(instance, tab, target),
            onEnd: () => {
                this._drag = null;
            },
        });
        this._drag.update(x, y);
    }

    // Firefox adds a tab to a group when it lands next to one of its tabs,
    // and ungrouping a tab at a group's edge leaves it in place. So: move to
    // the slot, then ungroup if the slot isn't meant to be in a group.
    async _dropTab(instance, tab, target) {
        const windows = instance.snapshot.windows;
        const from = windows.find(w => w.tabs.includes(tab));
        const to = windows.find(w => w.id === target.windowId);
        this._waitForRedraw(instance);
        try {
            if (target.kind === 'group') {
                await instance.groupTabs([tab.id], target.groupId);
                return;
            }
            let prev = to.tabs.at(-1);
            let next = null;
            let intoGroup = -1;
            if (target.kind === 'tab') {
                const i = to.tabs.indexOf(target.tab);
                [prev, next] = target.position === 'before'
                    ? [to.tabs[i - 1], target.tab]
                    : [target.tab, to.tabs[i + 1]];
                intoGroup = target.tab.groupId;
            }
            const samePlace = prev === tab || next === tab;
            if (!samePlace) {
                const slot = prev ? prev.index + 1 : next.index;
                const index = target.kind === 'window' ? -1 : from === to && tab.index < slot ? slot - 1 : slot;
                await instance.moveTabs([tab.id], to.id, index);
            }
            const nextToGroup = (prev && prev !== tab && prev.groupId !== -1) || (next && next !== tab && next.groupId !== -1);
            if (intoGroup === -1 && (tab.groupId !== -1 || nextToGroup)) {
                await instance.ungroupTabs([tab.id]);
            } else if (intoGroup !== -1 && samePlace && tab.groupId !== intoGroup) {
                // Joining sends it to the group's end: put it back.
                await instance.groupTabs([tab.id], intoGroup);
                await instance.moveTabs([tab.id], to.id, tab.index);
            }
        } catch (e) {
            this._cancelRedrawWait?.();
            console.error('firefox-tabs: moving tab failed', e);
            Main.notifyError('Firefox tabs', e.message);
        }
    }

    // Redraws the list as Firefox reports the new order. A move can take
    // a couple of snapshots, and an unrelated one (a page title) may come
    // first, so keep following them for a moment.
    _waitForRedraw(instance) {
        this._cancelRedrawWait?.();
        const stopWatching = instance.watchChanges(() => {
            if (this.menu.isOpen)
                this._refresh();
        });
        const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REDRAW_WINDOW_MS, () => {
            stopWatching();
            this._cancelRedrawWait = null;
            return GLib.SOURCE_REMOVE;
        });
        this._cancelRedrawWait = () => {
            stopWatching();
            GLib.source_remove(timeout);
            this._cancelRedrawWait = null;
        };
    }

    _onSearchChanged() {
        const query = this._entry.text.trim();
        this._syncView();
        this._resultsSection.removeAll();
        if (query === '' || this._rendered.length === 0)
            return;
        this._index ??= new TabIndex(this._rendered);
        renderResults(this._resultsSection, this._index.search(query), {
            makeTabItem: this._makeTabItem.bind(this),
        });
        this._scrollView.vadjustment.value = 0;
    }

    _onEntryKeyPress(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Down) {
            this._listSection.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            if (this._resultsSection.actor.visible)
                this._resultsSection.box.get_children().find(a => a instanceof TabItem)?.activate(event);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _redirectTypingToSearch(event) {
        if (this._showingActions || this._entry.clutter_text.has_key_focus())
            return Clutter.EVENT_PROPAGATE;
        const modifiers = event.get_state() & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK);
        const text = event.get_key_unicode();
        if (modifiers || !PRINTABLE.test(text))
            return Clutter.EVENT_PROPAGATE;
        this._entry.grab_key_focus();
        this._entry.clutter_text.insert_text(text, this._entry.clutter_text.get_cursor_position());
        return Clutter.EVENT_STOP;
    }

    _showActions(instance, tab, origin) {
        const windowId = instance.snapshot.windows.find(w => w.tabs.some(t => t.id === tab.id))?.id ?? -1;
        // Left over from last time; never destroyed while one of them is
        // still handling its own activation.
        this._actionsSection.removeAll();
        renderActions(this._actionsSection, {
            snapshot: instance.snapshot,
            tab,
            icon: this._tabIcon(instance, tab),
            fallbackIcon: this._icons.page,
        }, {
            back: () => this._hideActions(),
            close: () => this._run(instance.closeTabs([tab.id])),
            newWindow: () => this._run(instance.moveTabToNewWindow(tab.id)),
            moveToWindow: id => this._run(instance.moveTabs([tab.id], id)),
            group: id => this._run(instance.groupTabs([tab.id], id)),
            newGroup: () => this._run(instance.groupTabs([tab.id], -1, windowId)),
            ungroup: () => this._run(instance.ungroupTabs([tab.id])),
        });

        this._actionsOrigin?.disconnectObject(this);
        this._actionsOrigin = origin;
        origin.connectObject('destroy', () => {
            this._actionsOrigin = null;
        }, this);
        this._showingActions = true;
        this._syncView();
        this._scrollView.vadjustment.value = 0;
        this._actionsSection.box.get_first_child()?.grab_key_focus();
    }

    _hideActions() {
        if (!this._showingActions)
            return;
        this._showingActions = false;
        this._syncView();
        this._actionsOrigin?.grab_key_focus();
        this._actionsOrigin?.disconnectObject(this);
        this._actionsOrigin = null;
    }

    // Menu actions: by the time Firefox answers the menu has closed, so a
    // failure is reported as a notification.
    _run(promise) {
        promise.catch(e => {
            console.error('firefox-tabs: action failed', e);
            Main.notifyError('Firefox tabs', e.message);
        });
    }

    async _activateTab(instance, tab) {
        const windows = instance.snapshot?.windows ?? [];
        const windowId = windows.find(w => w.tabs.some(t => t.id === tab.id))?.id;
        const raise = this._raiser.prepare(instance.pid, windowId, windows);
        try {
            const result = await instance.activateTab(tab.id);
            this._raiser?.raise(raise, result);
        } catch (e) {
            console.error('firefox-tabs: activating tab failed', e);
        }
    }

    async _closeTab(instance, tab) {
        try {
            await instance.closeTabs([tab.id]);
        } catch (e) {
            console.error('firefox-tabs: closing tab failed', e);
            return;
        }
        for (const item of [...this._rows.get(`${instance.name}:${tab.id}`) ?? []]) {
            if (item.has_key_focus())
                this._listSection.actor.navigate_focus(item, St.DirectionType.DOWN, true);
            item.destroy();
        }
    }

    _onDestroy() {
        if (this._focusSource)
            GLib.source_remove(this._focusSource);
        this._actionsOrigin?.disconnectObject(this);
        this._drag?.cancel();
        this._dragDetector.destroy();
        this._cancelRedrawWait?.();
        this._watcher.destroy();
        this._watcher = null;
        this._raiser.destroy();
        this._raiser = null;
        super._onDestroy();
    }
});

export default class FirefoxTabsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new Indicator(this, this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // Mutter follows changes to the setting by itself. POPUP: an open menu
        // (ours included, to close it again) holds a grab.
        Main.wm.addKeybinding('toggle-menu', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP, () => {
                if (this._indicator.visible)
                    this._indicator.menu.toggle();
            });
    }

    disable() {
        Main.wm.removeKeybinding('toggle-menu');
        this._indicator.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
