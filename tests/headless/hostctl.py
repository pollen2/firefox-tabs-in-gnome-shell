#!/usr/bin/env python3
"""Talks to the first running native host over D-Bus, like the shell does.

    hostctl.py name                 bus name, or nothing
    hostctl.py ids                  tab ids in snapshot order
    hostctl.py snapshot             readable dump
    hostctl.py group ID,ID          new group from these tabs
    hostctl.py new-window ID        move a tab to a new window
"""

import json
import sys

from gi.repository import Gio, GLib

PREFIX = 'io.github.pollen2.FirefoxTabs.i'
bus = Gio.bus_get_sync(Gio.BusType.SESSION)
names = [n for n in bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                                  'ListNames', None, None, 0, -1, None).unpack()[0] if n.startswith(PREFIX)]


def call(method, params=None):
    return bus.call_sync(names[0], '/io/github/pollen2/FirefoxTabs', 'io.github.pollen2.FirefoxTabs1',
                         method, params, None, 0, -1, None).unpack()


def snapshot():
    return json.loads(call('GetSnapshot')[1])


command = sys.argv[1]
if command == 'name':
    print(names[0] if names else '')
elif command == 'ids':
    print(' '.join(str(t['id']) for w in snapshot()['windows'] for t in w['tabs']))
elif command == 'snapshot':
    s = snapshot()
    for w in s['windows']:
        print(f"window {w['id']}")
        for t in w['tabs']:
            print(f"  tab {t['id']} group={t['groupId']} active={t.get('active', False)} {t['title'][:50]!r}")
    print('groups', s['groups'])
elif command == 'group':
    ids = [int(x) for x in sys.argv[2].split(',')]
    print(call('GroupTabs', GLib.Variant('(axxx)', (ids, -1, -1)))[0])
elif command == 'new-window':
    call('MoveTabToNewWindow', GLib.Variant('(x)', (int(sys.argv[2]),)))
else:
    sys.exit(f'unknown command {command}')
