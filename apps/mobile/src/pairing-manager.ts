/**
 * Mobile pairing manager — owns the pairing-client lifecycle for
 * device-to-device identity transfer via the relay.
 *
 * Pairing is the identity-transfer flow: Device A (existing) mints a
 * code; Device B (new) claims it; A approves; B completes by writing
 * the pinned motebit_id + device_id to its own keyring.
 *
 * ### State ownership
 *
 * The manager is stateless — each pairing method constructs a fresh
 * `PairingClient` per call. All persistent identity state lives on
 * `MobileApp` (motebitId, deviceId, publicKey, keyring). The manager
 * receives access to that state through getter closures.
 *
 * Why extract something stateless? Because pairing is a coherent
 * vocabulary: 7 methods that cooperate around one protocol flow.
 * Grouping them makes the surface reviewable in one place and keeps
 * the keyring writes (completePairing) honest about their side effects.
 */

import { PairingClient } from "@motebit/sync-engine";
import type { PairingSession, PairingStatus } from "@motebit/sync-engine";
import {
  generateX25519Keypair,
  buildKeyTransferPayload,
  decryptKeyTransfer,
  checkPreTransferBalance,
  formatWalletWarning,
  secureErase,
  bytesToHex,
  hexToBytes,
} from "@motebit/crypto";
import type { KeyTransferPayload } from "@motebit/protocol";
import type { SecureStoreAdapter } from "./adapters/secure-store";
import { KEYRING_KEYS } from "./storage-keys";

export interface PairingManagerDeps {
  getKeyring: () => SecureStoreAdapter;
  getPublicKey: () => string;
  /** Retrieve the device's Ed25519 private key hex for key transfer (Device A side). */
  getPrivKeyHex: () => Promise<string>;
  /** Create a short-lived signed auth token. Aud should be "device:auth". */
  createSyncToken: (aud: string) => Promise<string>;
  /** Write back motebitId + deviceId after a successful completePairing. */
  setIdentity: (motebitId: string, deviceId: string) => void;
  /** Update the in-memory public key after key transfer. */
  setPublicKey: (pubKeyHex: string) => void;
  /** Persist the relay sync URL once the new device has joined. */
  setSyncUrl: (url: string) => Promise<void>;
}

export class MobilePairingManager {
  constructor(private deps: PairingManagerDeps) {}

  // === Device A (existing device) ===

  async initiatePairing(syncUrl: string): Promise<{ pairingCode: string; pairingId: string }> {
    const token = await this.deps.createSyncToken("device:auth");
    const client = new PairingClient({ relayUrl: syncUrl });
    const result = await client.initiate(token);
    return { pairingCode: result.pairingCode, pairingId: result.pairingId };
  }

  async getPairingSession(syncUrl: string, pairingId: string): Promise<PairingSession> {
    const token = await this.deps.createSyncToken("device:auth");
    const client = new PairingClient({ relayUrl: syncUrl });
    return client.getSession(pairingId, token);
  }

  async approvePairing(syncUrl: string, pairingId: string): Promise<{ deviceId: string }> {
    const token = await this.deps.createSyncToken("device:auth");
    const client = new PairingClient({ relayUrl: syncUrl });

    // Build key transfer payload if Device B supports it
    let keyTransfer: KeyTransferPayload | undefined;
    const session = await client.getSession(pairingId, token);
    if (session.claiming_x25519_pubkey) {
      const privKeyHex = await this.deps.getPrivKeyHex();
      const privKeyBytes = hexToBytes(privKeyHex);
      try {
        keyTransfer = await buildKeyTransferPayload(
          privKeyBytes,
          this.deps.getPublicKey(),
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

  async denyPairing(syncUrl: string, pairingId: string): Promise<void> {
    const token = await this.deps.createSyncToken("device:auth");
    const client = new PairingClient({ relayUrl: syncUrl });
    await client.deny(pairingId, token);
  }

  // === Device B (new device) ===

  async claimPairing(
    syncUrl: string,
    code: string,
  ): Promise<{ pairingId: string; motebitId: string; ephemeralPrivateKey: Uint8Array }> {
    const publicKey = this.deps.getPublicKey();
    if (!publicKey) throw new Error("No public key available — bootstrap first");
    const ephemeral = generateX25519Keypair();
    const client = new PairingClient({ relayUrl: syncUrl });
    const result = await client.claim(
      code.toUpperCase(),
      "Mobile",
      publicKey,
      bytesToHex(ephemeral.publicKey),
    );
    return { ...result, ephemeralPrivateKey: ephemeral.privateKey };
  }

  async pollPairingStatus(syncUrl: string, pairingId: string): Promise<PairingStatus> {
    const client = new PairingClient({ relayUrl: syncUrl });
    return client.pollStatus(pairingId);
  }

  /**
   * Finalize pairing on Device B: persist the pinned motebit_id + device_id
   * to the keyring and update in-memory identity state via `setIdentity`.
   * Optionally persist the sync relay URL so subsequent launches reconnect
   * automatically.
   *
   * If key transfer opts are provided, decrypts the identity seed and replaces
   * the device's private key — both devices then derive the same Solana address.
   */
  /**
   * @returns A wallet warning string if key transfer was skipped due to
   * existing funds, or undefined if wallet was unified (or no transfer attempted).
   */
  async completePairing(
    result: { motebitId: string; deviceId: string },
    syncUrl?: string,
    keyTransferOpts?: {
      keyTransfer: KeyTransferPayload;
      ephemeralPrivateKey: Uint8Array;
      pairingCode: string;
      pairingId: string;
    },
  ): Promise<string | undefined> {
    const keyring = this.deps.getKeyring();
    let walletWarning: string | undefined;
    await keyring.set(KEYRING_KEYS.motebitId, result.motebitId);
    await keyring.set("device_id", result.deviceId);

    // Decrypt and install identity key if key transfer is available
    if (keyTransferOpts) {
      const { keyTransfer, ephemeralPrivateKey, pairingCode, pairingId } = keyTransferOpts;
      try {
        const identitySeed = await decryptKeyTransfer(
          keyTransfer,
          ephemeralPrivateKey,
          pairingCode,
        );
        try {
          // Safety check: refuse key transfer if old wallet has funds
          const oldPrivKeyHex = await keyring.get("device_private_key");
          if (oldPrivKeyHex) {
            const oldSeedBytes = hexToBytes(oldPrivKeyHex);
            try {
              const walletCheck = await checkPreTransferBalance(oldSeedBytes, identitySeed);
              if (walletCheck.hasAnyValue) {
                walletWarning = formatWalletWarning(walletCheck);
                // Don't replace the key — user must sweep first
                // Fall through to finalize identity + sync without key transfer
              }
            } finally {
              secureErase(oldSeedBytes);
            }
          }

          if (!walletWarning) {
            const newPrivHex = bytesToHex(identitySeed);
            await keyring.set("device_private_key", newPrivHex);

            // Derive and update public key
            const { getPublicKeyAsync } = await import("@noble/ed25519");
            const newPub = await getPublicKeyAsync(identitySeed);
            const newPubHex = bytesToHex(newPub);
            this.deps.setPublicKey(newPubHex);

            // Update relay device registration with new public key
            if (syncUrl) {
              const client = new PairingClient({ relayUrl: syncUrl });
              await client.updateDeviceKey(pairingId, newPubHex);
            }
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

    this.deps.setIdentity(result.motebitId, result.deviceId);

    if (syncUrl != null && syncUrl !== "") {
      await this.deps.setSyncUrl(syncUrl);
    }
    return walletWarning;
  }
}
