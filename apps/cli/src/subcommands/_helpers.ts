/**
 * Shared internal helpers for CLI subcommand topic files.
 *
 * The leading underscore marks this as a module-internal file — not
 * re-exported from the `subcommands.ts` barrel, not intended for
 * consumers outside `apps/cli/src/subcommands/`. When a handler
 * needs a helper that two or more other handlers also need, it
 * lives here.
 */

import { createSignedToken, secureErase } from "@motebit/encryption";
import type { CliConfig } from "../args.js";
import { loadFullConfig, type FullConfig } from "../config.js";
import { loadActiveSigningKey } from "../identity.js";

/**
 * Canonical empty-state message for any CLI surface that requires an
 * identity. One phrasing across every subcommand — prior audit found
 * five commands giving four different phrasings, which is exactly the
 * sibling-boundary violation this helper exists to prevent. When the
 * onboarding flow evolves, this is the single place to update.
 *
 * Bare `motebit` (no args) is the canonical interactive setup: it
 * generates an Ed25519 identity, encrypts it with a passphrase, and
 * drops the user into the REPL. `npm create motebit` scaffolds a
 * different thing — a standalone agent project — and is not the right
 * path for "I want to use this CLI."
 */
export const NO_IDENTITY_MESSAGE =
  "No motebit identity found. Run `motebit` (no arguments) to create one — the first run walks you through setting a passphrase and generating the keypair.";

/**
 * Resolve the motebit_id from the persisted CLI config, exiting with a
 * helpful error if no identity exists. Returns the non-empty string.
 *
 * Every handler that operates on the local motebit identity calls this
 * at the top; centralizing the check removes 15 copies of the same
 * five-line block and gives us one place to evolve the error message.
 */
export function requireMotebitId(fullConfig: FullConfig): string {
  const id = fullConfig.motebit_id;
  if (id == null || id === "") {
    console.error(NO_IDENTITY_MESSAGE);
    process.exit(1);
  }
  return id;
}

/**
 * Fetch JSON from the relay, returning a discriminated-union result
 * instead of throwing. All CLI relay probes use this shape so the
 * caller can branch on `ok` cleanly.
 */
export async function fetchRelayJson(
  url: string,
  headers: Record<string, string>,
  method: "GET" | "POST" = "GET",
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { method, headers });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `relay returned ${String(res.status)}: ${body.slice(0, 100)}` };
    }
    const data: unknown = await res.json();
    return { ok: true, data };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/**
 * Resolve the relay base URL from CLI config, env, or persisted config.
 * Exits the process with a helpful error if no URL is configured.
 * Trailing slashes are trimmed.
 */
export function getRelayUrl(config: CliConfig): string {
  const url = config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"] ?? loadFullConfig().sync_url;
  if (!url) {
    console.error("Error: no relay URL. Use --sync-url or run `motebit register` first.");
    process.exit(1);
  }
  return url.replace(/\/+$/, "");
}

/**
 * Build auth headers for relay API calls. Tries in order:
 * 1. --sync-token / MOTEBIT_API_TOKEN / MOTEBIT_SYNC_TOKEN (master token)
 * 2. Signed device token (decrypts private key from config, prompts for passphrase)
 * 3. No auth (unauthenticated)
 *
 * Both `MOTEBIT_API_TOKEN` and `MOTEBIT_SYNC_TOKEN` are accepted because
 * the rest of the codebase uses both names interchangeably (see
 * `slash-commands.ts` for the original two-name fallback). `--sync-token`
 * is the documented command-line form.
 *
 * On passphrase failure (step 2), a warning is logged and the request
 * continues unauthenticated rather than silently dropping the auth header
 * — the user will otherwise get a cryptic 401 from the relay without
 * knowing why.
 */
export async function getRelayAuthHeaders(
  config: CliConfig,
  opts?: { aud?: string; json?: boolean },
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (opts?.json) headers["Content-Type"] = "application/json";

  // 1. Master token — accept either env var name (they've been aliases
  //    for the whole life of the CLI) plus the --sync-token flag.
  const master =
    config.syncToken ?? process.env["MOTEBIT_API_TOKEN"] ?? process.env["MOTEBIT_SYNC_TOKEN"];
  if (master) {
    headers["Authorization"] = `Bearer ${master}`;
    return headers;
  }

  // 2. Signed device token from encrypted private key
  //
  // The passphrase decrypts the same `cli_encrypted_key` every other CLI
  // command unlocks (see apps/cli/src/index.ts, subcommands/rotate.ts,
  // subcommands/export.ts, subcommands/attest.ts). It's not a separate
  // "relay auth" secret — the local Ed25519 key signs a short-lived
  // bearer token, and the relay verifies that signature. Honor
  // MOTEBIT_PASSPHRASE consistently so scripted/CI use of `motebit
  // credentials`, `motebit export`, etc. doesn't hang on a hidden prompt.
  // Prompt label is "Passphrase: " to match every other unlock prompt;
  // the previous "(for relay auth)" parenthetical implied a second
  // passphrase concept that doesn't exist.
  const fullConfig = loadFullConfig();
  if (fullConfig.motebit_id && fullConfig.device_id) {
    try {
      const { privateKey } = await loadActiveSigningKey(fullConfig, {
        promptLabel: "Passphrase: ",
      });
      try {
        const token = await createSignedToken(
          {
            mid: fullConfig.motebit_id,
            did: fullConfig.device_id,
            iat: Date.now(),
            exp: Date.now() + 5 * 60 * 1000,
            jti: crypto.randomUUID(),
            aud: opts?.aud ?? "admin:query",
          },
          privateKey,
        );
        headers["Authorization"] = `Bearer ${token}`;
      } finally {
        secureErase(privateKey);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `Warning: could not mint signed auth token (${msg}). Request will proceed unauthenticated.`,
      );
    }
  }

  return headers;
}
