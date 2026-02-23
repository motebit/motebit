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
  created_at: number;
  expires_at: number;
}

export interface PairingStatus {
  status: "pending" | "claimed" | "approved" | "denied";
  motebit_id?: string;
  device_id?: string;
  device_token?: string;
}

export class PairingClient {
  private relayUrl: string;

  constructor(config: PairingClientConfig) {
    this.relayUrl = config.relayUrl.replace(/\/$/, "");
  }

  /**
   * Device A: initiate a pairing session. Returns a pairing code to display.
   */
  async initiate(authToken: string): Promise<{ pairingId: string; pairingCode: string; expiresAt: number }> {
    const res = await fetch(`${this.relayUrl}/pairing/initiate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(err.error ?? `Pairing initiate failed: ${res.status}`);
    }
    const body = await res.json() as { pairing_id: string; pairing_code: string; expires_at: number };
    return { pairingId: body.pairing_id, pairingCode: body.pairing_code, expiresAt: body.expires_at };
  }

  /**
   * Device B: claim a pairing session using the code shown on Device A.
   * No auth required — Device B doesn't have credentials yet.
   */
  async claim(code: string, deviceName: string, publicKey: string): Promise<{ pairingId: string; motebitId: string }> {
    const res = await fetch(`${this.relayUrl}/pairing/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairing_code: code, device_name: deviceName, public_key: publicKey }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(err.error ?? `Pairing claim failed: ${res.status}`);
    }
    const body = await res.json() as { pairing_id: string; motebit_id: string };
    return { pairingId: body.pairing_id, motebitId: body.motebit_id };
  }

  /**
   * Device A: get the current state of a pairing session.
   */
  async getSession(pairingId: string, authToken: string): Promise<PairingSession> {
    const res = await fetch(`${this.relayUrl}/pairing/${pairingId}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(err.error ?? `Failed to get pairing session: ${res.status}`);
    }
    return res.json() as Promise<PairingSession>;
  }

  /**
   * Device A: approve a claimed pairing session, registering Device B.
   */
  async approve(pairingId: string, authToken: string): Promise<{ deviceId: string; deviceToken: string; motebitId: string }> {
    const res = await fetch(`${this.relayUrl}/pairing/${pairingId}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(err.error ?? `Pairing approve failed: ${res.status}`);
    }
    const body = await res.json() as { device_id: string; device_token: string; motebit_id: string };
    return { deviceId: body.device_id, deviceToken: body.device_token, motebitId: body.motebit_id };
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
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(err.error ?? `Pairing deny failed: ${res.status}`);
    }
  }

  /**
   * Device B: poll for approval status. No auth required.
   */
  async pollStatus(pairingId: string): Promise<PairingStatus> {
    const res = await fetch(`${this.relayUrl}/pairing/${pairingId}/status`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(err.error ?? `Pairing status poll failed: ${res.status}`);
    }
    return res.json() as Promise<PairingStatus>;
  }
}
