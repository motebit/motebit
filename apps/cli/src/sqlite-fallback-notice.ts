/**
 * The one notice the CLI prints when it runs on the sql.js fallback driver.
 *
 * `better-sqlite3` is an optionalDependency of the CLI: when its prebuild
 * can't be fetched and no compiler is present, npm skips it and the install
 * still succeeds. `openMotebitDatabase` then opens on sql.js (WASM). That
 * works, but it is not the same durability, so the user is told — once per
 * process, on stderr (stdout stays clean for `--json` and pipes), with the
 * difference stated plainly rather than softened.
 */

import { onDriverFallback } from "@motebit/persistence";

/** Stable substring the install smoke (scripts/smoke-cli-install-without-native.sh) greps for. */
export const SQLITE_FALLBACK_MARKER = "running on the sql.js fallback";

export function formatSqliteFallbackNotice(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const firstLine = raw.split("\n")[0] ?? "";
  const reason = firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
  return [
    `motebit: native SQLite driver (better-sqlite3) unavailable — ${SQLITE_FALLBACK_MARKER} (WASM).`,
    `  Reason: ${reason}`,
    "  Durability differs: the database lives in memory and is rewritten to disk in full up to",
    "  about 1s after each change, so a crash or kill in that window loses the latest writes, and",
    "  two motebit processes on the same database can overwrite each other's changes (no WAL).",
    "  To restore the native driver, reinstall where a prebuilt binary is reachable or a C/C++",
    "  toolchain is present (`motebit doctor` shows the active driver).",
    "",
  ].join("\n");
}

/**
 * Register the notice for this process. Prints at most once no matter how
 * many databases are opened. Returns the unsubscribe function.
 */
export function installSqliteFallbackNotice(
  write: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): () => void {
  let printed = false;
  return onDriverFallback(({ cause }) => {
    if (printed) return;
    printed = true;
    write(formatSqliteFallbackNotice(cause));
  });
}
