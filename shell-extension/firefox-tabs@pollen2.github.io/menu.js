// Menu items and the window > group > tab tree. Children of a collapsed
// header are only created when it is first expanded, so a large session
// costs little until you look into it.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Keeps the menu open: PopupMenuBase closes it from an 'activate' handler
// connected AFTER ours.
export function keepMenuOpen(item) {
    GObject.signal_stop_emission_by_name(item, 'activate');
}

// A destroyed row that is still highlighted stays referenced by the parent
// sections it bubbled up to. Un-highlighting it first lets them let go.
export function releaseOnDestroy(item) {
    item.connect('destroy', () => {
        if (item.active)
            item.active = false;
    });
}

export function ellipsizedLabel(text, styleClass) {
    const label = new St.Label({
        text,
        style_class: styleClass,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

const HeaderItem = GObject.registerClass(
class HeaderItem extends PopupMenu.PopupBaseMenuItem {
    _init(text, {depth, count, color, onToggle}) {
        super._init({style_class: `ff-header ff-depth-${depth}`});
        releaseOnDestroy(this);
        this._arrow = new St.Icon({style_class: 'popup-menu-arrow', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._arrow);
        if (color)
            this.add_child(new St.Widget({style_class: `ff-group-dot ff-color-${color}`, y_align: Clutter.ActorAlign.CENTER}));
        this.label = ellipsizedLabel(text, 'ff-header-label');
        this.add_child(this.label);
        this.label_actor = this.label;
        this.add_child(new St.Label({text: String(count), style_class: 'ff-count', y_align: Clutter.ActorAlign.CENTER}));

        this.connect('activate', () => {
            keepMenuOpen(this);
            onToggle();
        });
    }

    setExpanded(expanded) {
        this._arrow.icon_name = expanded ? 'pan-down-symbolic' : 'pan-end-symbolic';
        if (expanded)
            this.add_accessible_state(Atk.StateType.EXPANDED);
        else
            this.remove_accessible_state(Atk.StateType.EXPANDED);
    }
});

export const TabItem = GObject.registerClass(
class TabItem extends PopupMenu.PopupBaseMenuItem {
    _init(tab, {depth, icon, fallbackIcon, onActivate, onClose, onShowActions}) {
        super._init({style_class: `ff-tab ff-depth-${depth}`});
        releaseOnDestroy(this);
        this.tab = tab;
        this._onClose = onClose;
        this._onShowActions = onShowActions;

        // St loads icons in the background and caches them by file.
        this.icon = new St.Icon({
            gicon: icon,
            fallback_gicon: fallbackIcon,
            style_class: 'ff-tab-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.icon);
        this.label = ellipsizedLabel(tab.title || tab.url || '', tab.active ? 'ff-tab-label ff-active' : 'ff-tab-label');
        this.add_child(this.label);
        this.label_actor = this.label;

        if (tab.audible || tab.muted) {
            this.add_child(new St.Icon({
                icon_name: tab.muted ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic',
                style_class: 'ff-tab-status',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        if (tab.pinned) {
            this.add_child(new St.Icon({
                icon_name: 'view-pin-symbolic',
                style_class: 'ff-tab-status',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        // Shown on hover/focus; kept allocated so titles don't reflow.
        this._closeIcon = new St.Icon({
            icon_name: 'window-close-symbolic',
            style_class: 'ff-tab-close',
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
        });
        this.add_child(this._closeIcon);
        this.connect('notify::active', () => {
            this._closeIcon.opacity = this.active ? 255 : 0;
        });

        this.connect('activate', (_item, event) => {
            if (this._isCloseClick(event)) {
                keepMenuOpen(this);
                onClose(this);
            } else if (event?.type() === Clutter.EventType.BUTTON_RELEASE &&
                       event.get_button() === Clutter.BUTTON_SECONDARY) {
                keepMenuOpen(this);
                onShowActions(this);
            } else {
                onActivate(this);
            }
        });
    }

    _isCloseClick(event) {
        if (event?.type() !== Clutter.EventType.BUTTON_RELEASE)
            return false;
        if (event.get_button() === Clutter.BUTTON_MIDDLE)
            return true;
        const [x, y] = event.get_coords();
        const [ok, localX, localY] = this._closeIcon.transform_stage_point(x, y);
        return ok && localX >= 0 && localY >= 0 &&
            localX <= this._closeIcon.width && localY <= this._closeIcon.height;
    }

    vfunc_key_press_event(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Delete) {
            this._onClose(this);
            return Clutter.EVENT_STOP;
        }
        const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
        if (symbol === Clutter.KEY_Menu || (shift && symbol === Clutter.KEY_F10)) {
            this._onShowActions(this);
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }
});

// A collapsible header followed by its children, both inside one section.
class Node {
    constructor(parent, text, {depth, count, color, expanded, onExpandedChanged, buildChildren}) {
        this._buildChildren = buildChildren;
        this._onExpandedChanged = onExpandedChanged;
        this._built = false;

        this.section = new PopupMenu.PopupMenuSection();
        parent.addMenuItem(this.section);
        this.header = new HeaderItem(text, {depth, count, color, onToggle: () => this.toggle()});
        this.section.addMenuItem(this.header);
        this.body = new PopupMenu.PopupMenuSection();
        this.section.addMenuItem(this.body);
        this._setExpanded(expanded);
    }

    toggle() {
        this._setExpanded(!this.expanded);
        this._onExpandedChanged(this.expanded);
    }

    _setExpanded(expanded) {
        if (expanded && !this._built) {
            this._buildChildren(this.body);
            this._built = true;
        }
        this.expanded = expanded;
        this.body.actor.visible = expanded;
        this.header.setExpanded(expanded);
    }
}

const MoreItem = GObject.registerClass(
class MoreItem extends PopupMenu.PopupBaseMenuItem {
    _init(depth, onActivate) {
        super._init({style_class: `ff-more ff-depth-${depth}`});
        releaseOnDestroy(this);
        this.label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this.label);
        this.label_actor = this.label;
        this.connect('activate', () => {
            keepMenuOpen(this);
            onActivate();
        });
    }

    setRemaining(remaining) {
        this.label.text = `Show ${remaining} more…`;
    }
});

// Every row costs layout time each time the menu opens (St lists aren't
// virtualized), so long lists are revealed one chunk at a time.
const CHUNK_SIZE = 25;

function addChunked(section, entries, depth, addEntry) {
    let shown = 0;
    let more = null;

    const showNext = () => {
        const end = Math.min(shown + CHUNK_SIZE, entries.length);
        for (; shown < end; shown++)
            addEntry(entries[shown]);
        if (shown === entries.length) {
            more?.hide();
            return;
        }
        if (!more) {
            more = new MoreItem(depth, () => {
                const hadFocus = more.has_key_focus();
                const firstNew = section.box.get_children().indexOf(more);
                showNext();
                // Keyboard users land on the first newly shown row.
                if (hadFocus)
                    section.box.get_child_at_index(firstNew)?.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
            });
            section.addMenuItem(more);
        } else {
            // Not destroyed and re-created: this runs inside its own 'activate'.
            section.moveMenuItem(more, section.numMenuItems);
        }
        more.setRemaining(entries.length - shown);
    };
    showNext();
}

// Search results as a flat list. `matches` are {instance, tab}.
export function renderResults(section, matches, {makeTabItem}) {
    if (matches.length === 0) {
        section.addMenuItem(new PopupMenu.PopupMenuItem('No matching tabs', {reactive: false}));
        return;
    }
    addChunked(section, matches, 0, ({instance, tab}) => section.addMenuItem(makeTabItem(instance, tab, 0)));
}

// A window's tabs as rows: ungrouped tabs, or one entry per tab group
// (Firefox keeps a group's tabs contiguous).
function windowEntries(window, groups) {
    const entries = [];
    for (const tab of window.tabs) {
        const group = groups.get(tab.groupId);
        const last = entries.at(-1);
        if (!group)
            entries.push({tab});
        else if (last?.group === group)
            last.tabs.push(tab);
        else
            entries.push({group, tabs: [tab]});
    }
    return entries;
}

// A window is known by its active tab, as in its title bar.
export function windowTitle(window) {
    const active = window.tabs.find(t => t.active);
    return `${active?.title || 'Window'}${window.incognito ? ' (private)' : ''}`;
}

// Renders instances' snapshots into `section`. `expandedState` maps node keys
// to the user's last choice, so it survives re-renders.
export function renderTree(section, instances, {expandedState, makeTabItem}) {
    const windows = instances.flatMap(instance =>
        instance.snapshot.windows.map(window => ({instance, window})));
    const showWindows = windows.length > 1;

    // With several windows, only the one used last starts expanded.
    const lastUsed = w => Math.max(0, ...w.window.tabs.map(t => t.lastAccessed ?? 0));
    const current = windows.reduce((best, w) => (!best || lastUsed(w) > lastUsed(best) ? w : best), null);

    const node = (parent, key, text, options) => new Node(parent, text, {
        ...options,
        expanded: expandedState.get(key) ?? options.expanded,
        onExpandedChanged: expanded => expandedState.set(key, expanded),
    });

    const addWindowContent = (parent, instance, window, depth) => {
        const groups = new Map(instance.snapshot.groups.map(g => [g.id, g]));
        addChunked(parent, windowEntries(window, groups), depth, ({tab, group, tabs}) => {
            if (tab) {
                parent.addMenuItem(makeTabItem(instance, tab, depth));
                return;
            }
            node(parent, `g:${instance.name}:${group.id}`, group.title || 'Unnamed group', {
                depth,
                count: tabs.length,
                color: group.color,
                expanded: !group.collapsed,
                buildChildren: body => addChunked(body, tabs, depth + 1,
                    t => body.addMenuItem(makeTabItem(instance, t, depth + 1))),
            });
        });
    };

    for (const w of windows) {
        const {instance, window} = w;
        if (!showWindows) {
            addWindowContent(section, instance, window, 0);
            continue;
        }
        node(section, `w:${instance.name}:${window.id}`, windowTitle(window), {
            depth: 0,
            count: window.tabs.length,
            expanded: w === current,
            buildChildren: body => addWindowContent(body, instance, window, 1),
        });
    }
}
