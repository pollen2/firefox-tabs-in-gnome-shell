'use strict';

const HOST = 'io.github.pollen2.firefox_tabs';
const SNAPSHOT_DELAY_MS = 150;
const MAX_URL_LENGTH = 300;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 60000;
// Covers 1× and 2× scaling of the menu's 16 px icons.
const ICON_SIZE = 32;

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
// favIconUrl -> key of the PNG sent to the current host, or null while it is
// being converted (or if it couldn't be).
let icons = new Map();

function connect() {
    // A new host may have pruned files: send icons again.
    icons = new Map();
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
            const data = await buildSnapshot();
            const tabCount = data.windows.reduce((sum, w) => sum + w.tabs.length, 0);
            send({type: 'snapshot', data, tabCount});
        } catch (e) {
            console.error('snapshot failed', e);
        }
    }, delay);
}

// Re-encodes a favicon as a small PNG named by its hash, and sends it to the
// host. The shell then only ever parses PNGs that Firefox's own encoder made.
async function convertIcon(url) {
    const image = new Image();
    image.src = url;
    await image.decode();
    // SVGs without intrinsic size report 0: draw them square.
    const scale = ICON_SIZE / Math.max(image.naturalWidth, image.naturalHeight, 1);
    const width = image.naturalWidth ? image.naturalWidth * scale : ICON_SIZE;
    const height = image.naturalHeight ? image.naturalHeight * scale : ICON_SIZE;
    const canvas = new OffscreenCanvas(ICON_SIZE, ICON_SIZE);
    canvas.getContext('2d').drawImage(image, (ICON_SIZE - width) / 2, (ICON_SIZE - height) / 2, width, height);

    const blob = await canvas.convertToBlob({type: 'image/png'});
    const png = new Uint8Array(await blob.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', png));
    const key = Array.from(digest.subarray(0, 16), b => b.toString(16).padStart(2, '0')).join('');
    send({type: 'icon', key, png: png.toBase64()});
    return key;
}

// Returns the icon's key once converted; until then the tab goes without and
// a new snapshot follows the conversion. Only data: URIs are converted: that
// is what Firefox gives for web pages, and other schemes would need host
// permissions (http) or can't be read at all (chrome).
function iconKey(url) {
    if (!url?.startsWith('data:image/'))
        return undefined;
    if (!icons.has(url)) {
        const map = icons;
        map.set(url, null);
        convertIcon(url).then(key => {
            map.set(url, key);
            scheduleSnapshot();
        }, e => console.warn(`favicon conversion failed: ${e}`));
    }
    return icons.get(url) ?? undefined;
}

function tabInfo(tab) {
    const info = {
        id: tab.id,
        index: tab.index,
        title: tab.title,
        url: tab.url?.length > MAX_URL_LENGTH ? tab.url.slice(0, MAX_URL_LENGTH) : tab.url,
        groupId: tab.groupId ?? -1,
        lastAccessed: tab.lastAccessed,
        icon: iconKey(tab.favIconUrl),
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
    // Forget icons no open tab uses any more.
    const inUse = new Set(windows.flatMap(w => w.tabs.map(t => t.favIconUrl)));
    for (const url of icons.keys()) {
        if (!inUse.has(url))
            icons.delete(url);
    }
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
