/**
 * Path identity by the filesystem, never by spelling. On a case-insensitive
 * filesystem (APFS by default) `~/.MOTEBIT` is `~/.motebit`, and Node's JS
 * `realpathSync` keeps the caller's case, so a spelling compare says they
 * differ. Two existing paths are the same entry iff their (dev, ino) match;
 * that also catches a hard link, which no spelling ever reveals.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** `p`'s (dev, ino) when it exists (symlinks followed), else null. */
export function fileIdentity(p: string): string | null {
  try {
    const st = fs.statSync(p, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

/** Both exist and are the same filesystem entry. */
export function isSameEntry(a: string, b: string): boolean {
  const ia = fileIdentity(a);
  return ia !== null && ia === fileIdentity(b);
}

/**
 * `p` with its deepest existing ancestor replaced by that ancestor's real
 * path (`realpathSync.native`: symlinks followed, the on-disk case), and the
 * parts that do not exist yet appended. Walking the lexical ancestors of the
 * caller's spelling would miss a symlink whose target lies elsewhere.
 */
export function canonicalPath(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      rest.unshift(path.basename(cur));
      cur = up;
    }
  }
}

/**
 * `child` is `parent` or lies beneath it: some existing ancestor of `child`'s
 * canonical path (itself included) is the same entry as `parent`. A part of
 * `child` that does not exist yet cannot alias `parent`; its existing
 * ancestors decide.
 */
export function isWithinEntry(child: string, parent: string): boolean {
  const target = fileIdentity(parent);
  if (target === null) return false;
  let cur = canonicalPath(child);
  for (;;) {
    if (fileIdentity(cur) === target) return true;
    const up = path.dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}
