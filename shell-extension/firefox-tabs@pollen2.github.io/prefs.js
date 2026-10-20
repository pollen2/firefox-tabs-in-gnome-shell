import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk?version=4.0';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {describe, findConflict, interpretKeyPress} from './accelerators.js';

const SHORTCUT_KEY = 'toggle-menu';

export default class FirefoxTabsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const row = new Adw.ActionRow({
            title: 'Open the tab menu',
            subtitle: 'Works anywhere in GNOME while Firefox is running',
            activatable: true,
        });
        const label = new Gtk.Label({valign: Gtk.Align.CENTER});
        const clear = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: 'Remove shortcut',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        row.add_suffix(label);
        row.add_suffix(clear);

        const sync = () => {
            const text = describe(settings.get_strv(SHORTCUT_KEY)[0]);
            label.label = text ?? 'Disabled';
            label.css_classes = text ? [] : ['dim-label'];
            clear.visible = text !== null;
        };
        settings.connect(`changed::${SHORTCUT_KEY}`, sync);
        sync();
        clear.connect('clicked', () => settings.set_strv(SHORTCUT_KEY, []));
        row.connect('activated', () => this._captureShortcut(window, settings));

        const group = new Adw.PreferencesGroup({title: 'Keyboard'});
        group.add(row);
        const page = new Adw.PreferencesPage();
        page.add(group);
        window.add(page);
    }

    _captureShortcut(window, settings) {
        const status = new Adw.StatusPage({
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            title: 'Press the new shortcut',
            description: 'Escape to cancel, Backspace to remove the shortcut',
        });
        const view = new Adw.ToolbarView({content: status});
        view.add_top_bar(new Adw.HeaderBar());
        const dialog = new Adw.Dialog({title: 'Set Shortcut', content_width: 420, child: view});

        const keys = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        keys.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            const result = interpretKeyPress(keyval, state);
            if (result?.cancel) {
                dialog.close();
            } else if (result?.clear) {
                settings.set_strv(SHORTCUT_KEY, []);
                dialog.close();
            } else if (result) {
                const conflict = findConflict(result.accelerator);
                if (conflict) {
                    status.description = `${describe(result.accelerator)} is already used by GNOME: “${conflict}”. Try another combination.`;
                } else {
                    settings.set_strv(SHORTCUT_KEY, [result.accelerator]);
                    dialog.close();
                }
            }
            return true;
        });
        dialog.add_controller(keys);
        dialog.present(window);
    }
}
