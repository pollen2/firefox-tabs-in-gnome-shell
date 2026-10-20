// What right-clicking a tab (or the Menu key) shows in place of the list:
// close it, or move it to another window or tab group.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ellipsizedLabel, keepMenuOpen, releaseOnDestroy, windowTitle} from './menu.js';

function isBackKey(event) {
    const symbol = event.get_key_symbol();
    return symbol === Clutter.KEY_Left || symbol === Clutter.KEY_BackSpace;
}

// Heads the view with the tab it acts on; activating it goes back.
const BackItem = GObject.registerClass(
class BackItem extends PopupMenu.PopupBaseMenuItem {
    _init(tab, {icon, fallbackIcon, onBack}) {
        super._init({style_class: 'ff-actions-back'});
        releaseOnDestroy(this);
        this._onBack = onBack;
        this.add_child(new St.Icon({icon_name: 'go-previous-symbolic', style_class: 'ff-tab-icon'}));
        this.add_child(new St.Icon({gicon: icon, fallback_gicon: fallbackIcon, style_class: 'ff-tab-icon'}));
        this.label = ellipsizedLabel(tab.title || tab.url || '', 'ff-header-label');
        this.add_child(this.label);
        this.label_actor = this.label;
        this.connect('activate', () => {
            keepMenuOpen(this);
            onBack();
        });
    }

    vfunc_key_press_event(event) {
        if (isBackKey(event)) {
            this._onBack();
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }
});

// An action; activating it runs it and closes the menu, like any menu item.
const ActionItem = GObject.registerClass(
class ActionItem extends PopupMenu.PopupBaseMenuItem {
    _init(text, {iconName, color, onBack}, run) {
        super._init({style_class: 'ff-action'});
        releaseOnDestroy(this);
        this._onBack = onBack;
        if (iconName)
            this.add_child(new St.Icon({icon_name: iconName, style_class: 'ff-tab-icon'}));
        else if (color)
            this.add_child(new St.Widget({style_class: `ff-group-dot ff-action-dot ff-color-${color}`, y_align: Clutter.ActorAlign.CENTER}));
        this.label = ellipsizedLabel(text, 'ff-action-label');
        this.add_child(this.label);
        this.label_actor = this.label;
        this.connect('activate', () => run());
    }

    vfunc_key_press_event(event) {
        if (isBackKey(event)) {
            this._onBack();
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }
});

// `actions` holds the callbacks: back, close, newWindow, moveToWindow(id),
// group(id), newGroup, ungroup.
export function renderActions(section, {snapshot, tab, icon, fallbackIcon}, actions) {
    const window = snapshot.windows.find(w => w.tabs.some(t => t.id === tab.id));
    const add = (text, options, run) =>
        section.addMenuItem(new ActionItem(text, {...options, onBack: actions.back}, run));
    const heading = text => section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(text));

    section.addMenuItem(new BackItem(tab, {icon, fallbackIcon, onBack: actions.back}));
    add('Close tab', {iconName: 'window-close-symbolic'}, actions.close);
    if (window.tabs.length > 1)
        add('Move to new window', {iconName: 'window-new-symbolic'}, actions.newWindow);

    // Firefox keeps private and normal tabs apart.
    const others = snapshot.windows.filter(w => w !== window && !!w.incognito === !!window.incognito);
    if (others.length > 0) {
        heading('Move to window');
        for (const other of others)
            add(windowTitle(other), {iconName: 'tab-new-symbolic'}, () => actions.moveToWindow(other.id));
    }

    // Pinned tabs can't be in a group.
    if (tab.pinned)
        return;
    const sameKind = new Set(snapshot.windows.filter(w => !!w.incognito === !!window.incognito).map(w => w.id));
    heading('Tab group');
    if (tab.groupId !== -1)
        add('Remove from group', {iconName: 'list-remove-symbolic'}, actions.ungroup);
    add('New group', {iconName: 'list-add-symbolic'}, actions.newGroup);
    for (const group of snapshot.groups) {
        if (group.id !== tab.groupId && sameKind.has(group.windowId))
            add(group.title || 'Unnamed group', {color: group.color}, () => actions.group(group.id));
    }
}
