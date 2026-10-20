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
import {InstanceWatcher} from './instances.js';
import {TabItem, renderResults, renderTree} from './menu.js';
import {TabIndex} from './search.js';
import {WindowRaiser} from './windows.js';

// Printable characters typed while a row has focus go to the search box.
const PRINTABLE = /^[\p{L}\p{N}\p{P}\p{S}]$/u;

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Firefox tabs in top bar');
        this._icons = {
            panel: Gio.icon_new_for_string(`${extension.path}/icons/firefox-tabs-symbolic.svg`),
            page: Gio.icon_new_for_string(`${extension.path}/icons/page-symbolic.svg`),
        };
        this.add_child(new St.Icon({gicon: this._icons.panel, style_class: 'system-status-icon'}));
        this._iconDir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'firefox-tabs', 'icons']);

        this._expandedState = new Map();
        this._renderedKey = null;
        this._rendered = [];
        this._index = null;
        // "<bus name>:<tab id>" -> rows showing that tab (tree and results).
        this._rows = new Map();
        this._focusSource = 0;
        this._showingActions = false;
        this._actionsOrigin = null;
        this._raiser = new WindowRaiser();
        this._buildMenu();

        this._watcher = new InstanceWatcher(() => this._syncVisibility());
        this._syncVisibility();
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._refresh();
                this._focusSearchSoon();
            } else {
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
            overlay_scrollbars: true,
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
    }

    // Shows the tree, the search results or a tab's actions.
    _syncView() {
        const searching = this._entry.text.trim() !== '';
        this._searchBox.visible = !this._showingActions;
        this._treeSection.actor.visible = !this._showingActions && !searching;
        this._resultsSection.actor.visible = !this._showingActions && searching;
        this._actionsSection.actor.visible = this._showingActions;
    }

    _syncVisibility() {
        this.visible = this._watcher.instances.size > 0;
        if (!this.visible)
            this.menu.close();
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

        this._treeSection.removeAll();
        if (ready.length === 0) {
            this._treeSection.addMenuItem(new PopupMenu.PopupMenuItem('Firefox is not answering', {reactive: false}));
            return;
        }
        renderTree(this._treeSection, ready, {
            expandedState: this._expandedState,
            makeTabItem: this._makeTabItem.bind(this),
        });
        // Typed before the snapshot arrived.
        this._onSearchChanged();
    }

    _makeTabItem(instance, tab, depth) {
        const item = new TabItem(tab, {
            depth,
            icon: this._tabIcon(instance, tab),
            fallbackIcon: this._icons.page,
            onActivate: () => this._activateTab(instance, tab),
            onClose: () => this._closeTab(instance, tab),
            onShowActions: origin => this._showActions(instance, tab, origin),
        });
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
        this._watcher.destroy();
        this._watcher = null;
        this._raiser.destroy();
        this._raiser = null;
        super._onDestroy();
    }
});

export default class FirefoxTabsExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // Mutter follows changes to the setting by itself. POPUP: an open menu
        // (ours included, to close it again) holds a grab.
        this._settings = this.getSettings();
        Main.wm.addKeybinding('toggle-menu', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP, () => {
                if (this._indicator.visible)
                    this._indicator.menu.toggle();
            });
    }

    disable() {
        Main.wm.removeKeybinding('toggle-menu');
        this._settings = null;
        this._indicator.destroy();
        this._indicator = null;
    }
}
