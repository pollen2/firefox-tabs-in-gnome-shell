# Firefox tabs in GNOME Shell

A top bar menu listing your open Firefox tabs, organized by window and tab
group. Click a tab to switch to it. Middle-click it, click its ×, or press
Delete to close it.

**Status: early development.** Switching and closing tabs work, with favicons.
Search and moving tabs between windows and groups come next.

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
  runs no timers and does no polling. It raises the Firefox window itself,
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
cargo test --manifest-path host/Cargo.toml   # host unit tests
tests/headless/run.sh                        # full stack in a throwaway headless GNOME Shell
```

`tests/headless/run.sh` starts a headless GNOME Shell on a private D-Bus
session with its own settings, so your session is not touched. It runs:

- `menu.sh`: menu behaviour and speed against a fake Firefox
  (`tests/headless/fake-firefox.py`, also handy for UI work without a browser).
- `raise.sh`: window raising against a real Firefox with a temporary profile.
  Needs `scripts/install-dev.sh` first.

Screenshots and logs end up in `tests/headless/out/`.

## License

GPL-3.0-or-later, see [LICENSE](LICENSE).
