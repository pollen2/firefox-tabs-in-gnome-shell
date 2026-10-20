// Shortcut handling for the preferences window (GTK side only).

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

// GNOME's own shortcuts; a combination already bound there would not reach us.
const SHORTCUT_SCHEMAS = [
    'org.gnome.desktop.wm.keybindings',
    'org.gnome.shell.keybindings',
    'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings',
    'org.gnome.settings-daemon.plugins.media-keys',
];

const isFunctionKey = keyval => keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35;

// What a key press in the capture dialog means:
//   {cancel: true}            Escape
//   {clear: true}             BackSpace: remove the shortcut
//   {accelerator: '<Super>t'} a usable combination
//   null                      keep waiting (a lone modifier, or a key that
//                             needs one)
export function interpretKeyPress(keyval, state) {
    const mods = state & Gtk.accelerator_get_default_mod_mask();
    if (mods === 0 && keyval === Gdk.KEY_Escape)
        return {cancel: true};
    if (mods === 0 && keyval === Gdk.KEY_BackSpace)
        return {clear: true};
    const lower = Gdk.keyval_to_lower(keyval);
    // A plain letter would make that letter untypeable everywhere.
    if (!Gtk.accelerator_valid(lower, mods) || (mods === 0 && !isFunctionKey(lower)))
        return null;
    return {accelerator: Gtk.accelerator_name(lower, mods)};
}

// Returns the name of the GNOME shortcut already using `accelerator`, or null.
export function findConflict(accelerator) {
    const [, keyval, mods] = Gtk.accelerator_parse(accelerator);
    const source = Gio.SettingsSchemaSource.get_default();
    for (const id of SHORTCUT_SCHEMAS) {
        const schema = source?.lookup(id, true);
        if (!schema)
            continue;
        const settings = new Gio.Settings({settings_schema: schema});
        for (const key of schema.list_keys()) {
            const type = schema.get_key(key).get_value_type().dup_string();
            const values = type === 'as' ? settings.get_strv(key) : type === 's' ? [settings.get_string(key)] : [];
            for (const value of values) {
                const [ok, otherKeyval, otherMods] = Gtk.accelerator_parse(value);
                if (ok && otherKeyval === keyval && otherMods === mods)
                    return schema.get_key(key).get_summary() || key;
            }
        }
    }
    return null;
}

// "Super+T" style text for a stored accelerator, or null if unset.
export function describe(accelerator) {
    if (!accelerator)
        return null;
    const [ok, keyval, mods] = Gtk.accelerator_parse(accelerator);
    return ok ? Gtk.accelerator_get_label(keyval, mods) : null;
}
