/**
 * Update nudge — one dim line at REPL start when a newer motebit is on npm.
 *
 * Register: the seed-backup nudge's shape — calm, a single actionable
 * line, never a nag. Mechanics keep startup honest:
 *   - the registry check is CACHED (`update-check.json` in the config
 *     dir) and refreshed in the BACKGROUND for the NEXT launch — startup
 *     never blocks on the network and a session is never interrupted by
 *     a late response;
 *   - offline / registry errors are silent (no write, retry next launch);
 *   - the nudge renders from whatever the cache knows: a stale cache can
 *     only ever name a version that exists, and once the user updates,
 *     the newer-than compare goes quiet on its own.
 * Opt out with MOTEBIT_NO_UPDATE_CHECK=1 (CI, scripts, air-gapped).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR } from "./config.js";

export interface UpdateCheckState {
  last_checked_at: number;
  latest?: string;
}

const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000; // one check a day is plenty
const FETCH_TIMEOUT_MS = 3000;

function updateCheckPath(): string {
  return path.join(CONFIG_DIR, "update-check.json");
}

/**
 * Strict numeric triple compare; anything malformed (prerelease tags,
 * missing parts, non-numbers) compares false — the nudge fails to
 * silence, never to noise.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] | null => {
    const parts = v.trim().split(".");
    if (parts.length !== 3) return null;
    const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
    return nums.some((n) => Number.isNaN(n)) ? null : nums;
  };
  const l = parse(latest);
  const c = parse(current);
  if (l == null || c == null) return false;
  for (let i = 0; i < 3; i++) {
    if (l[i]! > c[i]!) return true;
    if (l[i]! < c[i]!) return false;
  }
  return false;
}

export function readUpdateState(statePath = updateCheckPath()): UpdateCheckState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8")) as Record<string, unknown>;
    if (typeof raw.last_checked_at !== "number") return null;
    return {
      last_checked_at: raw.last_checked_at,
      ...(typeof raw.latest === "string" ? { latest: raw.latest } : {}),
    };
  } catch {
    return null;
  }
}

/** The dim line to render, or null for silence. Pure. */
export function renderUpdateNudge(params: {
  currentVersion: string;
  state: UpdateCheckState | null;
}): string | null {
  const latest = params.state?.latest;
  if (latest == null || !isNewerVersion(latest, params.currentVersion)) return null;
  return `motebit ${latest} available — npm i -g motebit`;
}

/**
 * Fire-and-forget cache refresh for the NEXT launch. Skips when the
 * cache is fresh; any failure (offline, timeout, bad body) writes
 * nothing and retries silently on a later launch.
 */
export function refreshUpdateCheckInBackground(params?: {
  statePath?: string;
  nowMs?: number;
  ttlMs?: number;
  fetchFn?: typeof fetch;
}): void {
  const statePath = params?.statePath ?? updateCheckPath();
  const now = params?.nowMs ?? Date.now();
  const ttl = params?.ttlMs ?? UPDATE_CHECK_TTL_MS;
  const fetchFn = params?.fetchFn ?? fetch;

  const state = readUpdateState(statePath);
  if (state != null && now - state.last_checked_at < ttl) return;

  void (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetchFn("https://registry.npmjs.org/motebit/latest", {
        signal: controller.signal,
      });
      if (!resp.ok) return;
      const body = (await resp.json()) as { version?: unknown };
      if (typeof body.version !== "string") return;
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(
        statePath,
        JSON.stringify({ last_checked_at: now, latest: body.version } satisfies UpdateCheckState),
      );
    } catch {
      // Offline / timeout / parse failure: stay silent, retry next launch.
    } finally {
      clearTimeout(timer);
    }
  })();
}
