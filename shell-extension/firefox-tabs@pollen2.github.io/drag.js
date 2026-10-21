// Reordering tabs by dragging their rows. Built on plain Clutter events and a
// stage grab: GNOME Shell's drag-and-drop module is internal, and
// Clutter.DragAction no longer exists in GNOME 48.
//
// Rows' own click handling takes the pointer while a button is held, so both
// detection and the drag itself listen on a reactive container of the rows,
// in the capture phase, which sees events before the rows do.
//
// Rows that accept drops carry a `dropTarget`:
//   {kind: 'tab', instance, windowId, tab}   drop before or after the tab
//   {kind: 'group', instance, windowId, groupId}  drop into the group
//   {kind: 'window', instance, windowId}     drop at the end of the window

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Within this distance of the list's top or bottom edge, the list scrolls.
const EDGE = 32;
const SCROLL_STEP = 10;
const SCROLL_INTERVAL_MS = 16;
// The bar between rows: its thickness, and its inset from the row's sides.
const BAR = 2;
const BAR_INSET = 8;
const DROP_CLASSES = ['ff-drop-before', 'ff-drop-after', 'ff-drop-into'];

const POINTER_EVENTS = new Set([
    Clutter.EventType.MOTION, Clutter.EventType.ENTER, Clutter.EventType.LEAVE,
    Clutter.EventType.BUTTON_PRESS, Clutter.EventType.BUTTON_RELEASE,
]);

function rowAt(rows, x, y) {
    return rows.find(r => {
        const [rowX, rowY] = r.get_transformed_position();
        const [width, height] = r.get_transformed_size();
        return x >= rowX && x < rowX + width && y >= rowY && y < rowY + height;
    }) ?? null;
}

// Calls `onStart(row, x, y)` when the pointer moves past the drag threshold
// with the primary button held on one of `rows()` (tab rows).
export class DragDetector {
    constructor(container, rows, onStart) {
        this._container = container;
        this._rows = rows;
        this._onStart = onStart;
        this._pressed = null;
        this._id = container.connect('captured-event', (_actor, event) => this._onEvent(event));
    }

    _onEvent(event) {
        switch (event.type()) {
        case Clutter.EventType.BUTTON_PRESS: {
            // By the press's own coordinates: the picked actor may already
            // reflect later pointer motion.
            const coords = event.get_coords();
            const row = event.get_button() === Clutter.BUTTON_PRIMARY ? rowAt(this._rows(), ...coords) : null;
            this._pressed = row ? {row, coords} : null;
            break;
        }
        case Clutter.EventType.MOTION: {
            if (!this._pressed)
                break;
            const [startX, startY] = this._pressed.coords;
            const [x, y] = event.get_coords();
            if (Math.hypot(x - startX, y - startY) < St.Settings.get().drag_threshold)
                break;
            const {row} = this._pressed;
            this._pressed = null;
            // Releasing the button must not also activate the tab.
            row.get_actions().find(a => a instanceof Clutter.ClickAction)?.release();
            this._onStart(row, x, y);
            return Clutter.EVENT_STOP;
        }
        case Clutter.EventType.BUTTON_RELEASE:
            this._pressed = null;
            break;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    destroy() {
        this._container.disconnect(this._id);
    }
}

export class TabDrag {
    // `rows()` returns the rows that may take a drop; `accepts(target)` says
    // whether this tab may go there; `onDrop(target)` performs the move.
    constructor(source, {container, scrollView, rows, accepts, onDrop, onEnd}) {
        this._source = source;
        this._container = container;
        this._scrollView = scrollView;
        this._rows = rows;
        this._accepts = accepts;
        this._onDrop = onDrop;
        this._onEnd = onEnd;
        this._target = null;
        this._targetRow = null;
        this._scrollSource = 0;
        this._scrollDirection = 0;
        this._pointer = [0, 0];

        // Over the menu (which lives in the uiGroup too), never taking events.
        this._marker = new St.Widget({style_class: 'ff-drop-marker', reactive: false, visible: false});
        Main.layoutManager.uiGroup.add_child(this._marker);

        source.opacity = 128;
        this._grab = global.stage.grab(container);
        this._eventId = container.connect('captured-event', (_actor, event) => this._onEvent(event));
    }

    _onEvent(event) {
        switch (event.type()) {
        case Clutter.EventType.MOTION:
            this.update(...event.get_coords());
            return Clutter.EVENT_STOP;
        case Clutter.EventType.BUTTON_RELEASE: {
            const target = this._target;
            this.cancel();
            if (target)
                this._onDrop(target);
            return Clutter.EVENT_STOP;
        }
        case Clutter.EventType.KEY_PRESS:
            if (event.get_key_symbol() === Clutter.KEY_Escape)
                this.cancel();
            return Clutter.EVENT_STOP;
        case Clutter.EventType.SCROLL:
            this._scrollBy(this._wheelDelta(event));
            return Clutter.EVENT_STOP;
        default:
            // No hover effects on the rows while dragging.
            return POINTER_EVENTS.has(event.type()) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        }
    }

    _wheelDelta(event) {
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            return -3 * SCROLL_STEP;
        case Clutter.ScrollDirection.DOWN:
            return 3 * SCROLL_STEP;
        case Clutter.ScrollDirection.SMOOTH:
            return event.get_scroll_delta()[1] * 3 * SCROLL_STEP;
        default:
            return 0;
        }
    }

    update(x, y) {
        this._pointer = [x, y];
        const [left, top] = this._scrollView.get_transformed_position();
        const [width, height] = this._scrollView.get_transformed_size();
        const inside = x >= left && x < left + width && y >= top && y < top + height;

        let target = null;
        const row = inside ? rowAt(this._rows(), x, y) : null;
        if (row && row !== this._source) {
            const [, rowY] = row.get_transformed_position();
            const [, rowHeight] = row.get_transformed_size();
            let position = 'into';
            if (row.dropTarget.kind === 'tab')
                position = y < rowY + rowHeight / 2 ? 'before' : 'after';
            target = {...row.dropTarget, position};
            if (!this._accepts(target))
                target = null;
        }
        this._highlight(target ? row : null, target?.position);
        this._target = target;

        this._autoScroll(!inside ? 0 : y < top + EDGE ? -1 : y > top + height - EDGE ? 1 : 0);
    }

    // Marks the row (a style class, for themes and tests) and places the
    // marker over it.
    _highlight(row, position) {
        if (this._targetRow && this._targetRow !== row)
            DROP_CLASSES.forEach(c => this._targetRow.remove_style_class_name(c));
        this._targetRow = row;
        this._marker.visible = row !== null;
        if (!row)
            return;
        DROP_CLASSES.forEach(c => row.remove_style_class_name(c));
        row.add_style_class_name(`ff-drop-${position}`);

        const [x, y] = row.get_transformed_position();
        const [width, height] = row.get_transformed_size();
        if (position === 'into') {
            this._marker.add_style_class_name('ff-drop-marker-into');
            this._marker.set_position(x, y);
            this._marker.set_size(width, height);
        } else {
            this._marker.remove_style_class_name('ff-drop-marker-into');
            const edge = position === 'before' ? y : y + height;
            this._marker.set_position(x + BAR_INSET, Math.round(edge - BAR / 2));
            this._marker.set_size(width - 2 * BAR_INSET, BAR);
        }
        this._marker.get_parent().set_child_above_sibling(this._marker, null);
    }

    _scrollBy(delta) {
        const adjustment = this._scrollView.vadjustment;
        const max = adjustment.upper - adjustment.page_size;
        adjustment.value = Math.max(0, Math.min(max, adjustment.value + delta));
        this.update(...this._pointer);
    }

    _autoScroll(direction) {
        if (direction === this._scrollDirection)
            return;
        this._scrollDirection = direction;
        if (this._scrollSource) {
            GLib.source_remove(this._scrollSource);
            this._scrollSource = 0;
        }
        if (direction === 0)
            return;
        this._scrollSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLL_INTERVAL_MS, () => {
            this._scrollBy(this._scrollDirection * SCROLL_STEP);
            return GLib.SOURCE_CONTINUE;
        });
    }

    cancel() {
        if (!this._grab)
            return;
        this._autoScroll(0);
        this._highlight(null);
        this._marker.destroy();
        this._container.disconnect(this._eventId);
        this._source.opacity = 255;
        this._grab.dismiss();
        this._grab = null;
        this._onEnd();
    }
}
