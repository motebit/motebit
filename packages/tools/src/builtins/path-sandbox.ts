/**
 * Shared path sandboxing utility for file and shell tools.
 *
 * Resolves symlinks, validates segment boundaries, and prevents escape
 * from allowed directories. Used by read_file, write_file, and shell_exec.
 */

import * as fsSync from "node:fs";
import * as path from "node:path";

export interface PathCheckResult {
  allowed: boolean;
  canonical: string;
  error?: string;
}

/**
 * Check if a file path is within the allowed directories.
 * Resolves symlinks to prevent escape. Handles ENOENT for new files
 * by resolving the parent directory instead.
 */
export function isPathAllowed(candidate: string, allowedPaths: string[]): PathCheckResult {
  if (allowedPaths.length === 0) return { allowed: true, canonical: path.resolve(candidate) };

  let canonical: string;
  try {
    canonical = fsSync.realpathSync(path.resolve(candidate));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // New file — resolve parent directory instead
      try {
        const parentCanonical = fsSync.realpathSync(path.dirname(path.resolve(candidate)));
        canonical = path.join(parentCanonical, path.basename(candidate));
      } catch {
        return {
          allowed: false,
          canonical: "",
          error: `Cannot resolve parent directory for "${candidate}"`,
        };
      }
    } else {
      return { allowed: false, canonical: "", error: `Cannot resolve path "${candidate}"` };
    }
  }

  const allowed = matchesAllowedPath(canonical, allowedPaths);
  if (!allowed) {
    return {
      allowed: false,
      canonical,
      error: `Access denied: "${canonical}" is outside allowed paths`,
    };
  }
  return { allowed: true, canonical };
}

/**
 * Is `candidate` inside motebit's own state — the directories that hold
 * identity key files (`config.json` with `cli_encrypted_key`, the rotation
 * write-ahead, `dev-keyring.json`, the relay database)? Those are:
 *
 *  - `~/.motebit` (`$HOME` or `%USERPROFILE%`),
 *  - `$MOTEBIT_CONFIG_DIR` when set, and
 *  - any directory named `.motebit` — a scaffolded agent keeps its only key
 *    copy in `<agent>/.motebit/config.json`, and the CLI's default
 *    `allowedPaths` (the cwd) puts it in reach when `motebit` runs there.
 *
 * The file tools never write there: a model has no legitimate reason to
 * replace its own key files, and an approved `write_file` or `undo_write`
 * over one destroys the key (`docs/proposals/key-file-durability-v1.md`
 * item 28). Mirrors the desktop's `tool_guard::is_protected_path`. Symlinks
 * are resolved (the parent, for a file not there yet), so a link from an
 * allowed directory into `~/.motebit` is denied too.
 */
export function isProtectedStatePath(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  let canonical = resolved;
  try {
    canonical = fsSync.realpathSync(resolved);
  } catch {
    try {
      canonical = path.join(fsSync.realpathSync(path.dirname(resolved)), path.basename(resolved));
    } catch {
      /* unresolvable — judge the path as given */
    }
  }
  const roots: string[] = [];
  const home = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (home != null && home !== "") roots.push(path.join(home, ".motebit"));
  const configDir = process.env["MOTEBIT_CONFIG_DIR"];
  if (configDir != null && configDir !== "") roots.push(configDir);
  for (const candidatePath of [resolved, canonical]) {
    if (candidatePath.split(path.sep).includes(".motebit")) return true;
    for (const root of roots) {
      let r = path.resolve(root);
      try {
        r = fsSync.realpathSync(r);
      } catch {
        /* not there — compare lexically */
      }
      if (candidatePath === r || candidatePath.startsWith(r.endsWith(path.sep) ? r : r + path.sep))
        return true;
    }
  }
  return false;
}

/**
 * Check if a directory path is within the allowed directories.
 * Unlike isPathAllowed, the directory must exist (no ENOENT fallback).
 * Used for shell_exec cwd validation.
 */
export function isDirectoryAllowed(dir: string, allowedPaths: string[]): PathCheckResult {
  if (allowedPaths.length === 0) return { allowed: true, canonical: path.resolve(dir) };

  let canonical: string;
  try {
    canonical = fsSync.realpathSync(path.resolve(dir));
  } catch {
    return { allowed: false, canonical: "", error: `Directory does not exist: "${dir}"` };
  }

  // Verify it's actually a directory
  try {
    const stat = fsSync.statSync(canonical);
    if (!stat.isDirectory()) {
      return { allowed: false, canonical, error: `Not a directory: "${canonical}"` };
    }
  } catch {
    return { allowed: false, canonical: "", error: `Cannot stat: "${dir}"` };
  }

  const allowed = matchesAllowedPath(canonical, allowedPaths);
  if (!allowed) {
    return {
      allowed: false,
      canonical,
      error: `Access denied: "${canonical}" is outside allowed paths`,
    };
  }
  return { allowed: true, canonical };
}

/**
 * Check if a canonical path is within any of the allowed paths.
 * Uses segment-boundary matching to prevent /home/user/project-evil
 * from matching /home/user/project.
 */
function matchesAllowedPath(canonical: string, allowedPaths: string[]): boolean {
  return allowedPaths.some((p) => {
    try {
      const resolvedAllow = fsSync.realpathSync(path.resolve(p));
      if (canonical === resolvedAllow) return true;
      const prefix = resolvedAllow.endsWith("/") ? resolvedAllow : resolvedAllow + "/";
      return canonical.startsWith(prefix);
    } catch {
      return false;
    }
  });
}
