//! Durable, owner-only file primitives for the files that hold key or
//! identity-binding material (`~/.motebit/config.json`,
//! `~/.motebit/dev-keyring.json`, `~/.motebit/keychain-index.json`).
//!
//! The three rules every caller relies on (the Rust twin of the CLI's
//! `apps/cli/src/durable-file.ts` and create-motebit's `config-file.ts`):
//!
//!  R1. Absence is not damage. Only a name that does not exist reads as
//!      absent. A dangling symlink, an unreadable file, or a directory where
//!      the file should be is damage: an `Err`, file untouched.
//!  R2. Damaged or replaced bytes are never destroyed. They are kept as a
//!      real, owner-only copy (or a hard link when the live name is about to
//!      be replaced by a rename), or the operation refuses.
//!  R3. Writes are staged owner-only from creation, fsync'd, renamed over the
//!      real target (symlinks resolved), and the directory fsync'd. A group-
//!      or world-readable file is narrowed on EVERY load, damaged or not.
//!
//! No Tauri types here: this module (and `config_file`, `key_store`) builds
//! and tests standalone, which is how the Linux behaviour is checked.

use std::io::Write;
use std::path::{Path, PathBuf};

/// `~/.motebit`, from `HOME`, else `USERPROFILE` (Windows sets only the latter).
pub fn motebit_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok().filter(|h| !h.is_empty()))
        .ok_or_else(|| "Cannot determine home directory (neither HOME nor USERPROFILE is set)".to_string())?;
    Ok(PathBuf::from(home).join(".motebit"))
}

/// Narrow a group/world-readable file to 0600. `Ok(true)` when it was
/// narrowed, `Ok(false)` when there was nothing to do (already owner-only,
/// absent, not a regular file, or not a Unix platform), `Err` when the chmod
/// itself failed — the caller reports it; a failed chmod never makes a read
/// fail. Follows a symlink to the file it names.
pub fn tighten_to_owner_only(path: &Path) -> Result<bool, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = match std::fs::metadata(path) {
            Ok(m) => m,
            Err(_) => return Ok(false),
        };
        if !meta.is_file() || meta.permissions().mode() & 0o077 == 0 {
            return Ok(false);
        }
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map(|()| true)
            .map_err(|e| {
                format!(
                    "{} is readable by other users (mode {:o}) and could not be narrowed to 0600: {}",
                    path.display(),
                    meta.permissions().mode() & 0o777,
                    e
                )
            })
    }
    #[cfg(not(unix))]
    {
        // Windows: owner-only rests on the %USERPROFILE% ACL (best effort;
        // there is no mode bit to narrow).
        let _ = path;
        Ok(false)
    }
}

fn narrow_and_report(path: &Path) {
    if let Err(e) = tighten_to_owner_only(path) {
        eprintln!("[motebit] WARNING: {}", e);
    }
}

/// R1 + R3 for one key-bearing file. `Ok(None)` only when the name does not
/// exist. Every other failure — a dangling symlink, EACCES, EISDIR, EIO — is
/// an `Err` naming the file, which is left untouched. The file is narrowed to
/// 0600 BEFORE it is read, so a damaged file is narrowed too, and a failed
/// narrowing is reported.
pub fn read_strict(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let lmeta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(format!(
                "{} could not be examined ({}). It has NOT been changed.",
                path.display(),
                e
            ))
        }
    };
    if lmeta.file_type().is_symlink() {
        if let Err(e) = std::fs::metadata(path) {
            return Err(format!(
                "{} is a symlink whose target cannot be reached ({}). That is damage, not absence: the key may live on the unreachable target. It has NOT been changed.",
                path.display(),
                e
            ));
        }
    }
    narrow_and_report(path);
    std::fs::read(path).map(Some).map_err(|e| {
        format!(
            "{} exists but could not be read ({}). It has NOT been changed.",
            path.display(),
            e
        )
    })
}

/// The backup timestamp, spelled exactly as the TypeScript writers spell it —
/// `new Date().toISOString()` with `:` and `.` replaced by `-`, e.g.
/// `2026-09-24T17-03-09-123Z` — so every writer's backups sort together.
pub fn backup_stamp(unix_millis: u128) -> String {
    let ms = (unix_millis % 1000) as u32;
    let secs = (unix_millis / 1000) as i64;
    let (days, sod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (H. Hinnant), proleptic Gregorian, UTC.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!(
        "{:04}-{:02}-{:02}T{:02}-{:02}-{:02}-{:03}Z",
        y,
        m,
        d,
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60,
        ms
    )
}

pub fn now_stamp() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    backup_stamp(millis)
}

/// How a preserved copy may be made.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Keep {
    /// The live name is replaced by a rename right after this call, so a hard
    /// link (a second name for the same inode) keeps the old bytes. Allowed
    /// to link, which is the only way to keep a file this process cannot read.
    LinkThenReplace,
    /// The live name SURVIVES this call (it is edited in place, or it may be
    /// by an older writer), so only a byte copy keeps the old bytes.
    CopyBytes,
}

/// R2. Keep `path`'s current bytes as `<name>.<tag>-<time>` beside it, owner-
/// only, durable (the backup's directory is fsync'd), and return the backup
/// path — or `Err` when that cannot be done, in which case the caller must
/// refuse. The REAL file is kept, never a symlink's name.
pub fn preserve_aside(path: &Path, tag: &str, keep: Keep) -> Result<PathBuf, String> {
    preserve_aside_with(path, tag, keep, owner_only_after_link)
}

/// `preserve_aside` with the post-link narrowing injected (a test seam: a
/// root-owned inode cannot be made in a unit test).
fn preserve_aside_with(
    path: &Path,
    tag: &str,
    keep: Keep,
    narrow_link: fn(&Path) -> bool,
) -> Result<PathBuf, String> {
    let stamp = now_stamp();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| format!("{} has no file name", path.display()))?;
    // Link or copy the REAL file: `hard_link` is linkat(…, 0) on Linux and
    // does not follow symlinks, so linking a symlinked file's NAME would make
    // the "backup" a second name for the link.
    let real = match std::fs::canonicalize(path) {
        Ok(r) => r,
        Err(e) => {
            let is_link = std::fs::symlink_metadata(path)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(true);
            if is_link {
                return Err(format!(
                    "could not resolve {} to preserve it ({}); nothing was changed",
                    path.display(),
                    e
                ));
            }
            path.to_path_buf()
        }
    };
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    let mut last_err = String::from("no backup name available");
    for n in 0..100u32 {
        let suffix = if n == 0 { String::new() } else { format!("-{}", n) };
        let backup = dir.join(format!("{}.{}-{}{}", name, tag, stamp, suffix));
        if keep == Keep::LinkThenReplace {
            match std::fs::hard_link(&real, &backup) {
                Ok(()) => {
                    if narrow_link(&backup) {
                        fsync_dir(dir)?;
                        return Ok(backup);
                    }
                    // The link shares an inode this process could not narrow
                    // (e.g. a root-owned file on macOS, which has no
                    // protected_hardlinks). Drop the link; fall back to a
                    // user-owned 0600 copy of the bytes.
                    let _ = std::fs::remove_file(&backup);
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => {}
            }
        }
        match copy_owner_only(&real, &backup) {
            Ok(()) => {
                fsync_dir(dir)?;
                return Ok(backup);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                last_err = e.to_string();
                break;
            }
        }
    }
    Err(format!(
        "could not preserve {} before replacing it ({}); nothing was changed",
        path.display(),
        last_err
    ))
}

/// A hard-linked backup is acceptable only when it ends up owner-only.
fn owner_only_after_link(backup: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::set_permissions(backup, std::fs::Permissions::from_mode(0o600)).is_err() {
            return false;
        }
        std::fs::metadata(backup)
            .map(|m| m.permissions().mode() & 0o077 == 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        let _ = backup;
        true
    }
}

/// Make a directory entry durable. On Unix a failure is an error (the
/// caller's preserved copy might not survive a crash); platforms that cannot
/// open a directory (Windows) skip it.
pub fn fsync_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::fs::File::open(dir)
            .and_then(|d| d.sync_all())
            .map_err(|e| format!("could not fsync directory {}: {}", dir.display(), e))
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

/// Copy `src` into a NEW file `dest`, owner-only from creation (create_new +
/// mode 0600), fsync'd; `dest` removed on failure.
pub fn copy_owner_only(src: &Path, dest: &Path) -> std::io::Result<()> {
    let bytes = std::fs::read(src)?;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(dest)?;
    let written = (|| -> std::io::Result<()> {
        file.write_all(&bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        file.sync_all()
    })();
    if let Err(e) = written {
        drop(file);
        let _ = std::fs::remove_file(dest);
        return Err(e);
    }
    Ok(())
}

/// Where a write to `requested` must land: the symlink's target when it is a
/// resolvable link (renaming over the link would orphan the real file), the
/// name itself when it does not exist, and `Err` for a dangling link (R1: the
/// key may be on the unreachable target; replacing the link would lose it).
pub fn resolve_write_target(requested: &Path) -> Result<PathBuf, String> {
    match std::fs::symlink_metadata(requested) {
        Ok(m) if m.file_type().is_symlink() => std::fs::canonicalize(requested).map_err(|e| {
            format!(
                "{} is a symlink whose target cannot be reached ({}); refusing to replace it. Nothing was changed.",
                requested.display(),
                e
            )
        }),
        Ok(_) => Ok(requested.to_path_buf()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(requested.to_path_buf()),
        Err(e) => Err(format!(
            "{} could not be examined ({}); nothing was changed",
            requested.display(),
            e
        )),
    }
}

/// R3. Stage → fsync → (precondition) → rename → fsync dir, owner-only from
/// creation. `precondition` runs after the staged copy is durable and just
/// before the rename; an `Err` from it aborts the write (the compare-and-swap
/// hook). The scratch copy is removed on every failure path.
pub fn write_file_atomic_owner_only(
    requested: &Path,
    contents: &[u8],
    precondition: Option<&dyn Fn() -> Result<(), String>>,
) -> Result<(), String> {
    let resolved = resolve_write_target(requested)?;
    let path = resolved.as_path();
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| format!("{} has no file name", path.display()))?;
    let staged = dir.join(format!("{}.{}.{}.tmp", name, std::process::id(), nonce));
    let result = (|| -> Result<(), String> {
        let io = |e: std::io::Error| format!("Failed to write {}: {}", path.display(), e);
        let mut opts = std::fs::OpenOptions::new();
        // create_new: the mode below applies only on creation, so the staged
        // name must be one that did not already exist.
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&staged).map_err(io)?;
        file.write_all(contents).map_err(io)?;
        #[cfg(unix)]
        {
            // Exact, not umask-narrowed.
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(io)?;
        }
        file.sync_all().map_err(io)?;
        drop(file);
        if let Some(check) = precondition {
            check()?;
        }
        std::fs::rename(&staged, path).map_err(io)
    })();
    if let Err(e) = result {
        // Never leave the scratch copy behind; it holds the same secrets.
        let _ = std::fs::remove_file(&staged);
        return Err(e);
    }
    // Durability of the rename itself. The rename already happened, so a
    // failure here is reported, not returned as a failed write.
    if let Err(e) = fsync_dir(dir) {
        eprintln!("[motebit] WARNING: {}", e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn scratch(tag: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "motebit-durable-{}-{}-{}",
            tag,
            std::process::id(),
            nonce
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[cfg(unix)]
    fn mode(p: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_is_damage_not_absence() {
        let dir = scratch("dangling");
        let link = dir.join("config.json");
        std::os::unix::fs::symlink(dir.join("unmounted/real.json"), &link).unwrap();
        let err = read_strict(&link).unwrap_err();
        assert!(err.contains("symlink"), "{err}");
        // …and a write refuses rather than renaming over the link.
        assert!(write_file_atomic_owner_only(&link, b"{}", None).is_err());
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(read_strict(&dir.join("absent.json")).unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_is_damage_and_a_0644_file_is_narrowed_on_read() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("unreadable");
        // EISDIR: a directory where the file should be.
        let as_dir = dir.join("dir.json");
        std::fs::create_dir(&as_dir).unwrap();
        assert!(read_strict(&as_dir).is_err());
        // A group/world-readable file is narrowed on read.
        let path = dir.join("config.json");
        std::fs::write(&path, "{\"cli_encrypted_key\":1}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        read_strict(&path).unwrap();
        assert_eq!(mode(&path), 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_hard_link_that_cannot_be_narrowed_is_replaced_by_an_owner_only_copy() {
        use std::os::unix::fs::MetadataExt;
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("link-narrow");
        let path = dir.join("config.json");
        std::fs::write(&path, "{OLD").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        // Simulate the macOS root-owned inode: the chmod on the link fails.
        let backup = preserve_aside_with(&path, "clobbered", Keep::LinkThenReplace, |_| false).unwrap();
        assert_ne!(
            std::fs::metadata(&backup).unwrap().ino(),
            std::fs::metadata(&path).unwrap().ino(),
            "the backup must be a copy, not a second name for the 0644 inode"
        );
        assert_eq!(mode(&backup), 0o600);
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "{OLD");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn preserve_by_copy_keeps_the_bytes_when_the_live_name_survives() {
        let dir = scratch("copybytes");
        let path = dir.join("dev-keyring.json");
        std::fs::write(&path, "OLD").unwrap();
        let backup = preserve_aside(&path, "preserved", Keep::CopyBytes).unwrap();
        // An in-place writer (an older CLI) rewrites the live name…
        std::fs::write(&path, "NEW").unwrap();
        // …and the preserved copy still holds the old bytes.
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "OLD");
        assert_eq!(mode(&backup), 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_copy_fallback_is_owner_only_from_creation_and_exclusive() {
        let dir = scratch("copy");
        let src = dir.join("src.json");
        let dest = dir.join("dest.json");
        std::fs::write(&src, "{bytes").unwrap();
        copy_owner_only(&src, &dest).unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "{bytes");
        #[cfg(unix)]
        assert_eq!(mode(&dest), 0o600);
        assert_eq!(
            copy_owner_only(&src, &dest).unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scratch_is_removed_when_the_replacement_fails() {
        let dir = scratch("fail");
        let path = dir.join("config.json");
        // A non-empty directory where the file should be: staging succeeds,
        // the rename cannot.
        std::fs::create_dir_all(path.join("occupied")).unwrap();
        assert!(write_file_atomic_owner_only(&path, b"{}", None).is_err());
        let strays: Vec<String> = entries(&dir)
            .into_iter()
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(strays.is_empty(), "stray scratch files: {strays:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_precondition_writes_nothing() {
        let dir = scratch("precondition");
        let path = dir.join("config.json");
        std::fs::write(&path, "{\"a\":1}").unwrap();
        let refuse = || Err("changed underneath".to_string());
        let err = write_file_atomic_owner_only(&path, b"{\"a\":2}", Some(&refuse)).unwrap_err();
        assert!(err.contains("changed underneath"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":1}");
        assert_eq!(entries(&dir), vec!["config.json".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn motebit_dir_falls_back_to_userprofile() {
        // Environment is process-global; this test only reads the resolution
        // rule through a pure helper-free check of both variables at once.
        let saved_home = std::env::var_os("HOME");
        let saved_profile = std::env::var_os("USERPROFILE");
        std::env::remove_var("HOME");
        std::env::set_var("USERPROFILE", "/tmp/motebit-userprofile-test");
        let got = motebit_dir();
        match saved_home {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }
        match saved_profile {
            Some(p) => std::env::set_var("USERPROFILE", p),
            None => std::env::remove_var("USERPROFILE"),
        }
        assert_eq!(
            got.unwrap(),
            PathBuf::from("/tmp/motebit-userprofile-test").join(".motebit")
        );
    }

    #[test]
    fn backup_stamp_matches_the_typescript_spelling() {
        // new Date(1790000000123).toISOString() === "2026-09-21T14:13:20.123Z"
        assert_eq!(backup_stamp(1_790_000_000_123), "2026-09-21T14-13-20-123Z");
        assert_eq!(backup_stamp(0), "1970-01-01T00-00-00-000Z");
        // A leap day, which is where hand-rolled calendars break.
        assert_eq!(backup_stamp(1_835_481_599_999), "2028-02-29T23-59-59-999Z");
    }
}
