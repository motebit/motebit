/**
 * PairingClient — HTTP client for the relay-mediated cross-device pairing protocol.
 *
 * Two roles:
 * - Device A (existing): initiate → show code → poll → approve/deny
 * - Device B (new): claim with code → poll status → complete pairing
 */

export interface PairingClientConfig {
  relayUrl: string;
}

export interface PairingSession {
  pairing_id: string;
  motebit_id: string;
  status: "pending" | "claimed" | "approved" | "denied";
  pairing_code: string;
  claiming_device_name?: string;
  claiming_public_key?: string;
  /** Device B's ephemeral X25519 public key for key transfer (64-char hex). */
  claiming_x25519_pubkey?: string;
  created_at: number;
  expires_at: number;
}

export interface PairingStatus {
  status: "pending" | "claimed" | "approved" | "denied";
  motebit_id?: string;
  device_id?: string;
  /** Encrypted identity key transfer payload — present when approved + key transfer available. */
  key_transfer?: import("@motebit/protocol").KeyTransferPayload;
}

export class PairingClient {
  private relayUrl: string;

  constructor(config: PairingClientConfig) {
    this.relayUrl = config.relayUrl.replace(/\/$/, "");
  }

  /**
   * Device A: initiate a pairing session. Returns a pairing code to display.
   */
  async initiate(
    authToken: string,
  ): Promise<{ pairingId: string; pairingCode: string; expiresAt: number }> {
    const res = await fetch(`${this.relayUrl}/pairing/initiate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
      throw new Error(err.error ?? `Pairing initiate failed: ${res.status}`);
    }
    const body = (await res.json()) as {
      pairing_id: string;
      pairing_code: string;
      expires_at: number;
    };
    return {
      pairingId: body.pairing_id,
      pairingCode: body.pairing_code,
      expiresAt: body.expires_at,
    };
  }

  /**
   * Device B: claim a pairing session using the code shown on Device A.
   * No auth required — Device B doesn't have credentials yet.
   */
  async claim(
    code: string,
    deviceName: string,
    publicKey: string,
    /** Ephemeral X25519 public key for identity key transfer (64-char hex). */
    x25519PublicKey?: string,
  ): Promise<{ pairingId: string; motebitId: string }> {
    const reqBody: Record<string, string> = {
      pairing_code: code,
      device_name: deviceName,
      public_key: publicKey,
    };
    if (x25519PublicKey) reqBody.x25519_pubkey = x25519PublicKey;
    const res = await fetch(`${this.relayUrl}/pairing/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
      throw new Error(err.error ?? `Pairing claim failed: ${res.status}`);
    }
    const result = (await res.json()) as { pairing_id: string; motebit_id: string };
    return { pairingId: result.pairing_id, motebitId: result.motebit_id };
  }

  /**
   * Device A: get the current state of a pairing session.
   */
  async getSession(pairingId: string, authToken: string): Promise<PairingSession> {
    const res = await fetch(`${this.relayUrl}/pairing/${pairingId}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
      throw new Error(err.error ?? `Failed to get pairing session: ${res.status}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    return data as unknown as PairingSession;
  }

  /**
   * Device A: approve a claimed pairing session, registering Device B.
   */
  async approve(
    pairingId: string,
    authToken: string,
    /** Encrypted identity key transfer payload (Device A → Device B). */
    keyTransfer?: import("@motebit/protocol").KeyTransferPayload,
  ): Promise<{ deviceId: string; motebitId: string }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${authToken}` };
    let body: string | undefined;
    if (keyTransfer) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({ key_transfer: keyTransfer });
    }
    const res = await fetch(`${this.relayUrl}/pairing/${pairingId}/approve`, {
      method: "POST",
      headers,
      body,
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
      throw new Error(err.error ?? `Pairing approve failed: ${res.status}`);
    }
    const result = (await res.json()) as {
      device_id: string;
      motebit_id: string;
    };
    return { deviceId: result.device_id, motebitId: result.motebit_id };
  }

  /**
   * Device A: deny a claimed pairing session.
   */
  async deny(pairingId: string, authToken: string): Promise<void> {
    const res = await fetch(`${this.relayUrl}/pairing/${pairingId}/deny`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
      throw new Error(err.error ?? `Pairing deny failed: ${res.status}`);
    }
  }

  /**
   * Device B: poll for approval status. No auth required.
   */
  async pollStatus(pairingId: string): Promise<PairingStatus> {
    const res = await fetch(`${this.relayUrl}/pairing/${pairingId}/status`);
    if (!res.ok) {
      const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
      throw new Error(err.error ?? `Pairing status poll failed: ${res.status}`);
    }
    return res.json() as Promise<PairingStatus>;
  }

  /**
   * Device B: update device public key after identity key transfer.
   * Called after Device B decrypts the identity seed and derives the new Ed25519 public key.
   * The relay updates DeviceRegistration.public_key for the approved device.
   */
  async updateDeviceKey(pairingId: string, newPublicKey: string): Promise<void> {
    const res = await fetch(`${this.relayUrl}/pairing/${pairingId}/update-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ public_key: newPublicKey }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
      throw new Error(err.error ?? `Device key update failed: ${res.status}`);
    }
  }
}
