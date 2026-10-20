// Tracks running Firefox instances (one native host each) on the session bus.
// Nothing here polls: instances come and go through NameOwnerChanged, and
// snapshots are only fetched when the menu opens.

// Gio.DBusConnection.call() returns a promise: GNOME Shell promisifies it.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAMESPACE = 'io.github.pollen2.FirefoxTabs';
const INSTANCE_NAME = /^io\.github\.pollen2\.FirefoxTabs\.i(\d+)$/;
const OBJECT_PATH = '/io/github/pollen2/FirefoxTabs';
const INTERFACE = 'io.github.pollen2.FirefoxTabs1';
const CALL_TIMEOUT_MS = 6000;

class Instance {
    constructor(bus, name, pid, cancellable) {
        this._bus = bus;
        this._cancellable = cancellable;
        this.name = name;
        this.pid = pid;
        this.serial = 0;
        this.snapshot = null;
    }

    _call(method, params = null, replyType = null) {
        return this._bus.call(this.name, OBJECT_PATH, INTERFACE, method, params,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NO_AUTO_START, CALL_TIMEOUT_MS, this._cancellable);
    }

    // Returns true when the snapshot changed since the last refresh.
    async refresh() {
        const reply = await this._call('GetSnapshot', null, '(us)');
        const [serial, json] = reply.deepUnpack();
        if (serial === this.serial)
            return false;
        this.snapshot = JSON.parse(json);
        this.serial = serial;
        return true;
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
}

export class InstanceWatcher {
    constructor(onInstancesChanged) {
        this._bus = Gio.DBus.session;
        this._cancellable = new Gio.Cancellable();
        this._onInstancesChanged = onInstancesChanged;
        this.instances = new Map();

        this._subscription = this._bus.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', BUS_NAMESPACE, Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [name, , newOwner] = params.deepUnpack();
                this._update(name, newOwner !== '');
            });
        this._listExisting().catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error('firefox-tabs: listing bus names failed', e);
        });
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
        if (present)
            this.instances.set(name, new Instance(this._bus, name, Number(match[1]), this._cancellable));
        else
            this.instances.delete(name);
        this._onInstancesChanged();
    }

    destroy() {
        this._cancellable.cancel();
        this._bus.signal_unsubscribe(this._subscription);
        this.instances.clear();
    }
}
