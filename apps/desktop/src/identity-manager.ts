/**
 * Identity manager — owns the desktop's motebitId / deviceId / publicKey
 * state and every operation that reads or writes it.
 *
 * This is the **foundation** module: every other desktop module (sync,
 * conversation, MCP, goals) reads identity state but doesn't write it,
 * so keeping identity in one clear home lets the rest of the desktop
 * surface stay mechanical and shell-shaped.
 *
 * The 15 methods here cover three concerns:
 *
 *   1. **Bootstrap + keypair**: `bootstrap`, `getDeviceKeypair`,
 *      `createSyncToken`, `registerWithRelay`. First-launch identity
 *      generation, ongoing keypair retrieval, relay registration.
 *
 *   2. **Identity file + key rotation**: `getIdentityInfo`,
 *      `exportIdentityFile`, `verifyIdentityFile`, `rotateKey`.
 *      The `motebit.md` file as artifact, plus Ed25519 key rotation
 *      with signed succession records.
 *
 *   3. **Multi-device pairing**: `initiatePairing`, `getPairingSession`,
 *      `approvePairing`, `denyPairing` (Device A side) +
 *      `claimPairing`, `pollPairingStatus`, `completePairing`
 *      (Device B side). These live here because every pairing flow
 *      needs the device keypair, the sync token, and (on completion)
 *      writes back the motebitId + deviceId.
 *
 * ### State ownership
 *
 * The manager OWNS `motebitId`, `deviceId`, `publicKey`. DesktopApp
 * exposes them as getters that read from the manager — every
 * existing `this.motebitId` / `this.deviceId` / `this.publicKey` read
 * in DesktopApp still works, but the underlying storage has moved
 * here. Writes happen only inside the manager, via `bootstrap`,
 * `rotateKey`, and `completePairing`.
 *
 * ### Dependencies
 *
 * Zero. The manager imports the shared Tauri storage factory from
 * `./index.js` (for `bootstrap`'s identity storage needs) and the
 * Tauri IPC types from `./tauri-storage.js`. Everything else is from
 * the `@motebit/*` packages. No cross-dependency on other extracted
 * modules (tauri-system-adapters, memory-commands, renderer-commands).
 */

import type { InvokeFn } from "./tauri-storage.js";
import type { PairingSession, PairingStatus } from "@motebit/sync-engine";
import { PairingClient } from "@motebit/sync-engine";
import {
  bootstrapIdentity as sharedBootstrapIdentity,
  rotateIdentityKeys,
  type BootstrapConfigStore,
  type BootstrapKeyStore,
} from "@motebit/core-identity";
import {
  createSignedToken,
  hexPublicKeyToDidKey,
  secureErase,
  bytesToHex,
  generateX25519Keypair,
  buildKeyTransferPayload,
  decryptKeyTransfer,
  checkPreTransferBalance,
  formatWalletWarning,
} from "@motebit/encryption";
import type { KeyTransferPayload } from "@motebit/sdk";
import {
  generate as generateIdentityFile,
  parse as parseIdentityFile,
  verify as verifyIdentity,
  rotate as rotateIdentityFile,
} from "@motebit/identity-file";
import type { BootstrapResult } from "./index.js";
import { createTauriStorage } from "./index.js";

/**
 * Read/write state owned by the IdentityManager. Exposed so the
 * DesktopApp can wire getters that delegate to these fields without
 * coupling to the manager's internals.
 */
export interface IdentityState {
  motebitId: string;
  deviceId: string;
  publicKey: string;
}

export class IdentityManager {
  motebitId: string = "desktop-local";
  deviceId: string = "desktop-local";
  publicKey: string = "";

  /**
   * Bootstrap identity on first launch or load existing identity.
   * Must be called before initAI() when running in Tauri. On first
   * launch, generates a keypair, writes to keyring, and emits a
   * signed `motebit.md` identity file into the Tauri config. On
   * subsequent launches, reads the existing identity from config +
   * keyring.
   */
  async bootstrap(invoke: InvokeFn): Promise<BootstrapResult> {
    const configStore: BootstrapConfigStore = {
      async read() {
        const raw = await invoke<string>("read_config");
        const config = JSON.parse(raw) as Record<string, unknown>;
        if (config.motebit_id == null || typeof config.motebit_id !== "string") return null;
        return {
          motebit_id: config.motebit_id,
          device_id: (config.device_id as string) ?? "",
          device_public_key: (config.device_public_key as string) ?? "",
        };
      },
      async write(state) {
        const raw = await invoke<string>("read_config");
        const config = { ...(JSON.parse(raw) as Record<string, unknown>), ...state };
        await invoke<void>("write_config", { json: JSON.stringify(config) });
      },
    };

    const keyStore: BootstrapKeyStore = {
      async storePrivateKey(privKeyHex) {
        await invoke<void>("keyring_set", { key: "device_private_key", value: privKeyHex });
        // Write-then-verify-read. The Rust keyring_set IPC returns Ok(())
        // on macOS even when the underlying Security framework silently
        // drops the write — this happens with ad-hoc-signed dev builds
        // where the process lacks a stable code identity the Keychain
        // will trust. Without this verify step, bootstrap returns
        // "success" but leaves the caller with a half-initialized
        // identity (public key in config, no private key in keychain),
        // which downstream operations discover only when they try to
        // sign something. This catches the divergent state at the moment
        // it would have been created, not hours later in sync. Signed
        // production builds don't hit this path; dev builds on macOS do.
        const verify = await invoke<string | null>("keyring_get", {
          key: "device_private_key",
        });
        if (verify !== privKeyHex) {
          throw new Error(
            "Keyring write silently failed — macOS rejected the Keychain store " +
              "(common with ad-hoc-signed dev binaries). Run a signed production " +
              "build, or accept a dev-only encrypted-file fallback in a future PR.",
          );
        }
      },
      async hasPrivateKey() {
        try {
          const val = await invoke<string | null>("keyring_get", { key: "device_private_key" });
          return val != null && val !== "";
        } catch {
          // Keyring access denied / unavailable → treat as absent. The
          // first-launch recovery will try to write through the same
          // keyring, which will surface any real permission issue with
          // a clearer error.
          return false;
        }
      },
    };

    const storage = createTauriStorage(invoke);
    const result = await sharedBootstrapIdentity({
      surfaceName: "Desktop",
      identityStorage: storage.identityStorage,
      eventStoreAdapter: storage.eventStore,
      configStore,
      keyStore,
    });

    this.motebitId = result.motebitId;
    this.deviceId = result.deviceId;
    this.publicKey = result.publicKeyHex;

    // Generate motebit.md identity file on first launch (best-effort, desktop-specific)
    if (result.isFirstLaunch) {
      try {
        const keypair = await this.getDeviceKeypair(invoke);
        if (keypair) {
          const privKeyBytes = hexToBytes(keypair.privateKey);
          try {
            const identityFileContent = await generateIdentityFile(
              {
                motebitId: result.motebitId,
                ownerId: result.motebitId,
                publicKeyHex: result.publicKeyHex,
                devices: [
                  {
                    device_id: result.deviceId,
                    name: "Desktop",
                    public_key: result.publicKeyHex,
                    registered_at: new Date().toISOString(),
                  },
                ],
              },
              privKeyBytes,
            );
            const raw = await invoke<string>("read_config");
            const config = {
              ...(JSON.parse(raw) as Record<string, unknown>),
              _identity_file: identityFileContent,
            };
            await invoke<void>("write_config", { json: JSON.stringify(config) });
          } finally {
            secureErase(privKeyBytes);
          }
        }
      } catch {
        // Non-fatal — identity file generation is best-effort on desktop
      }
    }

    return {
      isFirstLaunch: result.isFirstLaunch,
      motebitId: result.motebitId,
      deviceId: result.deviceId,
    };
  }

  /**
   * Get the device keypair from keyring + config. Returns null if not
   * available (first launch before bootstrap, or keyring access denied).
   */
  async getDeviceKeypair(
    invoke: InvokeFn,
  ): Promise<{ publicKey: string; privateKey: string } | null> {
    const raw = await invoke<string>("read_config");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const publicKey = config.device_public_key as string | undefined;
    if (publicKey == null || publicKey === "") return null;

    let privateKey: string | null = null;
    try {
      privateKey = await invoke<string | null>("keyring_get", { key: "device_private_key" });
    } catch {
      return null;
    }
    if (privateKey == null || privateKey === "") return null;

    return { publicKey, privateKey };
  }

  /**
   * Register this device with a sync relay. Creates the identity server-side
   * if needed, then registers the device with its public key. Returns a
   * signed auth token for subsequent sync requests, or `null` if no keypair.
   */
  async registerWithRelay(
    invoke: InvokeFn,
    syncUrl: string,
    masterToken: string,
  ): Promise<string | null> {
    const keypair = await this.getDeviceKeypair(invoke);
    if (!keypair) return null;

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${masterToken}`,
    };

    // Check if identity exists server-side
    const identityRes = await fetch(`${syncUrl}/identity/${this.motebitId}`, { headers });
    if (identityRes.status === 404) {
      // Create identity on server
      await fetch(`${syncUrl}/identity`, {
        method: "POST",
        headers,
        body: JSON.stringify({ owner_id: this.motebitId }),
      });
    }

    // Register device with public key
    await fetch(`${syncUrl}/device/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        motebit_id: this.motebitId,
        device_name: "Desktop",
        public_key: keypair.publicKey,
      }),
    });

    // Generate signed token for ongoing sync
    return this.createSyncToken(keypair.privateKey);
  }

  /**
   * Create a signed token for sync authentication. Tokens expire after
   * 5 minutes.
   *
   * @param privateKeyHex — hex-encoded device private key
   * @param aud — audience claim binding token to a specific endpoint
   *              (default: "sync")
   */
  async createSyncToken(privateKeyHex: string, aud: string = "sync"): Promise<string> {
    const privKeyBytes = hexToBytes(privateKeyHex);
    try {
      return await createSignedToken(
        {
          mid: this.motebitId,
          did: this.deviceId,
          iat: Date.now(),
          exp: Date.now() + 5 * 60 * 1000,
          jti: crypto.randomUUID(),
          aud,
        },
        privKeyBytes,
      );
    } finally {
      secureErase(privKeyBytes);
    }
  }

  /** Return a snapshot of the identity state + derived `did:key` URI. */
  getIdentityInfo(): { motebitId: string; deviceId: string; publicKey: string; did: string } {
    let did = "";
    try {
      if (this.publicKey) did = hexPublicKeyToDidKey(this.publicKey);
    } catch {
      // Non-fatal
    }
    return {
      motebitId: this.motebitId,
      deviceId: this.deviceId,
      publicKey: this.publicKey,
      did,
    };
  }

  /**
   * Generate a signed motebit.md identity file from live config.
   * Returns the file content string, or null if the keypair is unavailable.
   * The governance + memory fields are derived from the persisted
   * desktop config (approval_preset, memory_governance).
   */
  async exportIdentityFile(invoke: InvokeFn): Promise<string | null> {
    const keypair = await this.getDeviceKeypair(invoke);
    if (!keypair) return null;

    // Read live config for governance/memory settings
    const raw = await invoke<string>("read_config");
    const configData = JSON.parse(raw) as Record<string, unknown>;

    // Map approval_preset → identity-file governance fields
    const RISK_NAMES = ["R0_READ", "R1_DRAFT", "R2_WRITE", "R3_EXECUTE", "R4_MONEY"];
    const preset = configData.approval_preset as string | undefined;
    const PRESET_GOV: Record<string, { require: number; deny: number }> = {
      cautious: { require: 0, deny: 3 },
      balanced: { require: 1, deny: 3 },
      autonomous: { require: 3, deny: 4 },
    };
    const presetGov = PRESET_GOV[preset ?? "balanced"] ?? PRESET_GOV.balanced!;
    const governance = {
      trust_mode: (preset === "autonomous" ? "full" : "guarded") as "full" | "guarded" | "minimal",
      max_risk_auto: RISK_NAMES[presetGov.require]!,
      require_approval_above: RISK_NAMES[presetGov.require]!,
      deny_above: RISK_NAMES[presetGov.deny]!,
      operator_mode: false,
    };

    // Map memory_governance config → identity-file memory fields
    const memGov = configData.memory_governance as
      | { persistence_threshold?: number; reject_secrets?: boolean }
      | undefined;
    const memory = {
      confidence_threshold: memGov?.persistence_threshold ?? 0.3,
      half_life_days: 7,
      per_turn_limit: 5,
    };

    // Build device list from current device
    const devices = [
      {
        device_id: this.deviceId,
        name: "Desktop",
        public_key: this.publicKey,
        registered_at: new Date().toISOString(),
      },
    ];

    // Convert hex private key to Uint8Array
    const privKeyBytes = hexToBytes(keypair.privateKey);
    try {
      return await generateIdentityFile(
        {
          motebitId: this.motebitId,
          ownerId: this.motebitId,
          publicKeyHex: this.publicKey,
          governance,
          memory,
          devices,
        },
        privKeyBytes,
      );
    } finally {
      secureErase(privKeyBytes);
    }
  }

  /** Verify a motebit.md identity file's Ed25519 signature. */
  async verifyIdentityFile(content: string): Promise<{ valid: boolean; error?: string }> {
    const result = await verifyIdentity(content, { expectedType: "identity" });
    const error = result.errors?.[0]?.message;
    return error !== undefined ? { valid: result.valid, error } : { valid: result.valid };
  }

  /**
   * Rotate the Ed25519 keypair: generate a new keypair, create a signed
   * succession record (both old and new keys sign), update the identity
   * file, store the new private key in keyring, and update the config
   * with the new public key. Returns the old and new public key
   * fingerprints and the cumulative rotation count (length of the
   * succession chain in the identity file).
   *
   * Best-effort relay update at the end — if a sync URL is configured,
   * POST the new public key so the relay's device registration stays
   * current. Failure of the relay update does not fail the rotation.
   */
  async rotateKey(
    invoke: InvokeFn,
    reason?: string,
  ): Promise<{ oldKeyFingerprint: string; newKeyFingerprint: string; rotationCount: number }> {
    const oldKeypair = await this.getDeviceKeypair(invoke);
    if (!oldKeypair) throw new Error("No device keypair available");

    const oldPrivKeyBytes = hexToBytes(oldKeypair.privateKey);
    const oldPubKeyBytes = hexToBytes(oldKeypair.publicKey);

    try {
      // Read config and identity file
      const raw = await invoke<string>("read_config");
      const configData = JSON.parse(raw) as Record<string, unknown>;
      const existingIdentityFile = configData._identity_file as string | undefined;

      // Generate new keypair, sign succession, rotate identity file
      let newPubKeyHex: string;
      let newPrivKeyHex: string;
      if (existingIdentityFile != null && existingIdentityFile !== "") {
        const rotateResult = await rotateIdentityKeys({
          oldPrivateKey: oldPrivKeyBytes,
          oldPublicKey: oldPubKeyBytes,
          reason,
        });
        const rotatedContent = await rotateIdentityFile({
          existingContent: existingIdentityFile,
          newPublicKey: rotateResult.newPublicKey,
          newPrivateKey: rotateResult.newPrivateKey,
          successionRecord: rotateResult.successionRecord,
        });
        configData._identity_file = rotatedContent;
        newPubKeyHex = rotateResult.newPublicKeyHex;
        newPrivKeyHex = bytesToHex(rotateResult.newPrivateKey);
        secureErase(rotateResult.newPrivateKey);
      } else {
        // No identity file — generate raw keypair for device key rotation only
        const { generateKeypair } = await import("@motebit/encryption");
        const newKeypair = await generateKeypair();
        newPubKeyHex = bytesToHex(newKeypair.publicKey);
        newPrivKeyHex = bytesToHex(newKeypair.privateKey);
        secureErase(newKeypair.privateKey);
      }

      // Store new private key in keyring
      await invoke<void>("keyring_set", { key: "device_private_key", value: newPrivKeyHex });

      // Update config with new public key
      configData.device_public_key = newPubKeyHex;
      await invoke<void>("write_config", { json: JSON.stringify(configData) });

      // Update in-memory state
      const oldKeyFingerprint = this.publicKey.slice(0, 16);
      this.publicKey = newPubKeyHex;
      const newKeyFingerprint = newPubKeyHex.slice(0, 16);

      // Count rotations from identity file succession chain
      let rotationCount = 1;
      if (configData._identity_file != null && typeof configData._identity_file === "string") {
        try {
          const parsed = parseIdentityFile(configData._identity_file);
          const chain = (parsed.frontmatter as unknown as Record<string, unknown>).succession;
          if (Array.isArray(chain)) rotationCount = chain.length;
        } catch {
          // Non-fatal
        }
      }

      // Update relay if configured
      const syncUrl = configData.sync_url as string | undefined;
      const masterToken = configData.sync_master_token as string | undefined;
      if (syncUrl != null && syncUrl !== "") {
        try {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          if (masterToken) headers["Authorization"] = `Bearer ${masterToken}`;

          await fetch(`${syncUrl}/device/register`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              motebit_id: this.motebitId,
              device_name: "Desktop",
              public_key: newPubKeyHex,
            }),
          });
        } catch {
          // Non-fatal — relay update is best-effort
        }
      }

      return { oldKeyFingerprint, newKeyFingerprint, rotationCount };
    } finally {
      secureErase(oldPrivKeyBytes);
    }
  }

  // === Pairing: Device A (existing device) ===

  /**
   * Initiate a pairing session. Returns a 6-char code to display to the
   * user (they type it into Device B).
   */
  async initiatePairing(
    invoke: InvokeFn,
    syncUrl: string,
  ): Promise<{ pairingCode: string; pairingId: string }> {
    const keypair = await this.getDeviceKeypair(invoke);
    if (!keypair) throw new Error("No device keypair available");

    const token = await this.createSyncToken(keypair.privateKey, "device:auth");
    const client = new PairingClient({ relayUrl: syncUrl });
    const result = await client.initiate(token);
    return { pairingCode: result.pairingCode, pairingId: result.pairingId };
  }

  /** Get the current state of a pairing session (Device A polls for claim). */
  async getPairingSession(
    invoke: InvokeFn,
    syncUrl: string,
    pairingId: string,
  ): Promise<PairingSession> {
    const keypair = await this.getDeviceKeypair(invoke);
    if (!keypair) throw new Error("No device keypair available");

    const token = await this.createSyncToken(keypair.privateKey, "device:auth");
    const client = new PairingClient({ relayUrl: syncUrl });
    return client.getSession(pairingId, token);
  }

  /** Approve a claimed pairing session, registering Device B. Encrypts identity key if Device B supports key transfer. */
  async approvePairing(
    invoke: InvokeFn,
    syncUrl: string,
    pairingId: string,
  ): Promise<{ deviceId: string }> {
    const keypair = await this.getDeviceKeypair(invoke);
    if (!keypair) throw new Error("No device keypair available");

    const token = await this.createSyncToken(keypair.privateKey, "device:auth");
    const client = new PairingClient({ relayUrl: syncUrl });

    // Check if Device B supports key transfer (sent X25519 ephemeral key with claim)
    let keyTransfer: KeyTransferPayload | undefined;
    const session = await client.getSession(pairingId, token);
    if (session.claiming_x25519_pubkey) {
      const privKeyBytes = hexToBytes(keypair.privateKey);
      try {
        keyTransfer = await buildKeyTransferPayload(
          privKeyBytes,
          keypair.publicKey,
          hexToBytes(session.claiming_x25519_pubkey),
          session.pairing_code,
        );
      } finally {
        secureErase(privKeyBytes);
      }
    }

    const result = await client.approve(pairingId, token, keyTransfer);
    return { deviceId: result.deviceId };
  }

  /** Deny a claimed pairing session. */
  async denyPairing(invoke: InvokeFn, syncUrl: string, pairingId: string): Promise<void> {
    const keypair = await this.getDeviceKeypair(invoke);
    if (!keypair) throw new Error("No device keypair available");

    const token = await this.createSyncToken(keypair.privateKey, "device:auth");
    const client = new PairingClient({ relayUrl: syncUrl });
    await client.deny(pairingId, token);
  }

  // === Pairing: Device B (new device) ===

  /**
   * Claim a pairing session using a code from Device A.
   * Generates an ephemeral X25519 keypair for identity key transfer.
   * Returns the ephemeral private key — caller must hold it until completePairing.
   */
  async claimPairing(
    syncUrl: string,
    code: string,
  ): Promise<{ pairingId: string; motebitId: string; ephemeralPrivateKey: Uint8Array }> {
    if (!this.publicKey) throw new Error("No public key available — bootstrap first");

    const ephemeral = generateX25519Keypair();
    const client = new PairingClient({ relayUrl: syncUrl });
    const result = await client.claim(
      code.toUpperCase(),
      "Desktop",
      this.publicKey,
      bytesToHex(ephemeral.publicKey),
    );
    return { ...result, ephemeralPrivateKey: ephemeral.privateKey };
  }

  /** Poll for pairing approval status (Device B). */
  async pollPairingStatus(syncUrl: string, pairingId: string): Promise<PairingStatus> {
    const client = new PairingClient({ relayUrl: syncUrl });
    return client.pollStatus(pairingId);
  }

  /**
   * Complete pairing by storing the received identity (Device B). Writes
   * the adopted motebitId + deviceId to the Tauri config AND to this
   * manager's instance state — which the DesktopApp reads via getters,
   * so every downstream consumer (sync, identity-file, goals, …) picks
   * up the new identity without needing to restart.
   *
   * If key transfer payload + ephemeral key + pairing code are provided,
   * decrypts the identity seed and replaces the device's private key —
   * both devices then derive the same Solana address.
   */
  /**
   * @returns A wallet warning string if key transfer was skipped due to
   * existing funds at the old address, or undefined if wallet was unified
   * (or no key transfer was attempted).
   */
  async completePairing(
    invoke: InvokeFn,
    result: { motebitId: string; deviceId: string },
    keyTransferOpts?: {
      keyTransfer: KeyTransferPayload;
      ephemeralPrivateKey: Uint8Array;
      pairingCode: string;
      syncUrl: string;
      pairingId: string;
    },
  ): Promise<string | undefined> {
    const raw = await invoke<string>("read_config");
    const config = JSON.parse(raw) as Record<string, unknown>;
    let walletWarning: string | undefined;

    let updatedConfig: Record<string, unknown> = {
      ...config,
      motebit_id: result.motebitId,
      device_id: result.deviceId,
    };

    // Decrypt and install the identity key if key transfer is available
    if (keyTransferOpts) {
      const { keyTransfer, ephemeralPrivateKey, pairingCode, syncUrl, pairingId } = keyTransferOpts;
      try {
        const identitySeed = await decryptKeyTransfer(
          keyTransfer,
          ephemeralPrivateKey,
          pairingCode,
        );
        try {
          // Safety check: refuse key transfer if old wallet has funds
          const oldPrivKeyHex = await invoke<string>("keyring_get", { key: "device_private_key" });
          if (oldPrivKeyHex) {
            const oldSeedBytes = hexToBytes(oldPrivKeyHex);
            try {
              const walletCheck = await checkPreTransferBalance(oldSeedBytes, identitySeed);
              if (walletCheck.hasAnyValue) {
                walletWarning = formatWalletWarning(walletCheck);
              }
            } finally {
              secureErase(oldSeedBytes);
            }
          }

          if (!walletWarning) {
            // Replace private key in OS keyring
            const newPrivHex = bytesToHex(identitySeed);
            await invoke<void>("keyring_set", { key: "device_private_key", value: newPrivHex });

            // The new public key is identity_pubkey_check (verified during decryption)
            const newPubHex = keyTransfer.identity_pubkey_check;
            updatedConfig = { ...updatedConfig, device_public_key: newPubHex };
            this.publicKey = newPubHex;

            // Update the relay's device registration with the new public key
            const client = new PairingClient({ relayUrl: syncUrl });
            await client.updateDeviceKey(pairingId, newPubHex);
          }
        } finally {
          secureErase(identitySeed);
        }
      } catch (err) {
        console.warn("Key transfer failed, device keeps its own keypair:", err);
      } finally {
        secureErase(ephemeralPrivateKey);
      }
    }

    await invoke<void>("write_config", { json: JSON.stringify(updatedConfig) });

    this.motebitId = result.motebitId;
    this.deviceId = result.deviceId;
    return walletWarning;
  }
}

/**
 * Decode a hex string to a `Uint8Array`. Used by every identity path
 * that has to temporarily materialize a private key from its stored
 * hex form. Private key bytes should always be wiped with `secureErase`
 * in a `finally` block after use.
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
