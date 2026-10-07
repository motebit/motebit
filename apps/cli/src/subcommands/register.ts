/**
 * `motebit register [--sync-url <url>]` — register this motebit's
 * identity with the relay so other agents can discover and delegate
 * to it. Saves the sync URL to `~/.motebit/config.json` so daemon and
 * REPL modes can skip the flag on subsequent runs.
 *
 * Relay sync is opt-in (`../sync-opt-in.ts`): register never picks a
 * relay for the user. With nothing named (flag, `--sync`, env,
 * config.json) it exits with the one-line opt-in message.
 */

import { mintAudienceToken, secureErase } from "@motebit/encryption";
import { verifyTransparencyDeclaration } from "@motebit/state-export-client";
import type { CliConfig } from "../args.js";
import { loadFullConfig, saveFullConfig } from "../config.js";
import { loadActiveSigningKey, IdentityKeyError } from "../identity.js";
import { requireMotebitId, NO_IDENTITY_MESSAGE } from "./_helpers.js";
import { sanitizeRelayText } from "@motebit/sync-engine";
import { namedRelayUrl, SYNC_OFF_MESSAGE } from "../sync-opt-in.js";
import { signedBootstrapBody } from "../relay-registration.js";

export async function handleRegister(config: CliConfig): Promise<void> {
  const fullConfig = loadFullConfig();
  const syncUrl = namedRelayUrl(config, fullConfig);
  if (syncUrl == null) {
    console.error(SYNC_OFF_MESSAGE);
    process.exit(1);
  }

  // Require identity to exist (user must have launched the REPL at least once)
  const motebitId = requireMotebitId(fullConfig);
  const deviceId = fullConfig.device_id;
  const publicKeyHex = fullConfig.device_public_key;

  // device_id and device_public_key are written alongside motebit_id in the
  // same interactive setup — their absence means the config is partial, and
  // the remediation is the same as for a missing motebit_id: re-run the
  // interactive setup so every field lands together.
  if (deviceId == null || deviceId === "") {
    console.error(NO_IDENTITY_MESSAGE);
    process.exit(1);
  }
  if (publicKeyHex == null || publicKeyHex === "") {
    console.error(NO_IDENTITY_MESSAGE);
    process.exit(1);
  }

  // Decrypt the private key: the relay admits a bootstrap only when it is
  // signed by the key it introduces (#875 — proof of possession), so there
  // is no unsigned fallback. Without the key, registration stops here and
  // says why and what to do.
  let privateKeyBytes: Uint8Array;
  try {
    const loaded = await loadActiveSigningKey(fullConfig, {
      promptLabel: "Passphrase (to sign registration): ",
    });
    privateKeyBytes = loaded.privateKey;
  } catch (err) {
    if (err instanceof IdentityKeyError) {
      console.error(
        `Error: registration needs this identity's signing key — the relay requires proof of possession of the key it registers (${err.kind}: ${sanitizeRelayText(err.message)}).\n  → ${err.remedy}`,
      );
    } else {
      console.error(
        `Error: could not decrypt the private key — the relay requires a registration signed by it (${sanitizeRelayText(err instanceof Error ? err.message : String(err))})`,
      );
    }
    process.exit(1);
  }

  // Step 1: Bootstrap identity + device on relay (creates identity if new,
  // idempotent if same key) — signed by the key it introduces.
  let registerResp: Response;
  try {
    registerResp = await fetch(`${syncUrl}/api/v1/agents/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await signedBootstrapBody({
        motebitId,
        deviceId,
        publicKeyHex,
        privateKey: privateKeyBytes,
      }),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: could not reach relay at ${syncUrl}: ${sanitizeRelayText(msg)}`);
    process.exit(1);
  }

  if (!registerResp.ok) {
    const text = await registerResp.text();
    console.error(
      `Error: relay registration failed (${registerResp.status}): ${text.slice(0, 200)}`,
    );
    process.exit(1);
  }

  const bootstrapResult = (await registerResp.json()) as { registered: boolean };
  const registered = true;

  // Step 2: Verify registration succeeded by minting a signed token and calling /health
  if (registered) {
    try {
      const { token } = await mintAudienceToken(
        { mid: motebitId, did: deviceId, aud: "sync" },
        privateKeyBytes,
      );

      const healthResp = await fetch(`${syncUrl}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!healthResp.ok) {
        console.warn(`Warning: relay health check returned ${healthResp.status} — continuing`);
      }
    } catch {
      // Best-effort verification — don't fail the command
    }
  }

  // Step 3: Save sync URL to config if not already set
  if (fullConfig.sync_url == null || fullConfig.sync_url === "") {
    fullConfig.sync_url = syncUrl;
    saveFullConfig(fullConfig);
    console.log(`Saved sync URL: ${syncUrl}`);
  }

  if (bootstrapResult.registered) {
    console.log(`Created + registered ${motebitId.slice(0, 8)}... with relay at ${syncUrl}`);
  } else {
    console.log(
      `Registered ${motebitId.slice(0, 8)}... with relay at ${syncUrl} (identity already existed)`,
    );
  }

  await pinRelayKey(syncUrl, fullConfig);

  // Erase temporary private key bytes
  secureErase(privateKeyBytes);
}

/**
 * Pin the relay operator's public key (trust-on-first-use). The P2P
 * delegation path derives the treasury address FROM this pin — never
 * from a fetched response at payment time — so the pin is the trust
 * root for every fee leg this motebit ever pays. Source: the relay's
 * SIGNED transparency declaration, self-consistency-verified via the
 * canonical `@motebit/state-export-client` verifier (hash + signature
 * against the key the declaration itself carries).
 *
 * Three outcomes, deliberately asymmetric:
 *  - unpinned + verified  → pin + say so
 *  - pinned + MISMATCH    → FAIL LOUD (exit 1): a relay that changed
 *    identity must be re-pinned deliberately (verify out-of-band,
 *    remove relay_public_key from config, re-register) — never silently
 *  - fetch/verify failure → warn only; registration already succeeded,
 *    but P2P delegation stays unavailable until pinned
 *
 * Exported for tests.
 */
export async function pinRelayKey(
  syncUrl: string,
  fullConfig: ReturnType<typeof loadFullConfig>,
): Promise<void> {
  // The mismatch exit lives OUTSIDE the try: the catch below exists to
  // soften NETWORK failures only — a pin mismatch must never be
  // swallowed by the same net (found by the fail-loud test, whose
  // simulated exit was caught here in v1).
  let mismatch: { declared: string; pinned: string } | null = null;
  try {
    const declRes = await fetch(`${syncUrl}/.well-known/motebit-transparency.json`);
    if (!declRes.ok) throw new Error(`HTTP ${declRes.status}`);
    const declaration = (await declRes.json()) as Parameters<
      typeof verifyTransparencyDeclaration
    >[0];
    const verdict = await verifyTransparencyDeclaration(declaration);
    if (!verdict.ok) {
      console.warn(
        `Warning: relay transparency declaration failed verification (${verdict.reason}) — ` +
          `relay key NOT pinned; P2P delegation unavailable until it verifies.`,
      );
      return;
    }
    const declaredKey = declaration.relay_public_key;
    const pinned = fullConfig.relay_public_key;
    if (pinned != null && pinned !== "" && pinned !== declaredKey) {
      mismatch = { declared: declaredKey, pinned };
    } else if (pinned == null || pinned === "") {
      fullConfig.relay_public_key = declaredKey;
      saveFullConfig(fullConfig);
      console.log(
        `Pinned relay key ${declaredKey.slice(0, 12)}… (verified signed transparency declaration)`,
      );
    }
  } catch (err) {
    console.warn(
      `Warning: could not fetch the relay transparency declaration ` +
        `(${sanitizeRelayText(err instanceof Error ? err.message : String(err))}) — relay key not pinned; ` +
        `re-run \`motebit register\` online to enable P2P delegation.`,
    );
  }
  if (mismatch != null) {
    console.error(
      `PIN MISMATCH: this relay now declares key ${mismatch.declared.slice(0, 12)}… but your ` +
        `config pins ${mismatch.pinned.slice(0, 12)}…. A relay that changes identity must be ` +
        `re-pinned deliberately: verify out-of-band, then remove relay_public_key from ` +
        `~/.motebit/config.json and re-run register. Refusing to overwrite.`,
    );
    process.exit(1);
  }
}
