import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {InstanceWatcher} from './instances.js';
import {TabItem, renderTree} from './menu.js';
import {WindowRaiser} from './windows.js';

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Firefox tabs in top bar');
        this._icons = {
            panel: Gio.icon_new_for_string(`${extension.path}/icons/firefox-tabs-symbolic.svg`),
            page: Gio.icon_new_for_string(`${extension.path}/icons/page-symbolic.svg`),
        };
        this.add_child(new St.Icon({gicon: this._icons.panel, style_class: 'system-status-icon'}));

        this._expandedState = new Map();
        this._renderedKey = null;
        this._raiser = new WindowRaiser();
        this._buildMenu();

        this._watcher = new InstanceWatcher(() => this._syncVisibility());
        this._syncVisibility();
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
        });
    }

    _buildMenu() {
        // The menu's max-height comes from PanelMenu.Button; the tab list
        // scrolls inside it. Adding the section first wires its items to the
        // menu (activation closes it), then it is moved into the scroll view.
        this._tabsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._tabsSection);
        this.menu.box.remove_child(this._tabsSection.actor);
        const scrollView = new St.ScrollView({
            style_class: 'ff-tabs-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._tabsSection.actor,
        });
        this.menu.box.add_child(scrollView);
    }

    _syncVisibility() {
        this.visible = this._watcher.instances.size > 0;
        if (!this.visible)
            this.menu.close();
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

        this._tabsSection.removeAll();
        if (ready.length === 0) {
            this._tabsSection.addMenuItem(new PopupMenu.PopupMenuItem('Firefox is not answering', {reactive: false}));
            return;
        }
        renderTree(this._tabsSection, ready, {
            expandedState: this._expandedState,
            makeTabItem: (instance, tab, depth) => new TabItem(tab, {
                depth,
                placeholderIcon: this._icons.page,
                onActivate: () => this._activateTab(instance, tab),
                onClose: item => this._closeTab(instance, item),
            }),
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

    async _closeTab(instance, item) {
        try {
            await instance.closeTabs([item.tab.id]);
        } catch (e) {
            console.error('firefox-tabs: closing tab failed', e);
            return;
        }
        if (item.has_key_focus())
            this._tabsSection.actor.navigate_focus(item, St.DirectionType.DOWN, true);
        item.destroy();
    }

    _onDestroy() {
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
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
