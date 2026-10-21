# Firefox tabs in GNOME Shell

A top bar menu listing your open Firefox tabs, organized by window and tab
group. The top bar shows Firefox's icon and how many tabs are open. Click a
tab to switch to it. Middle-click it, click its ×, or press Delete to close
it.

Drag a tab to reorder it: drop it between two tabs (inside a group, it joins
the group), on a group's header to add it to that group, or on a window's
header to move it to the end of that window.

Right-click a tab (or press the Menu key or Shift+F10 on it) to move it: to
another window, to a new window, into a tab group or a new one, or out of its
group. Back, Left or Backspace return to the list.

Type to search: every word must appear in a tab's title or address, ignoring
case and accents. Enter switches to the first result, and Down moves into the
list.

To open the menu from the keyboard, set a shortcut in the extension's
preferences (`gnome-extensions prefs firefox-tabs@pollen2.github.io`). None is
set by default, so it can't clash with your existing shortcuts. The
preferences can also hide the tab count.

**Status: early development.** All the planned features work: switching,
closing, searching, moving and reordering tabs, favicons, and a keyboard
shortcut. Next comes packaging for extensions.gnome.org and
addons.mozilla.org.

## How it works

```
Firefox add-on ──native messaging──▶ firefox-tabs-host ──D-Bus──▶ GNOME Shell extension
(webext/)        (stdin/stdout)      (host/, Rust)                (shell-extension/)
```

- **The add-on** watches tab, window and tab group events. It sends a snapshot
  to the host about 150 ms after each change, and runs the host's commands
  (switch, close, move, group). Favicons are re-encoded as small PNGs that
  the host saves under `$XDG_RUNTIME_DIR/firefox-tabs/icons/`.
- **The host** is started by Firefox and exits with it. It keeps the latest
  snapshot and serves it on the session bus as
  `io.github.pollen2.FirefoxTabs.i<firefox pid>`. See
  [the interface](dbus/io.github.pollen2.FirefoxTabs1.xml) and
  [the snapshot format](docs/snapshot.md). It uses about 4 MB of memory and
  does nothing while idle.
- **The shell extension** fetches the snapshot when you open the menu. It
  runs no timers and does no polling: the tab count in the top bar is a D-Bus
  property the host only announces when it changes. It raises the Firefox window itself,
  because Firefox can't focus its own windows on Wayland. To find the right
  window it uses the window title and the order in which windows were last
  focused.

## Requirements

- GNOME Shell 48
- Firefox 139 or later, installed from your distribution or Mozilla's
  tarball. Snap and Flatpak builds can't start native hosts yet.

## Development setup

```sh
scripts/install-dev.sh
```

This builds the host (needs Rust), registers it with Firefox
(`~/.mozilla/native-messaging-hosts/`), and links the extension into
`~/.local/share/gnome-shell/extensions/`. Then:

1. Firefox: `about:debugging` → This Firefox → Load Temporary Add-on →
   `webext/manifest.json`
2. Log out and back in (needed on Wayland), then
   `gnome-extensions enable firefox-tabs@pollen2.github.io`

## Tests

```sh
cargo test --manifest-path host/Cargo.toml                 # host unit tests
GSETTINGS_BACKEND=memory gjs -m tests/accelerators.test.js # shortcut helpers
tests/headless/run.sh                                      # full stack in a throwaway headless GNOME Shell
```

`tests/headless/run.sh` starts a headless GNOME Shell on a private D-Bus
session with its own settings, so your session is not touched. It runs:

- `menu.sh`: menu behaviour, search and speed against a fake Firefox
  (`tests/headless/fake-firefox.py`, also handy for UI work without a browser).
- `actions.sh`: the right-click action view against the fake Firefox.
- `drag.sh`: drag and drop against the fake Firefox: which commands a drop
  sends, and cancelling.
- `shortcut.sh`: the keyboard shortcut, and setting it in the real
  preferences window from the keyboard.
- `raise.sh`: window raising and favicons against a real Firefox with a
  temporary profile.
- `move.sh`: moving tabs and groups through the menu, and by drag and drop,
  against a real Firefox.

The real-Firefox scenarios need `scripts/install-dev.sh` first.

Screenshots and logs end up in `tests/headless/out/`.

## License

GPL-3.0-or-later, see [LICENSE](LICENSE).
