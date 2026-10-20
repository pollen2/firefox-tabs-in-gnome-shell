'use strict';

const HOST = 'io.github.pollen2.firefox_tabs';
const SNAPSHOT_DELAY_MS = 150;
const MAX_URL_LENGTH = 300;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 60000;

// Only these tab changes are visible in the menu; the rest (loading status,
// audio, reader mode...) would wake us up for nothing.
const WATCHED_PROPERTIES = [
    'title', 'url', 'pinned', 'groupId', 'hidden', 'discarded',
    'favIconUrl', 'audible', 'mutedInfo',
];

let port = null;
let reconnectDelay = RECONNECT_MIN_MS;
let snapshotTimer = null;
// Window ids, most recently focused first. The shell lines this up with its
// own focus order to tell apart windows whose titles are identical.
let focusOrder = [];

function connect() {
    port = browser.runtime.connectNative(HOST);
    port.onMessage.addListener(onHostMessage);
    port.onDisconnect.addListener(p => {
        console.warn(`native host disconnected: ${p.error?.message ?? 'exited'}`);
        port = null;
        clearTimeout(snapshotTimer);
        snapshotTimer = null;
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    });
    scheduleSnapshot(0);
}

function send(message) {
    port?.postMessage(message);
}

function scheduleSnapshot(delay = SNAPSHOT_DELAY_MS) {
    if (!port || snapshotTimer !== null)
        return;
    snapshotTimer = setTimeout(async () => {
        snapshotTimer = null;
        try {
            send({type: 'snapshot', data: await buildSnapshot()});
        } catch (e) {
            console.error('snapshot failed', e);
        }
    }, delay);
}

function tabInfo(tab) {
    const info = {
        id: tab.id,
        title: tab.title,
        url: tab.url?.length > MAX_URL_LENGTH ? tab.url.slice(0, MAX_URL_LENGTH) : tab.url,
        groupId: tab.groupId ?? -1,
        lastAccessed: tab.lastAccessed,
    };
    // Omit false flags to keep the snapshot small.
    if (tab.active)
        info.active = true;
    if (tab.pinned)
        info.pinned = true;
    if (tab.audible)
        info.audible = true;
    if (tab.mutedInfo?.muted)
        info.muted = true;
    if (tab.discarded)
        info.discarded = true;
    return info;
}

async function buildSnapshot() {
    const [windows, groups] = await Promise.all([
        browser.windows.getAll({populate: true, windowTypes: ['normal']}),
        browser.tabGroups?.query({}) ?? [],
    ]);
    return {
        schema: 1,
        windows: windows.map(w => ({
            id: w.id,
            incognito: w.incognito || undefined,
            // Tabs hidden by other extensions (tabs.hide) stay hidden here too.
            tabs: w.tabs.filter(t => !t.hidden).map(tabInfo),
        })),
        groups: groups.map(g => ({
            id: g.id,
            windowId: g.windowId,
            title: g.title,
            color: g.color,
            collapsed: g.collapsed || undefined,
        })),
    };
}

const commands = {
    async activate({tabId}) {
        const tab = await browser.tabs.update(tabId, {active: true});
        // The window itself is raised by the shell: on Wayland Firefox can't
        // take focus on its own and would only show a "ready" notification.
        return {id: tab.id, windowId: tab.windowId, title: tab.title, focusOrder};
    },
    async close({tabIds}) {
        await browser.tabs.remove(tabIds);
    },
    async move({tabIds, windowId, index}) {
        await browser.tabs.move(tabIds, {windowId, index});
    },
    async newWindow({tabId}) {
        await browser.windows.create({tabId});
    },
    async group({tabIds, groupId, windowId}) {
        const options = {tabIds};
        if (groupId !== -1)
            options.groupId = groupId;
        else if (windowId !== -1)
            options.createProperties = {windowId};
        return await browser.tabs.group(options);
    },
    async ungroup({tabIds}) {
        await browser.tabs.ungroup(tabIds);
    },
};

async function onHostMessage(message) {
    reconnectDelay = RECONNECT_MIN_MS;
    if (message.type !== 'command')
        return;
    const {id, op, args} = message;
    try {
        const handler = commands[op];
        if (!handler)
            throw new Error(`unknown command ${op}`);
        send({type: 'reply', id, ok: true, result: await handler(args) ?? null});
    } catch (e) {
        send({type: 'reply', id, ok: false, error: String(e?.message ?? e)});
    }
}

const onChange = () => scheduleSnapshot();
browser.tabs.onCreated.addListener(onChange);
browser.tabs.onRemoved.addListener(onChange);
browser.tabs.onMoved.addListener(onChange);
browser.tabs.onAttached.addListener(onChange);
browser.tabs.onDetached.addListener(onChange);
browser.tabs.onActivated.addListener(onChange);
browser.tabs.onReplaced.addListener(onChange);
browser.tabs.onUpdated.addListener(onChange, {properties: WATCHED_PROPERTIES});
browser.windows.onCreated.addListener(onChange);
browser.windows.onRemoved.addListener(onChange);
if (browser.tabGroups) {
    browser.tabGroups.onCreated.addListener(onChange);
    browser.tabGroups.onUpdated.addListener(onChange);
    browser.tabGroups.onRemoved.addListener(onChange);
    browser.tabGroups.onMoved.addListener(onChange);
}

// Focus changes only update focusOrder; they don't need a new snapshot.
browser.windows.onFocusChanged.addListener(windowId => {
    if (windowId !== browser.windows.WINDOW_ID_NONE)
        focusOrder = [windowId, ...focusOrder.filter(id => id !== windowId)];
});
browser.windows.onRemoved.addListener(windowId => {
    focusOrder = focusOrder.filter(id => id !== windowId);
});
browser.windows.getAll({windowTypes: ['normal']}).then(windows => {
    const known = new Set(focusOrder);
    const focused = windows.filter(w => w.focused && !known.has(w.id)).map(w => w.id);
    const rest = windows.filter(w => !w.focused && !known.has(w.id)).map(w => w.id);
    focusOrder = [...focusOrder, ...focused, ...rest];
});

connect();
