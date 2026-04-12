/**
 * `bootstrapAndEmitIdentity()` — the 25-line block every motebit service
 * copies verbatim, now exactly one call.
 *
 * The sequence every service was running by hand:
 *
 *   1. `bootstrapServiceIdentity({ dataDir, serviceName })` — generate or
 *      reload Ed25519 keypair, register device, persist to data dir.
 *   2. `generate({ motebitId, ownerId, publicKeyHex, devices, service }, privateKey)`
 *      — emit the canonical signed motebit.md content.
 *   3. `fs.writeFileSync(suggestedIdentityPath, identityContent, "utf-8")`
 *      — persist motebit.md next to motebit.json and motebit.key.
 *
 * Steps 2–3 only varied in `service_name`, `service_description`, and
 * `capabilities`. Five sibling services drifted that block independently —
 * the exact shape the `feedback_protocol_primitive_blindness` doctrine
 * warns about. The helper collapses the drift surface to three inputs.
 *
 * Lives in `@motebit/mcp-server` (Layer 3) rather than `@motebit/core-identity`
 * (Layer 2) because `generate()` comes from `@motebit/identity-file`, a Layer 2
 * sibling. Layer 3 is the first layer that can legally compose both.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bootstrapServiceIdentity } from "@motebit/core-identity/node";
import { generate } from "@motebit/identity-file";
import { hexToBytes } from "@motebit/encryption";

export interface BootstrapAndEmitIdentityOptions {
  /** Persistent data directory — on Fly.io this is a mounted volume. */
  dataDir: string;
  /** Canonical service slug (e.g. "motebit-web-search"). Used for device name and owner id. */
  serviceName: string;
  /** Human-readable service name for the motebit.md identity file (e.g. "Web Search"). */
  displayName: string;
  /** Service description written into motebit.md. */
  serviceDescription: string;
  /** Capability strings advertised in motebit.md. */
  capabilities: string[];
}

export interface BootstrapAndEmitIdentityResult {
  motebitId: string;
  deviceId: string;
  publicKeyHex: string;
  /** Ed25519 public key bytes — needed to build signed service receipts. */
  publicKey: Uint8Array;
  /** Ed25519 private key bytes — needed to sign receipts. */
  privateKey: Uint8Array;
  /** Canonical signed motebit.md content (already written to disk). */
  identityContent: string;
  /** Absolute path where motebit.md was written. */
  identityPath: string;
  /** True on first boot (new keypair generated), false on reload. */
  isFirstLaunch: boolean;
}

/**
 * Bootstrap a service identity and emit the canonical signed motebit.md.
 *
 * First boot: generates an Ed25519 keypair, persists motebit.json + motebit.key
 * to `dataDir`, writes a signed motebit.md.
 *
 * Subsequent boots: reloads the existing keypair, regenerates motebit.md
 * (deterministic except for `created_at`).
 */
export async function bootstrapAndEmitIdentity(
  options: BootstrapAndEmitIdentityOptions,
): Promise<BootstrapAndEmitIdentityResult> {
  const { dataDir, serviceName, displayName, serviceDescription, capabilities } = options;

  const bootstrap = await bootstrapServiceIdentity({
    dataDir: resolve(dataDir),
    serviceName,
  });

  const privateKey = hexToBytes(bootstrap.privateKeyHex);
  const publicKey = hexToBytes(bootstrap.publicKeyHex);

  const identityContent = await generate(
    {
      motebitId: bootstrap.motebitId,
      ownerId: serviceName,
      publicKeyHex: bootstrap.publicKeyHex,
      devices: [
        {
          device_id: bootstrap.deviceId,
          name: serviceName,
          public_key: bootstrap.publicKeyHex,
          registered_at: new Date().toISOString(),
        },
      ],
      service: {
        type: "service",
        service_name: displayName,
        service_description: serviceDescription,
        capabilities,
      },
    },
    privateKey,
  );

  writeFileSync(bootstrap.suggestedIdentityPath, identityContent, "utf-8");

  return {
    motebitId: bootstrap.motebitId,
    deviceId: bootstrap.deviceId,
    publicKeyHex: bootstrap.publicKeyHex,
    publicKey,
    privateKey,
    identityContent,
    identityPath: bootstrap.suggestedIdentityPath,
    isFirstLaunch: bootstrap.isFirstLaunch,
  };
}
