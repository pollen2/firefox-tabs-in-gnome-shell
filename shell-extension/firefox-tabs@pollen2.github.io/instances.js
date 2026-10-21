// Tracks running Firefox instances (one native host each) on the session bus.
// Nothing here polls: instances come and go through NameOwnerChanged,
// snapshots are only fetched when the menu opens, and the panel's tab count
// only wakes us when it changes.

// Gio.DBusConnection.call() returns a promise: GNOME Shell promisifies it.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAMESPACE = 'io.github.pollen2.FirefoxTabs';
const INSTANCE_NAME = /^io\.github\.pollen2\.FirefoxTabs\.i(\d+)$/;
const OBJECT_PATH = '/io/github/pollen2/FirefoxTabs';
const INTERFACE = 'io.github.pollen2.FirefoxTabs1';
const CALL_TIMEOUT_MS = 6000;

const isCancelled = e => e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);

class Instance {
    constructor(bus, name, pid, cancellable, onTabCountChanged) {
        this._bus = bus;
        this._cancellable = cancellable;
        this.name = name;
        this.pid = pid;
        this.serial = 0;
        this.snapshot = null;
        this.tabCount = 0;

        const setTabCount = count => {
            this.tabCount = count;
            onTabCountChanged();
        };
        this._countSubscription = bus.signal_subscribe(name, 'org.freedesktop.DBus.Properties',
            'PropertiesChanged', OBJECT_PATH, INTERFACE, Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [, changed] = params.recursiveUnpack();
                if ('TabCount' in changed)
                    setTabCount(changed.TabCount);
            });
        bus.call(name, OBJECT_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [INTERFACE, 'TabCount']), new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NO_AUTO_START, CALL_TIMEOUT_MS, cancellable)
            .then(reply => setTabCount(reply.recursiveUnpack()[0]))
            .catch(e => {
                if (!isCancelled(e))
                    console.error(`firefox-tabs: ${name} has no tab count`, e);
            });
    }

    _call(method, params = null, replyType = null) {
        return this._bus.call(this.name, OBJECT_PATH, INTERFACE, method, params,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NO_AUTO_START, CALL_TIMEOUT_MS, this._cancellable);
    }

    // Returns true when the snapshot changed since the last refresh. Refreshes
    // can overlap: an older reply arriving late must not replace a newer one.
    async refresh() {
        const reply = await this._call('GetSnapshot', null, '(us)');
        const [serial, json] = reply.deepUnpack();
        if (serial <= this.serial)
            return false;
        this.snapshot = JSON.parse(json);
        this.serial = serial;
        return true;
    }

    // Calls `callback` on every new snapshot until the returned function is
    // called.
    watchChanges(callback) {
        let id = this._bus.signal_subscribe(this.name, INTERFACE, 'Changed', OBJECT_PATH,
            null, Gio.DBusSignalFlags.NONE, () => callback());
        return () => {
            if (id)
                this._bus.signal_unsubscribe(id);
            id = 0;
        };
    }

    async activateTab(tabId) {
        const reply = await this._call('ActivateTab', new GLib.Variant('(x)', [tabId]), '(s)');
        return JSON.parse(reply.deepUnpack()[0]);
    }

    async closeTabs(tabIds) {
        await this._call('CloseTabs', new GLib.Variant('(ax)', [tabIds]));
    }

    // index -1: at the end of the window.
    async moveTabs(tabIds, windowId, index = -1) {
        await this._call('MoveTabs', new GLib.Variant('(axxi)', [tabIds, windowId, index]));
    }

    async moveTabToNewWindow(tabId) {
        await this._call('MoveTabToNewWindow', new GLib.Variant('(x)', [tabId]));
    }

    // groupId -1: a new group in windowId.
    async groupTabs(tabIds, groupId, windowId = -1) {
        await this._call('GroupTabs', new GLib.Variant('(axxx)', [tabIds, groupId, windowId]));
    }

    async ungroupTabs(tabIds) {
        await this._call('UngroupTabs', new GLib.Variant('(ax)', [tabIds]));
    }

    destroy() {
        this._bus.signal_unsubscribe(this._countSubscription);
    }
}

export class InstanceWatcher {
    // `onChanged` runs when instances come or go, or a tab count changes.
    constructor(onChanged) {
        this._bus = Gio.DBus.session;
        this._cancellable = new Gio.Cancellable();
        this._onChanged = onChanged;
        this.instances = new Map();

        this._subscription = this._bus.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', BUS_NAMESPACE, Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [name, , newOwner] = params.deepUnpack();
                this._update(name, newOwner !== '');
            });
        this._listExisting().catch(e => {
            if (!isCancelled(e))
                console.error('firefox-tabs: listing bus names failed', e);
        });
    }

    get tabCount() {
        let count = 0;
        for (const instance of this.instances.values())
            count += instance.tabCount;
        return count;
    }

    async _listExisting() {
        const reply = await this._bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, -1, this._cancellable);
        for (const name of reply.deepUnpack()[0])
            this._update(name, true);
    }

    _update(name, present) {
        const match = INSTANCE_NAME.exec(name);
        if (!match || present === this.instances.has(name))
            return;
        if (present) {
            this.instances.set(name, new Instance(this._bus, name, Number(match[1]),
                this._cancellable, () => this._onChanged()));
        } else {
            this.instances.get(name).destroy();
            this.instances.delete(name);
        }
        this._onChanged();
    }

    destroy() {
        this._cancellable.cancel();
        this._bus.signal_unsubscribe(this._subscription);
        for (const instance of this.instances.values())
            instance.destroy();
        this.instances.clear();
    }
}
