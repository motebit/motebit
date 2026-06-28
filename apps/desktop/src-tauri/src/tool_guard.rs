//! Authorization guards for the privileged Tauri tool commands
//! (`read_file_tool` / `write_file_tool` / `shell_exec_tool` in `main.rs`).
//!
//! These commands run on raw, webview-supplied input. Approval happens at the
//! TS policy gate, but that is bypassed by a direct IPC call, so the privilege
//! boundary must self-enforce here — defense-in-depth behind the CSP
//! (`docs/doctrine/surface-authority-model.md`).
//!
//! Two guards, both pure + unit-tested:
//!   - `is_protected_path` robustly denies the file tools access to the
//!     sovereign state dir `~/.motebit` (keyring, config, db) via path
//!     canonicalization — defeats `..`, symlink, and `$HOME` escapes. The AI
//!     agent has no legitimate reason to touch its own state through these
//!     tools, so this is a least-privilege win independent of XSS.
//!   - `is_destructive_command` is a BEST-EFFORT guard (not an unbypassable
//!     boundary — raw `sh -c` can obfuscate) that blocks the catastrophic-wipe
//!     class. Mirrors `@motebit/tools` shell-exec `DESTRUCTIVE_PATTERNS` +
//!     `ALWAYS_DESTRUCTIVE` (packages/tools/src/builtins/shell-exec.ts:11-33);
//!     keep the two in sync (sibling-boundary rule, enforced by
//!     `scripts/check-tool-guard-parity.ts`).

use std::path::{Component, Path, PathBuf};

/// `~/.motebit` — the sovereign state directory. `None` when no home env var
/// is set (then the file tools can't resolve a root to protect; realistic
/// deployments always have HOME/USERPROFILE).
pub fn motebit_root() -> Option<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(|home| PathBuf::from(home).join(".motebit"))
}

/// Resolve `..`/`.` components without touching the filesystem.
fn lexical_clean(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Canonical form of `p` for a containment check. Full `canonicalize` resolves
/// symlinks + `..` but requires the path to exist; for a not-yet-existing path
/// (a new file to write) canonicalize the deepest existing ancestor and
/// re-attach the remainder — mirrors `@motebit/tools` path-sandbox ENOENT
/// handling.
fn canonical_or_lexical(p: &Path) -> PathBuf {
    if let Ok(c) = std::fs::canonicalize(p) {
        return c;
    }
    let mut existing = p;
    while !existing.exists() {
        match existing.parent() {
            Some(parent) => existing = parent,
            None => return lexical_clean(p),
        }
    }
    let canon_existing = std::fs::canonicalize(existing).unwrap_or_else(|_| existing.to_path_buf());
    match p.strip_prefix(existing) {
        Ok(rem) => lexical_clean(&canon_existing.join(rem)),
        Err(_) => lexical_clean(p),
    }
}

/// True when `requested` resolves to `motebit_root` or anything under it.
/// `Path::starts_with` matches whole components, so `.motebitX` does NOT match
/// `.motebit` (no prefix-collision bug).
pub fn is_protected_path(requested: &Path, motebit_root: &Path) -> bool {
    let canon_root =
        std::fs::canonicalize(motebit_root).unwrap_or_else(|_| lexical_clean(motebit_root));
    canonical_or_lexical(requested).starts_with(&canon_root)
}

/// Commands that are destructive regardless of arguments (by basename).
/// Mirrors `ALWAYS_DESTRUCTIVE` in shell-exec.ts:12.
const ALWAYS_DESTRUCTIVE: &[&str] = &["dd", "mkfs", "fdisk", "shred"];

fn basename(token: &str) -> &str {
    Path::new(token)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(token)
}

/// Best-effort scan of a raw `sh -c` string for destructive command patterns.
/// Returns the matched pattern name on a hit. NOT a security boundary — raw
/// shell can obfuscate; this reduces the catastrophic-wipe blast radius and
/// catches accidents. The complete shell sandbox (allowlist / drop `sh -c`)
/// is deferred per docs/doctrine/surface-authority-model.md.
pub fn is_destructive_command(command: &str) -> Option<&'static str> {
    // Split into command segments on shell separators so `a && rm -rf b` is
    // checked per-segment (covers `;`, `|`, `&`, `&&`, `||`, newline).
    for segment in command.split(|c| c == ';' || c == '|' || c == '&' || c == '\n') {
        let tokens: Vec<&str> = segment.split_whitespace().collect();
        let Some((first, args)) = tokens.split_first() else {
            continue;
        };
        let base = basename(first);

        if ALWAYS_DESTRUCTIVE.contains(&base) {
            return Some(match base {
                "dd" => "dd",
                "mkfs" => "mkfs",
                "fdisk" => "fdisk",
                _ => "shred",
            });
        }

        match base {
            // `/^-.*r/i` or `--recursive` (shell-exec.ts:20)
            "rm" if args
                .iter()
                .any(|a| a.starts_with('-') && a[1..].to_ascii_lowercase().contains('r')) =>
            {
                return Some("rm -r");
            }
            // reset --hard / push --force[-with-lease] / clean -…f / branch -D
            "git" => {
                let joined = args.join(" ");
                if joined.contains("reset --hard")
                    || joined.contains("push --force")
                    || joined.contains("branch -D")
                {
                    return Some("git (destructive)");
                }
                let mut prev_clean = false;
                for a in args {
                    if prev_clean && a.starts_with('-') && a.contains('f') {
                        return Some("git clean -f");
                    }
                    prev_clean = *a == "clean";
                }
            }
            // chmod 777 | 000 (shell-exec.ts:31)
            "chmod" if args.iter().any(|a| *a == "777" || *a == "000") => {
                return Some("chmod 777/000");
            }
            // chown `/^-.*R/` (capital R) or --recursive (shell-exec.ts:32)
            "chown"
                if args
                    .iter()
                    .any(|a| (a.starts_with('-') && a.contains('R')) || *a == "--recursive") =>
            {
                return Some("chown -R");
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protects_the_motebit_state_dir() {
        let tmp = std::env::temp_dir().join(format!("motebit-guard-{}", std::process::id()));
        let root = tmp.join(".motebit");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("dev-keyring.json"), "{}").unwrap();
        std::fs::write(root.join("motebit.db"), "x").unwrap();
        let project = tmp.join("project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("file.txt"), "ok").unwrap();

        // Sovereign secrets are denied.
        assert!(is_protected_path(&root.join("dev-keyring.json"), &root));
        assert!(is_protected_path(&root.join("config.json"), &root));
        assert!(is_protected_path(&root.join("motebit.db"), &root));
        // A new (non-existent) file under the root is denied (write path).
        assert!(is_protected_path(&root.join("evil.json"), &root));
        // `..` escape into the root is denied.
        assert!(is_protected_path(
            &project.join("../.motebit/dev-keyring.json"),
            &root
        ));
        // Ordinary project files are allowed.
        assert!(!is_protected_path(&project.join("file.txt"), &root));
        assert!(!is_protected_path(&project.join("new.txt"), &root));
        // A prefix-colliding sibling is NOT protected (.motebitX vs .motebit).
        let sib = tmp.join(".motebitX");
        std::fs::create_dir_all(&sib).unwrap();
        assert!(!is_protected_path(&sib.join("f"), &root));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[cfg(unix)]
    #[test]
    fn protects_against_symlink_escape() {
        let tmp = std::env::temp_dir().join(format!("motebit-guard-sym-{}", std::process::id()));
        let root = tmp.join(".motebit");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("dev-keyring.json"), "{}").unwrap();
        let project = tmp.join("project");
        std::fs::create_dir_all(&project).unwrap();
        // A symlink inside the workspace pointing into the state dir.
        let link = project.join("sneaky");
        std::os::unix::fs::symlink(&root, &link).unwrap();
        assert!(is_protected_path(&link.join("dev-keyring.json"), &root));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn flags_destructive_commands() {
        for cmd in [
            "rm -rf /tmp/x",
            "rm -fr foo",
            "rm --recursive bar",
            "dd if=/dev/zero of=/dev/sda",
            "mkfs.ext4 /dev/sdb", // basename "mkfs.ext4" — see note below
            "shred secret",
            "git reset --hard HEAD~1",
            "git push --force origin main",
            "git push --force-with-lease",
            "git clean -fd",
            "chmod 777 secret",
            "chown -R root /etc",
            "echo hi && rm -rf x", // destructive in a later segment
            "ls | rm -rf x",
        ] {
            // mkfs.ext4 has basename "mkfs.ext4" which is not in the set — it is
            // expected NOT to flag (exact parity with shell-exec.ts), so skip it.
            if cmd.starts_with("mkfs.") {
                assert!(is_destructive_command(cmd).is_none(), "{cmd}");
                continue;
            }
            assert!(is_destructive_command(cmd).is_some(), "{cmd}");
        }
    }

    #[test]
    fn allows_benign_commands() {
        for cmd in [
            "ls -la",
            "git status",
            "git push origin main",
            "npm test",
            "cat README.md",
            "rm file.txt",       // non-recursive rm is allowed
            "chmod 644 file.txt", // non-777/000 chmod is allowed
            "echo hello world",
        ] {
            assert!(is_destructive_command(cmd).is_none(), "{cmd}");
        }
    }
}
