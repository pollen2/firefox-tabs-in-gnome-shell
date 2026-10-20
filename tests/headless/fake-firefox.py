#!/usr/bin/env python3
"""Stands in for Firefox: spawns the native host, feeds it a snapshot and
answers its commands, so the host and the shell extension can be developed
without a browser.

    tests/headless/fake-firefox.py [--tabs N] [--windows N] [host-binary]

Commands received from the host are logged to stderr.
"""

import argparse
import json
import os
import struct
import subprocess
import sys

DEFAULT_HOST = os.path.join(os.path.dirname(__file__), '..', '..', 'host', 'target', 'release', 'firefox-tabs-host')
COLORS = ['blue', 'cyan', 'grey', 'green', 'orange', 'pink', 'purple', 'red', 'yellow']


def make_snapshot(n_windows, n_tabs):
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
            tabs.append({'id': tab_id, 'title': f'Tab {tab_id} — window {w}', 'url': f'https://example.com/{tab_id}',
                         'groupId': group_id, 'lastAccessed': tab_id, 'pinned': i < 2 or None,
                         'active': i == n_tabs - 1 or None})
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

    snapshot = make_snapshot(args.windows, args.tabs)
    tabs = {t['id']: (w['id'], t) for w in snapshot['windows'] for t in w['tabs']}
    host = subprocess.Popen([args.host, 'fake-manifest.json', 'firefox-tabs@pollen2.github.io'],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    print(f'host pid {host.pid}, bus name io.github.pollen2.FirefoxTabs.i{os.getpid()}', file=sys.stderr)
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
