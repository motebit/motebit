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
import { migrateMotebitIdSql } from "./tauri-storage.js";
import type { PairingSession, PairingStatus } from "@motebit/sync-engine";
import { PairingClient } from "@motebit/sync-engine";
import {
  bootstrapIdentity as sharedBootstrapIdentity,
  writeRestoredIdentity,
  type BootstrapConfigStore,
  type BootstrapKeyStore,
} from "@motebit/core-identity";
import {
  mintAudienceToken,
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
import { APPROVAL_PRESET_CONFIGS } from "@motebit/sdk";
import {
  generate as generateIdentityFile,
  importIdentityFile as importIdentityFileFromContent,
  parse as parseIdentityFile,
  validateRestoreRequest,
  verify as verifyIdentity,
  type ImportIdentityResult,
  type RestoreIdentityRequest,
  type RestoreIdentityResult,
} from "@motebit/identity-file";
import { rotateDesktopKey } from "./key-rotation";
import { updateConfig } from "./config-update";
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
   * Set when bootstrap detected divergent state — see
   * `BootstrapResult.divergedFromMotebitId` in `@motebit/core-identity`.
   * Surfaces UI reads this via DesktopApp.divergedFromMotebitId to show
   * the recovery banner with restore CTAs.
   */
  divergedFromMotebitId: string | null = null;

  /**
   * Bootstrap identity on first launch or load existing identity.
   * Must be called before initAI() when running in Tauri. On first
   * launch, generates a keypair, writes to keyring, and emits a
   * signed `motebit.md` identity file into the Tauri config. On
   * subsequent launches, reads the existing identity from config +
   * keyring.
   */
  async bootstrap(invoke: InvokeFn): Promise<BootstrapResult> {
    // A restore or key-transfer pairing interrupted between its key write
    // and its config write is finished before anything reads either half.
    await finishInterruptedIdentitySwitch(invoke);

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
        // Never bind a new identity over the CLI's: the shared config's
        // `cli_encrypted_key` is that identity's only key copy, and moving
        // `motebit_id` off it orphans it. (Rust keeps the old file whenever
        // binding fields change; this refuses the change outright.)
        const current = JSON.parse(await invoke<string>("read_config")) as Record<string, unknown>;
        if (holdsCliKey(current) && current.motebit_id !== state.motebit_id) {
          throw new Error(cliIdentityRefusal(current, await retiredKeyrings(invoke)));
        }
        await updateConfig(invoke, { ...state });
      },
    };

    const keyStore: BootstrapKeyStore = {
      async storePrivateKey(privKeyHex) {
        // Rust's keyring_set stores in ~/.motebit/dev-keyring.json (0600,
        // atomic; the OS keychain is not used yet); a previous value is
        // preserved first. A resolved promise means it is durable.
        await invoke<void>("keyring_set", { key: "device_private_key", value: privKeyHex });
      },
      async hasPrivateKey() {
        // R1: only a TRUE absence is `false`. A key file that cannot be
        // read, or is damaged, makes keyring_get reject — and
        // that rejection propagates, so bootstrap stops instead of treating
        // the identity as orphaned and minting over it.
        const val = await invoke<string | null>("keyring_get", { key: "device_private_key" });
        const present = val != null && val !== "";
        if (!present) {
          const current = JSON.parse(await invoke<string>("read_config")) as Record<
            string,
            unknown
          >;
          if (holdsCliKey(current)) {
            throw new Error(cliIdentityRefusal(current, await retiredKeyrings(invoke)));
          }
        }
        return present;
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
    this.divergedFromMotebitId = result.divergedFromMotebitId ?? null;

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
            // A previous identity's `_identity_file` (a divergence-mint) is
            // binding material: Rust keeps the old config before replacing it.
            await updateConfig(invoke, { _identity_file: identityFileContent });
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
      return (
        await mintAudienceToken({ mid: this.motebitId, did: this.deviceId, aud }, privKeyBytes)
      ).token;
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
    const presetGov =
      APPROVAL_PRESET_CONFIGS[preset ?? "balanced"] ?? APPROVAL_PRESET_CONFIGS.balanced!;
    const governance = {
      trust_mode: (preset === "autonomous" ? "full" : "guarded") as "full" | "guarded" | "minimal",
      max_risk_auto: RISK_NAMES[presetGov.requireApprovalAbove]!,
      require_approval_above: RISK_NAMES[presetGov.requireApprovalAbove]!,
      deny_above: RISK_NAMES[presetGov.denyAbove]!,
      operator_mode: false,
    };

    // Map memory_governance config → identity-file memory fields
    const memGov = configData.memory_governance as
      { persistence_threshold?: number; reject_secrets?: boolean } | undefined;
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

  // Parse + verify a motebit.md and return the flat metadata the Restore
  // UI consumes (motebit_id, bornAt, public key, devices, governance,
  // memory). Pure read — no state mutation. The .md is structurally
  // public; the private key still has to come from a separate recovery
  // seed paste before any restore can proceed.
  async importIdentityFile(content: string): Promise<ImportIdentityResult> {
    return importIdentityFileFromContent(content);
  }

  // Side-effecting restore: materialize an imported identity onto this
  // device. Writes the new private key to the key store, motebit_id +
  // device_id + device_public_key to the Tauri config file, and the
  // original signed motebit.md content to the `_identity_file` config
  // slot so bootstrap reads governance from its cryptographic anchor on
  // next launch.
  //
  // When `preserveMemories=true`, the four memory-shaped SQLite tables
  // (conversations / memory_nodes / plans / agent_trust) are re-keyed
  // from the old motebit_id to the new BEFORE the config write. The
  // signed-trail tables (events / audit_log / issued_credentials) are
  // intentionally orphaned so the cryptographic chain to the old
  // identity stays honest about authorship.
  async restoreIdentity(
    invoke: InvokeFn,
    request: RestoreIdentityRequest,
  ): Promise<RestoreIdentityResult> {
    const failureReason = await validateRestoreRequest(request);
    if (failureReason !== null) {
      return { ok: false, reason: failureReason };
    }

    if (request.preserveMemories) {
      try {
        const raw = await invoke<string>("read_config");
        const config = JSON.parse(raw) as Record<string, unknown>;
        const oldMotebitId = typeof config.motebit_id === "string" ? config.motebit_id : null;
        if (oldMotebitId !== null && oldMotebitId !== "") {
          await migrateMotebitIdSql(invoke, oldMotebitId, request.metadata.motebitId);
        }
      } catch {
        return { ok: false, reason: "memory_migration_failed" };
      }
    }

    // Pre-write the IdentityCreated event with the historical bornAt
    // so the next bootstrap's "loaded" path returns the original
    // creation timestamp instead of fabricating Date.now(). See the
    // helper's JSDoc in @motebit/core-identity for the doctrine.
    // Best-effort: failure falls through to the Date.now() event on
    // next bootstrap's auto-recover path.
    const bornAtMs = Date.parse(request.metadata.bornAt);
    if (Number.isFinite(bornAtMs)) {
      try {
        const storage = createTauriStorage(invoke);
        await writeRestoredIdentity({
          identityStorage: storage.identityStorage,
          eventStoreAdapter: storage.eventStore,
          motebitId: request.metadata.motebitId,
          ownerId: "Desktop",
          bornAtMs,
        });
      } catch {
        // Best-effort. The user's identity restore still proceeds.
      }
    }

    const newDeviceId = crypto.randomUUID();
    const sw: IdentitySwitch = {
      motebit_id: request.metadata.motebitId,
      device_id: newDeviceId,
      device_public_key: request.metadata.publicKey,
      private_key_hex: request.privateKeyHex,
      // Seed-only restore: the old identity file names the replaced
      // identity; bootstrap regenerates one from the new keypair. (The old
      // one is kept with the replaced config, never destroyed.)
      identity_file: request.originalContent !== undefined ? request.originalContent : null,
    };
    try {
      // Written ahead first: from here on a crash is finished at the next
      // launch, so the key and the config can never be left mismatched.
      await invoke<void>("keyring_set", { key: SWITCH_KEY, value: JSON.stringify(sw) });
    } catch {
      return { ok: false, reason: "keystore_write_failed" };
    }
    try {
      await applyIdentitySwitch(invoke, sw);
    } catch {
      // The write-ahead stays; the next launch finishes the switch.
      return { ok: false, reason: "config_write_failed" };
    }
    return { ok: true, motebitId: request.metadata.motebitId, needsReload: true };
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
    // The state machine lives in @motebit/surface-kit (#709): read the relay
    // first, write the new key ahead, submit signed by the RETIRING key,
    // commit only after the relay confirms. The old path posted the new key
    // to /device/register with an operator token and recorded no succession.
    const oldKeyFingerprint = this.publicKey.slice(0, 16);
    const { newPublicKeyHex } = await rotateDesktopKey({
      invoke,
      motebitId: this.motebitId,
      deviceId: this.deviceId,
      onCommitted: (publicKeyHex) => {
        this.publicKey = publicKeyHex;
      },
      ...(reason !== undefined ? { reason } : {}),
    });
    // Count rotations from the identity file's succession chain.
    let rotationCount = 1;
    try {
      const raw = await invoke<string>("read_config");
      const configData = JSON.parse(raw) as Record<string, unknown>;
      if (typeof configData._identity_file === "string") {
        const parsed = parseIdentityFile(configData._identity_file);
        const chain = (parsed.frontmatter as unknown as Record<string, unknown>).succession;
        if (Array.isArray(chain)) rotationCount = chain.length;
      }
    } catch {
      // Non-fatal
    }
    return { oldKeyFingerprint, newKeyFingerprint: newPublicKeyHex.slice(0, 16), rotationCount };
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
    let walletWarning: string | undefined;

    const sw: IdentitySwitch = {
      motebit_id: result.motebitId,
      device_id: result.deviceId,
    };
    let adoptedPublicKey: string | undefined;

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
            // The adopted key replaces this device's key through the
            // identity-switch write-ahead below (the replaced key is kept).
            // The new public key is identity_pubkey_check (verified during decryption).
            const newPubHex = keyTransfer.identity_pubkey_check;
            sw.private_key_hex = bytesToHex(identitySeed);
            sw.device_public_key = newPubHex;
            adoptedPublicKey = newPubHex;

            // Update the relay's device registration with the new public key
            const client = new PairingClient({ relayUrl: syncUrl });
            await client.updateDeviceKey(pairingId, newPubHex);
          }
        } finally {
          secureErase(identitySeed);
        }
      } catch (err) {
        // eslint-disable-next-line no-console -- operator diagnostic: recoverable key-transfer degradation
        console.warn("Key transfer failed, device keeps its own keypair:", err);
      } finally {
        secureErase(ephemeralPrivateKey);
      }
    }

    // One switch: the old identity's rotation write-ahead is set aside, the
    // replaced key and binding are kept, and a crash is finished at launch.
    await switchIdentity(invoke, sw);

    if (adoptedPublicKey !== undefined) this.publicKey = adoptedPublicKey;
    this.motebitId = result.motebitId;
    this.deviceId = result.deviceId;
    return walletWarning;
  }
}

// ---------------------------------------------------------------------------
// Identity switch (restore, key-transfer pairing) — a write-ahead so the
// key write and the config write can never be left half-done.
// ---------------------------------------------------------------------------

const SWITCH_KEY = "pending_identity_switch";

/** What an identity switch installs. `identity_file: null` removes it. */
export interface IdentitySwitch {
  motebit_id: string;
  device_id: string;
  device_public_key?: string;
  /** Present ⇒ `device_private_key` is replaced (the old one is kept by Rust). */
  private_key_hex?: string;
  /** Present ⇒ `_identity_file` is set (string) or removed (null). */
  identity_file?: string | null;
}

/**
 * Switch this device to another identity.
 *
 *  1. The whole switch is written ahead to the key store (key material,
 *     so Rust preserves anything it replaces there).
 *  2. The outgoing identity's rotation write-ahead is SET ASIDE (kept as
 *     `pending_rotation.preserved-<time>`, never deleted): left active, the
 *     next rotation would treat it as stale and clear it (C7).
 *  3. The key, then the config (Rust keeps the replaced key as
 *     `device_private_key.preserved-<time>` and the replaced config as
 *     `config.json.clobbered-<time>`).
 *  4. The write-ahead is removed (kept as preserved, like all key material).
 *
 * A crash anywhere after (1) is finished by the next bootstrap
 * (`finishInterruptedIdentitySwitch`); before (1) nothing has changed.
 */
export async function switchIdentity(invoke: InvokeFn, sw: IdentitySwitch): Promise<void> {
  await invoke<void>("keyring_set", { key: SWITCH_KEY, value: JSON.stringify(sw) });
  await applyIdentitySwitch(invoke, sw);
}

async function applyIdentitySwitch(invoke: InvokeFn, sw: IdentitySwitch): Promise<void> {
  await invoke<void>("keyring_set_aside", { key: "pending_rotation" });
  if (sw.private_key_hex !== undefined) {
    await invoke<void>("keyring_set", { key: "device_private_key", value: sw.private_key_hex });
  }
  const patch: Record<string, unknown> = {
    motebit_id: sw.motebit_id,
    device_id: sw.device_id,
  };
  if (sw.device_public_key !== undefined) patch.device_public_key = sw.device_public_key;
  if (sw.identity_file !== undefined) patch._identity_file = sw.identity_file;
  await updateConfig(invoke, patch);
  await invoke<void>("keyring_set_aside", { key: SWITCH_KEY });
}

/**
 * Finish a switch the last run started. An unreadable write-ahead stops
 * bootstrap (R1: it may be the only record of which key is current).
 */
export async function finishInterruptedIdentitySwitch(invoke: InvokeFn): Promise<void> {
  const raw = await invoke<string | null>("keyring_get", { key: SWITCH_KEY });
  if (raw == null || raw === "") return;
  let sw: IdentitySwitch;
  try {
    sw = JSON.parse(raw) as IdentitySwitch;
  } catch (err) {
    throw new Error(
      `An interrupted identity switch (${SWITCH_KEY}) is held in the key store but cannot be read; nothing was changed.`,
      { cause: err },
    );
  }
  if (typeof sw.motebit_id !== "string" || typeof sw.device_id !== "string") {
    throw new Error(
      `An interrupted identity switch (${SWITCH_KEY}) is held in the key store but is malformed; nothing was changed.`,
    );
  }
  await applyIdentitySwitch(invoke, sw);
}

function holdsCliKey(config: Record<string, unknown>): boolean {
  const present = (v: unknown) => v != null && v !== "";
  return present(config.cli_encrypted_key) || present(config.cli_private_key);
}

function cliIdentityRefusal(config: Record<string, unknown>, retired: string[]): string {
  const id = typeof config.motebit_id === "string" ? config.motebit_id : "(no id)";
  // A listing, never an inference: `motebit migrate-keyring` moves this
  // desktop's whole dev-keyring.json aside to these names.
  const moved =
    retired.length > 0
      ? `This desktop's own key may be in ${retired.join(", ")} (a keyring \`motebit migrate-keyring\` moved aside); ` +
        `moving that file back to ~/.motebit/dev-keyring.json recovers it. `
      : "";
  return (
    `~/.motebit/config.json holds the motebit CLI's identity ${id} and its only key copy, ` +
    `and this desktop has no key for it. The desktop will not mint a new identity over it. ` +
    moved +
    `To use that identity here, restore it from its recovery seed (Settings → Identity → Restore). ` +
    `Nothing was changed.`
  );
}

/** `dev-keyring.json.migrated-*` paths, for the refusal message; [] if the listing fails. */
async function retiredKeyrings(invoke: InvokeFn): Promise<string[]> {
  try {
    const got = await invoke<unknown>("keyring_retired_copies");
    return Array.isArray(got) ? got.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
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
