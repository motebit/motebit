/**
 * Shared internal helpers for CLI subcommand topic files.
 *
 * The leading underscore marks this as a module-internal file — not
 * re-exported from the `subcommands.ts` barrel, not intended for
 * consumers outside `apps/cli/src/subcommands/`. When a handler
 * needs a helper that two or more other handlers also need, it
 * lives here.
 */

import { mintAudienceToken, secureErase } from "@motebit/encryption";
import type { TokenAudience } from "@motebit/sdk";
import type { CliConfig } from "../args.js";
import { loadFullConfig, type FullConfig } from "../config.js";
import { loadActiveSigningKey } from "../identity.js";
import {
  ALL_OPERATOR_TOKEN_SOURCES,
  bearerHeaders,
  operatorTokenFor,
} from "../relay-operator-token.js";
import { namedRelayUrl, PUBLIC_RELAY_URL, SYNC_OFF_MESSAGE } from "../sync-opt-in.js";
import { sanitizeRelayText } from "@motebit/sync-engine";

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
 * Resolve the relay base URL for a command whose whole purpose is the relay.
 * Relay sync is opt-in (`sync-opt-in.ts`): when no relay is named (flag,
 * env, config.json), exits with the one-line opt-in message — never picks
 * the public relay silently. Trailing slashes are trimmed.
 */
export function getRelayUrl(config: CliConfig): string {
  const url = namedRelayUrl(config, loadFullConfig());
  if (url == null) {
    console.error(SYNC_OFF_MESSAGE);
    process.exit(1);
  }
  return url;
}

/**
 * The public relay. Re-exported for the opt-ins that name it (`--sync`,
 * `motebit sync enable`); never a fallback.
 */
export const DEFAULT_SYNC_URL = PUBLIC_RELAY_URL;

/**
 * The relay this machine talks to, resolved the ONE way `motebit up` does:
 * flag, env, persisted config — or undefined when relay sync is off (it is
 * opt-in; there is no default). `motebit rotate` reads it too, so an
 * identity registered against a relay named on the flag or env rotates
 * there, not only against the persisted value (#702).
 */
export function resolveRelayUrl(config: CliConfig, fullConfig?: FullConfig): string | undefined {
  return namedRelayUrl(config, fullConfig ?? loadFullConfig());
}

/**
 * Build auth headers for a call to the relay at `relayUrl`. Tries in order:
 * 1. The operator (master) token, only when it is bound to `relayUrl`
 *    (`relay-operator-token.ts`: flag, then the two variables). A token that
 *    is set but not bound to this relay is withheld, with one line on stderr.
 * 2. Signed device token (decrypts private key from config, prompts for passphrase)
 * 3. No auth (unauthenticated)
 *
 * `relayUrl` is the relay the caller is about to request with these headers,
 * and MUST be that one: the operator token is resolved for it. It sits before
 * the options argument because `check-audience-route-parity` reads the
 * audience from the last argument.
 *
 * On passphrase failure (step 2), a warning is logged and the request
 * continues unauthenticated rather than silently dropping the auth header
 * — the user will otherwise get a cryptic 401 from the relay without
 * knowing why.
 */
export async function getRelayAuthHeaders(
  config: CliConfig,
  relayUrl: string,
  opts?: { aud?: TokenAudience; json?: boolean },
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (opts?.json) headers["Content-Type"] = "application/json";

  // 1. The operator token, when it is this relay's.
  const operator = operatorTokenFor(relayUrl, ALL_OPERATOR_TOKEN_SOURCES, config);
  if (operator !== undefined) return { ...headers, ...bearerHeaders(operator) };

  return { ...headers, ...(await getDeviceAuthHeaders(opts?.aud)) };
}

/**
 * The device-signed `Authorization` header alone (steps 2 and 3 above): what
 * every relay call falls back to when no operator token is bound to its
 * relay. Empty when there is no identity, or the key did not open.
 */
export async function getDeviceAuthHeaders(aud?: TokenAudience): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  // Signed device token from encrypted private key
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
        const { token } = await mintAudienceToken(
          {
            mid: fullConfig.motebit_id,
            did: fullConfig.device_id,
            aud: aud ?? "admin:query",
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
        `Warning: could not mint signed auth token (${sanitizeRelayText(msg)}). Request will proceed unauthenticated.`,
      );
    }
  }

  return headers;
}
