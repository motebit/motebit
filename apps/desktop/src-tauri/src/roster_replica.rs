//! The desktop's machine-roster replica, `~/.motebit/machine-roster.desktop.json`
//! (`docs/proposals/machine-roster-surfaces-v1.md` S3, §1A F3/F4, §1B R3/R4).
//!
//! The desktop is its only writer; the CLI's `machine-roster.json` is never
//! touched. The file holds one replica per motebit id (the TypeScript side
//! parses and merges; this module only moves bytes durably). Two primitives:
//!
//!  - **Compare-and-swap** (`cas_write_at`). A write names the digest of the
//!    bytes it merged over (`None` = the name was absent). Under an
//!    in-process mutex AND an OS file lock on `<file>.lock`, the current bytes
//!    are re-read; a different digest refuses with `CONFLICT`, and the
//!    TypeScript side re-reads, re-merges and tries again. A second desktop
//!    process (a runtime-host frontend) therefore can never write over a
//!    retirement it did not see. The write is the durable-file R3 write
//!    (staged owner-only → fsync → rename → fsync dir), so a crash between
//!    the staged write and the rename leaves the prior replica at the name.
//!    `aside = true` keeps the current (unreadable) bytes as
//!    `<file>.corrupt-<time>` BEFORE the rename (R3; durable-file R2).
//!
//!  - **The `exclusive` lease** (`Leases`). The kit's `exclusive` runs
//!    arbitrary TypeScript (read, decide, sign, save, present), so it cannot
//!    be one Rust command (R4). It is an OS file lock on `<file>.lease` held
//!    by this process, with an owner token and a timeout: a lease held by a
//!    webview that reloaded (or by a hung section) is released by the timer,
//!    at most `ttl` later (120 s by default; the reloaded webview's own act
//!    gives up after 30 s and fails closed); a crashed process is released by
//!    the OS. Only the token's holder may release it.
//!
//! `std::fs::File::lock` / `try_lock` (Rust 1.89, `rust-version` in
//! Cargo.toml checks it at build) is `flock` on Unix and `LockFileEx` on
//! Windows. No Tauri types here, so this module builds and tests standalone.

use crate::durable_file::{self, Keep};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

pub const REPLICA_FILE: &str = "machine-roster.desktop.json";
/// The refusal a stale compare-and-swap gets; the TypeScript side retries on it.
pub const CONFLICT: &str = "roster_replica_conflict";
/// How long a CAS waits for another process's (brief) file lock.
const LOCK_WAIT: Duration = Duration::from_secs(2);
/// Bounds on a lease's timeout.
const LEASE_MIN: Duration = Duration::from_secs(1);
const LEASE_MAX: Duration = Duration::from_secs(600);

/// Serializes this process's CAS writers in front of the OS lock.
static REPLICA_LOCK: Mutex<()> = Mutex::new(());

pub fn replica_path() -> Result<PathBuf, String> {
    Ok(durable_file::motebit_dir()?.join(REPLICA_FILE))
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

/// What is at the name: nothing, text (with its digest), or bytes that are
/// not text (corrupt to the reader, but still digested so it can be kept
/// aside under compare-and-swap).
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReplicaBytes {
    Absent,
    Text { digest: String, contents: String },
    Unreadable { digest: String },
}

pub fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

/// R1: only a true absence is `Absent`; damage is an `Err`, untouched.
pub fn read_at(path: &Path) -> Result<ReplicaBytes, String> {
    Ok(match durable_file::read_strict(path)? {
        None => ReplicaBytes::Absent,
        Some(bytes) => {
            let d = digest(&bytes);
            match String::from_utf8(bytes) {
                Ok(contents) => ReplicaBytes::Text {
                    digest: d,
                    contents,
                },
                Err(_) => ReplicaBytes::Unreadable { digest: d },
            }
        }
    })
}

fn open_lock_file(path: &Path) -> Result<File, String> {
    let mut opts = OpenOptions::new();
    opts.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
        .map_err(|e| format!("could not open the roster lock {}: {}", path.display(), e))
}

fn lock_poisoned<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Hold the OS lock on `lock_path` (waiting at most `LOCK_WAIT`) around `f`.
fn with_file_lock<T>(lock_path: &Path, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let file = open_lock_file(lock_path)?;
    let deadline = Instant::now() + LOCK_WAIT;
    loop {
        match file.try_lock() {
            Ok(()) => break,
            Err(TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return Err(format!(
                        "the machine roster is being written by another process ({} is held)",
                        lock_path.display()
                    ));
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(TryLockError::Error(e)) => {
                return Err(format!("could not lock {}: {}", lock_path.display(), e))
            }
        }
    }
    let out = f();
    let _ = file.unlock();
    out
}

/// Compare-and-swap `contents` over the bytes whose digest is `expected`
/// (`None`: the name must be absent). See the module header.
/// `before_rename` is the crash seam: it runs after the staged copy is
/// durable and just before the rename (tests only).
pub fn cas_write_at(
    path: &Path,
    expected: Option<&str>,
    contents: &str,
    aside: bool,
    before_rename: Option<&dyn Fn() -> Result<(), String>>,
) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    durable_file::mkdir_owner_only(dir)?;
    let _g = lock_poisoned(&REPLICA_LOCK);
    with_file_lock(&sibling(path, ".lock"), || {
        let current = durable_file::read_strict(path)?;
        let now = current.as_deref().map(digest);
        if now.as_deref() != expected {
            return Err(CONFLICT.to_string());
        }
        if aside && current.is_some() {
            // R3: the unreadable bytes are kept BEFORE the name is replaced;
            // if they cannot be kept, nothing is written.
            durable_file::preserve_aside(path, "corrupt", Keep::LinkThenReplace)?;
        }
        durable_file::write_file_atomic_owner_only(path, contents.as_bytes(), before_rename)
    })
}

// ── The exclusive lease (R4) ──────────────────────────────────────────

struct Lease {
    token: String,
    file: File,
}

/// One lease slot per lease file. The process-wide instance is `LEASES`;
/// tests build their own.
pub struct Leases {
    path: PathBuf,
    slot: Mutex<Option<Lease>>,
}

static TOKENS: AtomicU64 = AtomicU64::new(0);

fn new_token() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = TOKENS.fetch_add(1, Ordering::Relaxed);
    digest(format!("{}:{}:{}", std::process::id(), nanos, n).as_bytes())[..32].to_string()
}

impl Leases {
    pub fn new(path: PathBuf) -> Arc<Self> {
        Arc::new(Leases {
            path,
            slot: Mutex::new(None),
        })
    }

    /// `Some(token)` when the lease was taken; `None` when another holder
    /// (this process or another) has it. Never blocks.
    pub fn acquire(self: &Arc<Self>, ttl: Duration) -> Result<Option<String>, String> {
        let ttl = ttl.clamp(LEASE_MIN, LEASE_MAX);
        let mut slot = lock_poisoned(&self.slot);
        if slot.is_some() {
            return Ok(None);
        }
        if let Some(dir) = self.path.parent() {
            durable_file::mkdir_owner_only(dir)?;
        }
        let file = open_lock_file(&self.path)?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Ok(None),
            Err(TryLockError::Error(e)) => {
                return Err(format!("could not lock {}: {}", self.path.display(), e))
            }
        }
        let token = new_token();
        *slot = Some(Lease {
            token: token.clone(),
            file,
        });
        drop(slot);
        // The timeout: a holder that never releases (a reloaded webview, a
        // hung section) loses the lease after `ttl`.
        let me = Arc::clone(self);
        let mine = token.clone();
        std::thread::spawn(move || {
            std::thread::sleep(ttl);
            me.release(&mine);
        });
        Ok(Some(token))
    }

    /// Release the lease iff `token` holds it. `false`: it had expired, or
    /// was never this caller's.
    pub fn release(&self, token: &str) -> bool {
        let mut slot = lock_poisoned(&self.slot);
        if slot.as_ref().map(|l| l.token == token) != Some(true) {
            return false;
        }
        if let Some(lease) = slot.take() {
            let _ = lease.file.unlock();
        }
        true
    }
}

/// The process-wide lease on `~/.motebit/machine-roster.desktop.json.lease`.
pub static LEASES: LazyLock<Result<Arc<Leases>, String>> =
    LazyLock::new(|| replica_path().map(|p| Leases::new(sibling(&p, ".lease"))));

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "motebit-roster-{}-{}-{}",
            tag,
            std::process::id(),
            nonce
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn text(path: &Path) -> (String, String) {
        match read_at(path).unwrap() {
            ReplicaBytes::Text { digest, contents } => (digest, contents),
            other => panic!("expected text, got {:?}", other),
        }
    }

    #[test]
    fn a_write_expecting_absence_creates_the_file_and_a_second_is_a_conflict() {
        let dir = scratch("create");
        let path = dir.join(REPLICA_FILE);
        assert_eq!(read_at(&path).unwrap(), ReplicaBytes::Absent);
        cas_write_at(&path, None, "{\"a\":1}", false, None).unwrap();
        let (d, c) = text(&path);
        assert_eq!(c, "{\"a\":1}");
        assert_eq!(d, digest(b"{\"a\":1}"));
        // Another writer that also read "absent" loses: it must re-read.
        assert_eq!(
            cas_write_at(&path, None, "{\"b\":2}", false, None),
            Err(CONFLICT.to_string())
        );
        assert_eq!(text(&path).1, "{\"a\":1}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stale_digest_is_refused_and_leaves_the_newer_bytes() {
        let dir = scratch("stale");
        let path = dir.join(REPLICA_FILE);
        cas_write_at(&path, None, "v1", false, None).unwrap();
        let d1 = text(&path).0;
        cas_write_at(&path, Some(&d1), "v2", false, None).unwrap();
        // A writer that merged over v1 (and so never saw v2) is refused.
        assert_eq!(
            cas_write_at(&path, Some(&d1), "v1+x", false, None),
            Err(CONFLICT.to_string())
        );
        assert_eq!(text(&path).1, "v2");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_writers_each_land_exactly_once_through_retries() {
        // Eight threads append their tag by read → merge → CAS, retrying on
        // conflict. Every tag must survive: nothing is written over unseen.
        let dir = scratch("race");
        let path = Arc::new(dir.join(REPLICA_FILE));
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let path = Arc::clone(&path);
                std::thread::spawn(move || loop {
                    let (expected, base) = match read_at(&path).unwrap() {
                        ReplicaBytes::Absent => (None, String::new()),
                        ReplicaBytes::Text { digest, contents } => (Some(digest), contents),
                        ReplicaBytes::Unreadable { .. } => panic!("unreadable"),
                    };
                    let next = format!("{}[{}]", base, i);
                    match cas_write_at(&path, expected.as_deref(), &next, false, None) {
                        Ok(()) => break,
                        Err(e) if e == CONFLICT => continue,
                        Err(e) => panic!("{}", e),
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let (_, contents) = text(&path);
        for i in 0..8 {
            assert!(
                contents.contains(&format!("[{}]", i)),
                "lost writer {}: {}",
                i,
                contents
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_crash_between_the_staged_write_and_the_rename_leaves_the_prior_replica() {
        let dir = scratch("crash");
        let path = dir.join(REPLICA_FILE);
        cas_write_at(&path, None, "prior", false, None).unwrap();
        let d = text(&path).0;
        let crash = || -> Result<(), String> { Err("simulated crash before rename".to_string()) };
        let got = cas_write_at(&path, Some(&d), "next", false, Some(&crash));
        assert!(got.is_err());
        assert_eq!(text(&path), (d.clone(), "prior".to_string()));
        // A real crash leaves the staged file behind: the name still reads
        // the prior replica, and the next CAS over it succeeds.
        std::fs::write(dir.join(format!("{}.1.2.tmp", REPLICA_FILE)), "next").unwrap();
        assert_eq!(text(&path).1, "prior");
        cas_write_at(&path, Some(&d), "next", false, None).unwrap();
        assert_eq!(text(&path).1, "next");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_bytes_are_kept_aside_before_they_are_replaced() {
        let dir = scratch("aside");
        let path = dir.join(REPLICA_FILE);
        std::fs::write(&path, [0xff, 0xfe, 0x00, 0x01]).unwrap();
        let d = match read_at(&path).unwrap() {
            ReplicaBytes::Unreadable { digest } => digest,
            other => panic!("expected unreadable, got {:?}", other),
        };
        cas_write_at(&path, Some(&d), "{}", true, None).unwrap();
        assert_eq!(text(&path).1, "{}");
        let kept: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.to_string_lossy().contains(".corrupt-"))
            .collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(
            std::fs::read(&kept[0]).unwrap(),
            vec![0xff, 0xfe, 0x00, 0x01]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn another_process_holding_the_file_lock_blocks_the_write_and_nothing_changes() {
        let dir = scratch("oslock");
        let path = dir.join(REPLICA_FILE);
        cas_write_at(&path, None, "prior", false, None).unwrap();
        let d = text(&path).0;
        // A second open file description stands in for a second process.
        let other = open_lock_file(&sibling(&path, ".lock")).unwrap();
        other.lock().unwrap();
        let got = cas_write_at(&path, Some(&d), "next", false, None);
        assert!(got.unwrap_err().contains("another process"));
        assert_eq!(text(&path).1, "prior");
        other.unlock().unwrap();
        cas_write_at(&path, Some(&d), "next", false, None).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_lease_excludes_until_released_and_only_its_token_releases_it() {
        let dir = scratch("lease");
        let leases = Leases::new(dir.join("x.lease"));
        let t = leases
            .acquire(Duration::from_secs(60))
            .unwrap()
            .expect("first holder");
        assert_eq!(leases.acquire(Duration::from_secs(60)).unwrap(), None);
        assert!(!leases.release("not-the-token"));
        assert_eq!(leases.acquire(Duration::from_secs(60)).unwrap(), None);
        assert!(leases.release(&t));
        assert!(
            !leases.release(&t),
            "a released token releases nothing twice"
        );
        assert!(leases.acquire(Duration::from_secs(60)).unwrap().is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_lease_is_exclusive_across_processes() {
        let dir = scratch("lease-os");
        let path = dir.join("x.lease");
        let other = open_lock_file(&path).unwrap();
        other.lock().unwrap();
        let leases = Leases::new(path.clone());
        assert_eq!(leases.acquire(Duration::from_secs(60)).unwrap(), None);
        other.unlock().unwrap();
        let t = leases
            .acquire(Duration::from_secs(60))
            .unwrap()
            .expect("free now");
        // And held by this process, another process cannot take it.
        let probe = open_lock_file(&path).unwrap();
        assert!(matches!(probe.try_lock(), Err(TryLockError::WouldBlock)));
        assert!(leases.release(&t));
        assert!(probe.try_lock().is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_lease_nobody_releases_times_out() {
        let dir = scratch("lease-ttl");
        let leases = Leases::new(dir.join("x.lease"));
        let t = leases
            .acquire(Duration::from_millis(1))
            .unwrap()
            .expect("held");
        // Clamped to LEASE_MIN (1 s); wait it out.
        std::thread::sleep(LEASE_MIN + Duration::from_millis(300));
        assert!(!leases.release(&t), "the timer already released it");
        assert!(leases.acquire(Duration::from_secs(60)).unwrap().is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
