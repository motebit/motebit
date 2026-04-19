/**
 * Migration endpoint tests — motebit/migration@1.0.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import {
  generateKeypair,
  bytesToHex,
  verify,
  canonicalJson,
  hexToBytes,
} from "@motebit/encryption";
import { signBalanceWaiver } from "@motebit/crypto";
import type { MigrationToken, DepartureAttestation, BalanceWaiver } from "@motebit/protocol";
import { creditAccount } from "../accounts.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

// === Helpers ===

async function registerAgent(relay: SyncRelay, motebitId: string, publicKeyHex: string) {
  await relay.app.request(`/api/v1/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      public_key: publicKeyHex,
    }),
  });
}

async function initiateMigration(
  relay: SyncRelay,
  motebitId: string,
): Promise<{ ok: boolean; migration_token: MigrationToken }> {
  const res = await relay.app.request(`/api/v1/agents/${motebitId}/migrate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ reason: "test migration" }),
  });
  return res.json() as Promise<{ ok: boolean; migration_token: MigrationToken }>;
}

// === Tests ===

describe("Migration: POST /api/v1/agents/:motebitId/migrate", () => {
  let relay: SyncRelay;
  let agentPubHex: string;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const kp = await generateKeypair();
    agentPubHex = bytesToHex(kp.publicKey);
    await registerAgent(relay, "migrate-agent", agentPubHex);
  });

  afterEach(async () => {
    await relay.close();
  });

  it("issues a signed MigrationToken", async () => {
    const { ok, migration_token } = await initiateMigration(relay, "migrate-agent");
    expect(ok).toBe(true);
    expect(migration_token.token_id).toBeTruthy();
    expect(migration_token.motebit_id).toBe("migrate-agent");
    expect(migration_token.source_relay_id).toBeTruthy();
    expect(migration_token.expires_at).toBeGreaterThan(Date.now());
    expect(migration_token.signature).toMatch(/^[0-9a-f]+$/);
  });

  it("token signature is verifiable with relay public key", async () => {
    const { migration_token } = await initiateMigration(relay, "migrate-agent");

    // Get relay public key from well-known
    const wkRes = await relay.app.request("/.well-known/motebit.json");
    const metadata = (await wkRes.json()) as { public_key: string };

    const { signature, ...payload } = migration_token;
    const canonical = canonicalJson(payload);
    const valid = await verify(
      hexToBytes(signature),
      new TextEncoder().encode(canonical),
      hexToBytes(metadata.public_key),
    );
    expect(valid).toBe(true);
  });

  it("rejects migration for nonexistent agent", async () => {
    const res = await relay.app.request(`/api/v1/agents/nonexistent/migrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("replaces previous migration token (§4.4)", async () => {
    const first = await initiateMigration(relay, "migrate-agent");
    const second = await initiateMigration(relay, "migrate-agent");
    expect(first.migration_token.token_id).not.toBe(second.migration_token.token_id);
  });
});

describe("Migration: GET attestation", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const kp = await generateKeypair();
    await registerAgent(relay, "att-agent", bytesToHex(kp.publicKey));
  });

  afterEach(async () => {
    await relay.close();
  });

  it("issues a signed DepartureAttestation", async () => {
    await initiateMigration(relay, "att-agent");

    const res = await relay.app.request(`/api/v1/agents/att-agent/migration/attestation`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; departure_attestation: DepartureAttestation };
    expect(body.ok).toBe(true);

    const att = body.departure_attestation;
    expect(att.motebit_id).toBe("att-agent");
    expect(att.source_relay_id).toBeTruthy();
    expect(att.trust_level).toBeTruthy();
    expect(typeof att.successful_tasks).toBe("number");
    expect(typeof att.failed_tasks).toBe("number");
    expect(typeof att.credentials_issued).toBe("number");
    expect(att.signature).toMatch(/^[0-9a-f]+$/);
  });

  it("attestation signature is verifiable", async () => {
    await initiateMigration(relay, "att-agent");

    const res = await relay.app.request(`/api/v1/agents/att-agent/migration/attestation`, {
      headers: AUTH_HEADER,
    });
    const body = (await res.json()) as { departure_attestation: DepartureAttestation };

    const wkRes = await relay.app.request("/.well-known/motebit.json");
    const metadata = (await wkRes.json()) as { public_key: string };

    const { signature, ...payload } = body.departure_attestation;
    const canonical = canonicalJson(payload);
    const valid = await verify(
      hexToBytes(signature),
      new TextEncoder().encode(canonical),
      hexToBytes(metadata.public_key),
    );
    expect(valid).toBe(true);
  });

  it("rejects without active migration token", async () => {
    const res = await relay.app.request(`/api/v1/agents/att-agent/migration/attestation`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(404);
  });
});

describe("Migration: GET export", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const kp = await generateKeypair();
    await registerAgent(relay, "export-agent", bytesToHex(kp.publicKey));
  });

  afterEach(async () => {
    await relay.close();
  });

  it("returns credential bundle", async () => {
    await initiateMigration(relay, "export-agent");

    const res = await relay.app.request(`/api/v1/agents/export-agent/migration/export`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      credential_bundle: {
        motebit_id: string;
        credentials: unknown[];
        anchor_proofs: unknown[];
        key_succession: unknown[];
      };
    };
    expect(body.ok).toBe(true);
    expect(body.credential_bundle.motebit_id).toBe("export-agent");
    expect(Array.isArray(body.credential_bundle.credentials)).toBe(true);
    expect(Array.isArray(body.credential_bundle.anchor_proofs)).toBe(true);
    expect(Array.isArray(body.credential_bundle.key_succession)).toBe(true);
  });

  it("rejects without active migration token", async () => {
    const res = await relay.app.request(`/api/v1/agents/export-agent/migration/export`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(404);
  });
});

describe("Migration: cancel + depart", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const kp = await generateKeypair();
    await registerAgent(relay, "lifecycle-agent", bytesToHex(kp.publicKey));
  });

  afterEach(async () => {
    await relay.close();
  });

  it("cancels an active migration", async () => {
    await initiateMigration(relay, "lifecycle-agent");

    const res = await relay.app.request(`/api/v1/agents/lifecycle-agent/migrate/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    });
    expect(res.status).toBe(200);

    // After cancellation, attestation should fail (no active token)
    const attRes = await relay.app.request(`/api/v1/agents/lifecycle-agent/migration/attestation`, {
      headers: AUTH_HEADER,
    });
    expect(attRes.status).toBe(404);
  });

  it("departs successfully with zero balance", async () => {
    await initiateMigration(relay, "lifecycle-agent");

    const res = await relay.app.request(`/api/v1/agents/lifecycle-agent/migrate/depart`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; state: string };
    expect(body.state).toBe("departed");

    // After departure, agent should not be discoverable
    const discoverRes = await relay.app.request(`/api/v1/discover/lifecycle-agent`);
    const discoverBody = (await discoverRes.json()) as { found: boolean };
    expect(discoverBody.found).toBe(false);
  });
});

// ── Migration §7.2 — BalanceWaiver ─────────────────────────────────────
// Foundation law (§7.3): "Migration advances to `departed` only after
// withdrawal is confirmed OR the agent signs a BalanceWaiver." These
// tests cover the second branch: an agent with positive balance presents
// a signed waiver and the relay verifies it before flipping state.

describe("Migration: depart with BalanceWaiver (§7.2 + §7.3)", () => {
  let relay: SyncRelay;
  let agentPrivateKey: Uint8Array;
  let agentPublicKeyHex: string;
  const motebitId = "waiver-agent";

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const kp = await generateKeypair();
    agentPrivateKey = kp.privateKey;
    agentPublicKeyHex = bytesToHex(kp.publicKey);
    await registerAgent(relay, motebitId, agentPublicKeyHex);
  });

  afterEach(async () => {
    await relay.close();
  });

  async function fundAndSign(balance: number, overrides?: Partial<BalanceWaiver>) {
    creditAccount(relay.moteDb.db, motebitId, balance, "deposit", null, "test");
    await initiateMigration(relay, motebitId);
    const body = {
      motebit_id: overrides?.motebit_id ?? motebitId,
      waived_amount: overrides?.waived_amount ?? balance,
      waived_at: overrides?.waived_at ?? Date.now(),
    };
    return signBalanceWaiver(body, agentPrivateKey);
  }

  async function depart(waiver?: BalanceWaiver): Promise<Response> {
    return relay.app.request(`/api/v1/agents/${motebitId}/migrate/depart`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: waiver ? JSON.stringify({ balance_waiver: waiver }) : JSON.stringify({}),
    });
  }

  it("positive balance with no waiver — 409 naming both paths", async () => {
    creditAccount(relay.moteDb.db, motebitId, 1_000_000, "deposit", null, "test");
    await initiateMigration(relay, motebitId);
    const res = await depart();
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/withdrawn or waived/i);
  });

  it("valid waiver — succeeds, balance debited to zero, waiver persisted", async () => {
    const waiver = await fundAndSign(1_234_567);
    const res = await depart(waiver);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; state: string };
    expect(body.state).toBe("departed");

    // Balance debited under the waiver transaction type.
    const row = relay.moteDb.db
      .prepare("SELECT balance FROM relay_accounts WHERE motebit_id = ?")
      .get(motebitId) as { balance: number } | undefined;
    expect(row?.balance).toBe(0);

    // Waiver persisted verbatim on the migration row — auditors re-verify.
    const mig = relay.moteDb.db
      .prepare("SELECT balance_waiver_json FROM relay_migrations WHERE motebit_id = ?")
      .get(motebitId) as { balance_waiver_json: string | null } | undefined;
    expect(mig?.balance_waiver_json).toBeTruthy();
    const persisted = JSON.parse(mig!.balance_waiver_json!) as BalanceWaiver;
    expect(persisted.signature).toBe(waiver.signature);
  });

  it("tampered signature — 400", async () => {
    const waiver = await fundAndSign(1_000_000);
    const tampered: BalanceWaiver = { ...waiver, waived_amount: 999_999_999 };
    const res = await depart(tampered);
    expect(res.status).toBe(400);
  });

  it("motebit_id mismatch — 400", async () => {
    // Sign a waiver claiming a different motebit_id than the path
    const waiver = await fundAndSign(1_000_000, { motebit_id: "impostor" });
    const res = await depart(waiver);
    expect(res.status).toBe(400);
  });

  it("waived_amount < current balance — 409 with re-sign guidance", async () => {
    const waiver = await fundAndSign(1_000_000, { waived_amount: 500_000 });
    const res = await depart(waiver);
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/re-sign/i);
  });

  it("waiver signed by wrong key — 400", async () => {
    creditAccount(relay.moteDb.db, motebitId, 1_000_000, "deposit", null, "test");
    await initiateMigration(relay, motebitId);
    const impostorKp = await generateKeypair();
    const waiver = await signBalanceWaiver(
      { motebit_id: motebitId, waived_amount: 1_000_000, waived_at: Date.now() },
      impostorKp.privateKey,
    );
    const res = await depart(waiver);
    expect(res.status).toBe(400);
  });

  it("waived_amount ≥ balance — succeeds and debits only the current balance", async () => {
    // Agent over-commits: balance 500k, waives 2M. Relay accepts, debits 500k.
    const waiver = await fundAndSign(500_000, { waived_amount: 2_000_000 });
    const res = await depart(waiver);
    expect(res.status).toBe(200);
    const row = relay.moteDb.db
      .prepare("SELECT balance FROM relay_accounts WHERE motebit_id = ?")
      .get(motebitId) as { balance: number } | undefined;
    expect(row?.balance).toBe(0);
  });
});

describe("Migration: accept-migration (destination)", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(async () => {
    await relay.close();
  });

  it("accepts a valid migration presentation", async () => {
    const kp = await generateKeypair();
    const pubHex = bytesToHex(kp.publicKey);

    // Construct a minimal migration presentation
    // (source relay is unreachable in test, so signature verification is skipped)
    const now = Date.now();
    const token: MigrationToken = {
      token_id: `mig-test-${now}`,
      motebit_id: "incoming-agent",
      source_relay_id: "source-relay-id",
      source_relay_url: "http://unreachable:9999",
      issued_at: now,
      expires_at: now + 72 * 60 * 60 * 1000,
      suite: "motebit-jcs-ed25519-b64-v1",
      signature: "deadbeef",
    };

    const attestation: DepartureAttestation = {
      attestation_id: "att-test",
      motebit_id: "incoming-agent",
      source_relay_id: "source-relay-id",
      source_relay_url: "http://unreachable:9999",
      first_seen: now - 86400000,
      last_active: now,
      trust_level: "verified",
      successful_tasks: 10,
      failed_tasks: 1,
      credentials_issued: 5,
      balance_at_departure: 0,
      attested_at: now,
      suite: "motebit-jcs-ed25519-b64-v1",
      signature: "deadbeef",
    };

    const res = await relay.app.request(`/api/v1/agents/accept-migration`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        migration_token: token,
        departure_attestation: attestation,
        credential_bundle: {
          motebit_id: "incoming-agent",
          exported_at: now,
          credentials: [],
          anchor_proofs: [],
          key_succession: [],
          bundle_hash: "",
          signature: "",
        },
        motebit_id: "incoming-agent",
        public_key: pubHex,
      }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; motebit_id: string };
    expect(body.ok).toBe(true);
    expect(body.motebit_id).toBe("incoming-agent");

    // Agent should now be discoverable on this relay
    const discoverRes = await relay.app.request(`/api/v1/discover/incoming-agent`);
    const discoverBody = (await discoverRes.json()) as { found: boolean };
    expect(discoverBody.found).toBe(true);
  });

  it("rejects expired migration token", async () => {
    const now = Date.now();
    const res = await relay.app.request(`/api/v1/agents/accept-migration`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        migration_token: {
          token_id: "expired-token",
          motebit_id: "expired-agent",
          source_relay_id: "src",
          source_relay_url: "http://unreachable:9999",
          issued_at: now - 100000,
          expires_at: now - 1000,
          signature: "deadbeef",
        },
        departure_attestation: {
          attestation_id: "att-expired",
          motebit_id: "expired-agent",
          source_relay_id: "src",
          source_relay_url: "http://unreachable:9999",
          first_seen: now,
          last_active: now,
          trust_level: "unknown",
          successful_tasks: 0,
          failed_tasks: 0,
          credentials_issued: 0,
          balance_at_departure: 0,
          attested_at: now,
          signature: "deadbeef",
        },
        credential_bundle: {
          motebit_id: "expired-agent",
          exported_at: now,
          credentials: [],
          anchor_proofs: [],
          key_succession: [],
          bundle_hash: "",
          signature: "",
        },
        motebit_id: "expired-agent",
        public_key: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate migration token (replay prevention §10)", async () => {
    const kp = await generateKeypair();
    const pubHex = bytesToHex(kp.publicKey);
    const now = Date.now();

    const payload = {
      migration_token: {
        token_id: "replay-token",
        motebit_id: "replay-agent",
        source_relay_id: "src",
        source_relay_url: "http://unreachable:9999",
        issued_at: now,
        expires_at: now + 72 * 60 * 60 * 1000,
        signature: "deadbeef",
      },
      departure_attestation: {
        attestation_id: "att-replay",
        motebit_id: "replay-agent",
        source_relay_id: "src",
        source_relay_url: "http://unreachable:9999",
        first_seen: now,
        last_active: now,
        trust_level: "unknown",
        successful_tasks: 0,
        failed_tasks: 0,
        credentials_issued: 0,
        balance_at_departure: 0,
        attested_at: now,
        signature: "deadbeef",
      },
      credential_bundle: {
        motebit_id: "replay-agent",
        exported_at: now,
        credentials: [],
        anchor_proofs: [],
        key_succession: [],
        bundle_hash: "",
        signature: "",
      },
      motebit_id: "replay-agent",
      public_key: pubHex,
    };

    // First submission — success
    const res1 = await relay.app.request(`/api/v1/agents/accept-migration`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(payload),
    });
    expect(res1.status).toBe(200);

    // Replay — should be rejected
    const res2 = await relay.app.request(`/api/v1/agents/accept-migration`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(payload),
    });
    expect(res2.status).toBe(409);
  });
});
