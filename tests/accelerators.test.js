// Unit tests for the preferences' shortcut helpers. Uses GNOME's default
// shortcuts, not yours:
//
//   GSETTINGS_BACKEND=memory gjs -m tests/accelerators.test.js

import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import System from 'system';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const {interpretKeyPress, findConflict, describe} = await import(
    `file://${here}/../shell-extension/firefox-tabs@pollen2.github.io/accelerators.js`);

const M = Gdk.ModifierType;
let failed = 0;
function expect(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    print(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
    failed += ok ? 0 : 1;
}

expect('Super+T is accepted', interpretKeyPress(Gdk.KEY_t, M.SUPER_MASK), {accelerator: '<Super>t'});
expect('Shift is kept and the letter lowercased', interpretKeyPress(Gdk.KEY_T, M.SUPER_MASK | M.SHIFT_MASK),
    {accelerator: '<Shift><Super>t'});
expect('a plain letter is not accepted', interpretKeyPress(Gdk.KEY_t, 0), null);
expect('a function key works alone', interpretKeyPress(Gdk.KEY_F9, 0), {accelerator: 'F9'});
expect('a lone modifier keeps waiting', interpretKeyPress(Gdk.KEY_Super_L, M.SUPER_MASK), null);
expect('Escape cancels', interpretKeyPress(Gdk.KEY_Escape, 0), {cancel: true});
expect('Backspace clears', interpretKeyPress(Gdk.KEY_BackSpace, 0), {clear: true});
expect('Ctrl+Backspace is a shortcut, not clear', interpretKeyPress(Gdk.KEY_BackSpace, M.CONTROL_MASK),
    {accelerator: '<Control>BackSpace'});

expect('a GNOME shortcut is reported', findConflict('<Alt>Tab') !== null, true);
expect('a free combination is not', findConflict('<Super><Shift>period'), null);

expect('labels read like GNOME Settings', describe('<Control><Alt>k'), 'Ctrl+Alt+K');
expect('no shortcut has no label', describe(undefined), null);

if (failed)
    System.exit(1);
