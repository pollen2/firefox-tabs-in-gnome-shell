//! Favicon files for the shell: $XDG_RUNTIME_DIR/firefox-tabs/icons/<key>.png.
//!
//! The extension re-encodes every favicon to a small PNG and names it by a
//! hash of its content, so instances share files and each is written once.
//! The shell parses these files inside the compositor, so we only accept
//! small, well-formed-looking PNGs with a plain hex name.

use std::fs::{self, DirBuilder, File};
use std::io;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

const MAX_BYTES: usize = 64 * 1024;
const MAX_SIDE: u32 = 64;
const KEY_LENGTH: usize = 32;
/// Files not written or re-sent for this long are deleted when a host starts.
const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

pub struct IconStore {
    dir: PathBuf,
}

impl IconStore {
    pub fn open(dir: PathBuf) -> io::Result<Self> {
        DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
        let store = Self { dir };
        store.prune(SystemTime::now() - MAX_AGE);
        Ok(store)
    }

    pub fn store(&self, key: &str, png_base64: &str) -> Result<(), String> {
        if key.len() != KEY_LENGTH || !key.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(format!("bad icon key {key:?}"));
        }
        let png = STANDARD.decode(png_base64).map_err(|e| format!("icon {key}: {e}"))?;
        check_png(&png).map_err(|e| format!("icon {key}: {e}"))?;

        let path = self.dir.join(format!("{key}.png"));
        if path.exists() {
            // Still in use: keep it from being pruned.
            return File::open(&path)
                .and_then(|f| f.set_modified(SystemTime::now()))
                .map_err(|e| format!("icon {key}: {e}"));
        }
        // Write then rename, so the shell never reads a partial file.
        let temporary = self.dir.join(format!(".{key}.tmp"));
        fs::write(&temporary, &png)
            .and_then(|()| fs::rename(&temporary, &path))
            .map_err(|e| format!("icon {key}: {e}"))
    }

    fn prune(&self, older_than: SystemTime) {
        let Ok(entries) = fs::read_dir(&self.dir) else { return };
        for entry in entries.flatten() {
            let stale = entry.metadata().and_then(|m| m.modified()).is_ok_and(|t| t < older_than);
            if stale {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    #[cfg(test)]
    fn path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.png"))
    }
}

/// Signature, IHDR first, and small dimensions.
fn check_png(png: &[u8]) -> Result<(), &'static str> {
    if png.len() > MAX_BYTES {
        return Err("too large");
    }
    if png.len() < 24 || !png.starts_with(PNG_SIGNATURE) || &png[12..16] != b"IHDR" {
        return Err("not a PNG");
    }
    let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
    if width == 0 || height == 0 || width > MAX_SIDE || height > MAX_SIDE {
        return Err("bad dimensions");
    }
    Ok(())
}

pub fn default_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_RUNTIME_DIR").map(|d| Path::new(&d).join("firefox-tabs").join("icons"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "0123456789abcdef0123456789abcdef";

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut png = PNG_SIGNATURE.to_vec();
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&width.to_be_bytes());
        png.extend_from_slice(&height.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        png
    }

    fn store(name: &str) -> IconStore {
        let dir = std::env::temp_dir().join(format!("firefox-tabs-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        IconStore::open(dir).unwrap()
    }

    #[test]
    fn stores_valid_icon_once() {
        let store = store("valid");
        let data = STANDARD.encode(png(32, 32));
        store.store(KEY, &data).unwrap();
        assert_eq!(fs::read(store.path(KEY)).unwrap(), png(32, 32));
        store.store(KEY, &data).unwrap();
        fs::remove_dir_all(&store.dir).unwrap();
    }

    #[test]
    fn rejects_bad_keys_and_data() {
        let store = store("invalid");
        let data = STANDARD.encode(png(32, 32));
        assert!(store.store("../../etc/passwd", &data).is_err());
        assert!(store.store(&KEY.to_uppercase(), &data).is_err());
        assert!(store.store(KEY, &STANDARD.encode(b"<svg/>")).is_err());
        assert!(store.store(KEY, &STANDARD.encode(png(4096, 32))).is_err());
        assert!(store.store(KEY, "not base64!").is_err());
        assert!(!store.path(KEY).exists());
        fs::remove_dir_all(&store.dir).unwrap();
    }

    #[test]
    fn prunes_old_files_only() {
        let store = store("prune");
        store.store(KEY, &STANDARD.encode(png(16, 16))).unwrap();
        store.prune(SystemTime::now() - Duration::from_secs(60));
        assert!(store.path(KEY).exists());
        store.prune(SystemTime::now() + Duration::from_secs(60));
        assert!(!store.path(KEY).exists());
        fs::remove_dir_all(&store.dir).unwrap();
    }
}
