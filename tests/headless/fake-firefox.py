#!/usr/bin/env python3
"""Stands in for Firefox: spawns the native host, feeds it a snapshot and
answers its commands, so the host and the shell extension can be developed
without a browser.

    tests/headless/fake-firefox.py [--tabs N] [--windows N] [host-binary]

Commands received from the host are logged to stderr.
"""

import argparse
import base64
import hashlib
import json
import os
import struct
import subprocess
import sys
import zlib

DEFAULT_HOST = os.path.join(os.path.dirname(__file__), '..', '..', 'host', 'target', 'release', 'firefox-tabs-host')
COLORS = ['blue', 'cyan', 'grey', 'green', 'orange', 'pink', 'purple', 'red', 'yellow']
# One favicon per fake site: a coloured disc.
SITE_COLORS = [(53, 132, 228), (46, 194, 126), (229, 165, 10), (224, 27, 36), (145, 65, 172), (38, 165, 196)]


def disc_png(rgb, size=32):
    rows = []
    for y in range(size):
        row = bytearray(b'\x00')
        for x in range(size):
            inside = (x - size / 2 + 0.5) ** 2 + (y - size / 2 + 0.5) ** 2 <= (size / 2 - 1) ** 2
            row += bytes(rgb) + (b'\xff' if inside else b'\x00')
        rows.append(bytes(row))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b''))


def make_icons():
    icons = []
    for rgb in SITE_COLORS:
        png = disc_png(rgb)
        icons.append((hashlib.sha256(png).hexdigest()[:32], png))
    return icons


def make_snapshot(n_windows, n_tabs, icons):
    windows, groups, tab_id = [], [], 1
    for w in range(1, n_windows + 1):
        tabs = []
        for i in range(n_tabs):
            group_id = -1
            if i % 10 >= 6:  # 40% of tabs in groups of 4
                group_id = w * 1000 + i // 10
                if not any(g['id'] == group_id for g in groups):
                    groups.append({'id': group_id, 'windowId': w, 'title': f'Group {group_id}',
                                   'color': COLORS[len(groups) % len(COLORS)]})
            tab = {'id': tab_id, 'title': f'Tab {tab_id} — window {w}', 'url': f'https://site{tab_id % 6}.example/{tab_id}',
                   'groupId': group_id, 'lastAccessed': tab_id, 'pinned': i < 2 or None,
                   'active': i == n_tabs - 1 or None, 'icon': icons[tab_id % len(icons)][0]}
            if i == 2:  # Firefox's own pages have no favicon
                tab.update(url='about:preferences', title='Settings', icon=None)
            tabs.append(tab)
            tab_id += 1
        windows.append({'id': w, 'tabs': tabs})
    return {'schema': 1, 'windows': windows, 'groups': groups}


def send(pipe, message):
    data = json.dumps(message, separators=(',', ':')).encode()
    pipe.write(struct.pack('=I', len(data)) + data)
    pipe.flush()


def receive(pipe):
    header = pipe.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack('=I', header)
    return json.loads(pipe.read(length))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--windows', type=int, default=2)
    parser.add_argument('--tabs', type=int, default=20, help='tabs per window')
    parser.add_argument('host', nargs='?', default=DEFAULT_HOST)
    args = parser.parse_args()

    icons = make_icons()
    snapshot = make_snapshot(args.windows, args.tabs, icons)
    tabs = {t['id']: (w['id'], t) for w in snapshot['windows'] for t in w['tabs']}
    host = subprocess.Popen([args.host, 'fake-manifest.json', 'firefox-tabs@pollen2.github.io'],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    print(f'host pid {host.pid}, bus name io.github.pollen2.FirefoxTabs.i{os.getpid()}', file=sys.stderr)
    for key, png in icons:
        send(host.stdin, {'type': 'icon', 'key': key, 'png': base64.b64encode(png).decode()})
    send(host.stdin, {'type': 'snapshot', 'data': snapshot})

    while (message := receive(host.stdout)) is not None:
        print('command:', json.dumps(message), file=sys.stderr)
        op, a = message['op'], message['args']
        reply = {'type': 'reply', 'id': message['id'], 'ok': True, 'result': None}
        if op == 'activate':
            if a['tabId'] in tabs:
                window_id, tab = tabs[a['tabId']]
                reply['result'] = {'id': tab['id'], 'windowId': window_id, 'title': tab['title']}
            else:
                reply.update(ok=False, error=f"Invalid tab ID: {a['tabId']}")
        elif op == 'group':
            reply['result'] = a['groupId'] if a['groupId'] != -1 else 99999
        send(host.stdin, reply)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
