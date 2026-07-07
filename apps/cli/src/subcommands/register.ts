/**
 * `motebit register [--sync-url <url>]` — register this motebit's
 * identity with the relay so other agents can discover and delegate
 * to it. Saves the sync URL to `~/.motebit/config.json` so daemon and
 * REPL modes can skip the flag on subsequent runs.
 *
 * DEFAULT_SYNC_URL is private to this handler because it is the only
 * command that can run against the default production relay without
 * a pre-configured sync URL — every other handler routes through
 * `getRelayUrl`, which requires one.
 */

import { createSignedToken, secureErase } from "@motebit/encryption";
import { verifyTransparencyDeclaration } from "@motebit/state-export-client";
import type { CliConfig } from "../args.js";
import { loadFullConfig, saveFullConfig } from "../config.js";
import { loadActiveSigningKey, IdentityKeyError } from "../identity.js";
import { requireMotebitId, NO_IDENTITY_MESSAGE } from "./_helpers.js";

const DEFAULT_SYNC_URL = "https://relay.motebit.com";

export async function handleRegister(config: CliConfig): Promise<void> {
  const syncUrl = (config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"] ?? DEFAULT_SYNC_URL).replace(
    /\/+$/,
    "",
  );

  const fullConfig = loadFullConfig();

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

  // Decrypt the private key so we can sign the registration token. If
  // unavailable (no key, wrong passphrase, public-key mismatch), fall back
  // to unsigned registration with a clear warning — the relay's bootstrap
  // endpoint accepts unsigned bootstrap for fresh identities.
  let privateKeyBytes: Uint8Array | undefined;
  try {
    const loaded = await loadActiveSigningKey(fullConfig, {
      promptLabel: "Passphrase (to sign registration): ",
    });
    privateKeyBytes = loaded.privateKey;
  } catch (err) {
    if (err instanceof IdentityKeyError) {
      console.warn(
        `Warning: registration proceeds unsigned (${err.kind}: ${err.message}).\n  → ${err.remedy}`,
      );
    } else {
      console.warn(
        `Warning: could not decrypt private key — registration proceeds unsigned (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  // Step 1: Bootstrap identity + device on relay (creates identity if new, idempotent if same key)
  const bootstrapBody = {
    motebit_id: motebitId,
    device_id: deviceId,
    public_key: publicKeyHex,
  };

  let registerResp: Response;
  try {
    registerResp = await fetch(`${syncUrl}/api/v1/agents/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bootstrapBody),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: could not reach relay at ${syncUrl}: ${msg}`);
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
  if (registered && privateKeyBytes) {
    try {
      const token = await createSignedToken(
        {
          mid: motebitId,
          did: deviceId,
          iat: Date.now(),
          exp: Date.now() + 5 * 60 * 1000,
          jti: crypto.randomUUID(),
          aud: "sync",
        },
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
  if (privateKeyBytes) secureErase(privateKeyBytes);
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
        `(${err instanceof Error ? err.message : String(err)}) — relay key not pinned; ` +
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
