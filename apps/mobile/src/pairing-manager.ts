/**
 * Mobile pairing manager — owns the pairing-client lifecycle for
 * device-to-device identity transfer via the relay.
 *
 * Extracted from `mobile-app.ts` as Target 4 of the mobile extraction
 * plan. Pairing is the identity-transfer flow: Device A (existing)
 * mints a code; Device B (new) claims it; A approves; B completes by
 * writing the pinned motebit_id + device_id to its own keyring.
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
import type { SecureStoreAdapter } from "./adapters/secure-store";
import { KEYRING_KEYS } from "./storage-keys";

export interface PairingManagerDeps {
  getKeyring: () => SecureStoreAdapter;
  getPublicKey: () => string;
  /** Create a short-lived signed auth token. Aud should be "device:auth". */
  createSyncToken: (aud: string) => Promise<string>;
  /** Write back motebitId + deviceId after a successful completePairing. */
  setIdentity: (motebitId: string, deviceId: string) => void;
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
    const result = await client.approve(pairingId, token);
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
  ): Promise<{ pairingId: string; motebitId: string }> {
    const publicKey = this.deps.getPublicKey();
    if (!publicKey) throw new Error("No public key available — bootstrap first");
    const client = new PairingClient({ relayUrl: syncUrl });
    return client.claim(code.toUpperCase(), "Mobile", publicKey);
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
   */
  async completePairing(
    result: { motebitId: string; deviceId: string },
    syncUrl?: string,
  ): Promise<void> {
    const keyring = this.deps.getKeyring();
    await keyring.set(KEYRING_KEYS.motebitId, result.motebitId);
    await keyring.set("device_id", result.deviceId);

    // Auth uses signed JWTs — no device_token storage needed
    this.deps.setIdentity(result.motebitId, result.deviceId);

    if (syncUrl != null && syncUrl !== "") {
      await this.deps.setSyncUrl(syncUrl);
    }
  }
}
