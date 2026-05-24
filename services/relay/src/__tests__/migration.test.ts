/**
 * Migration endpoint tests — motebit/migration@1.0.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { generateKeypair, bytesToHex, hexToBytes } from "@motebit/encryption";
import {
  signBalanceWaiver,
  verifyMigrationToken,
  verifyDepartureAttestation,
  ed25519Sign,
  toBase64Url,
  canonicalJson,
} from "@motebit/crypto";
import type { MigrationToken, DepartureAttestation, BalanceWaiver } from "@motebit/protocol";
import { performMigration } from "@motebit/runtime";
import { creditAccount } from "../accounts.js";
import { AUTH_HEADER, API_TOKEN, createTestRelay } from "./test-helpers.js";

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

/**
 * Build an accept-migration payload whose source relay is a PINNED federation
 * peer (Tier 1 trust) with real base64url signatures on the token + attestation.
 * Exercises the hardened, fail-closed verification path — not the old fail-open
 * "source unreachable → skip verify" shortcut. The credential bundle stays
 * unsigned-shape (accept-migration verifies token + attestation only).
 */
async function buildPinnedAcceptPayload(
  relay: SyncRelay,
  opts: { motebitId: string; tokenId: string; sourceRelayId?: string },
): Promise<Record<string, unknown>> {
  const sourceRelayId = opts.sourceRelayId ?? "source-relay-id";
  const sourceKp = await generateKeypair();
  // Pin the source relay as a known, active federation peer.
  relay.moteDb.db
    .prepare(
      `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, nonce, missed_heartbeats, agent_count, trust_score, peer_protocol_version)
       VALUES (?, ?, ?, ?, 'active', ?, 0, 0, 0.5, ?)`,
    )
    .run(
      sourceRelayId,
      bytesToHex(sourceKp.publicKey),
      "http://source-relay",
      "Source",
      null,
      "1.0",
    );

  const now = Date.now();
  const sign = async (b: Record<string, unknown>): Promise<string> =>
    toBase64Url(await ed25519Sign(new TextEncoder().encode(canonicalJson(b)), sourceKp.privateKey));

  const tokenBody = {
    token_id: opts.tokenId,
    motebit_id: opts.motebitId,
    source_relay_id: sourceRelayId,
    source_relay_url: "http://source-relay",
    issued_at: now,
    expires_at: now + 72 * 60 * 60 * 1000,
    suite: "motebit-jcs-ed25519-b64-v1" as const,
  };
  const attBody = {
    attestation_id: `att-${opts.tokenId}`,
    motebit_id: opts.motebitId,
    source_relay_id: sourceRelayId,
    source_relay_url: "http://source-relay",
    first_seen: now - 86_400_000,
    last_active: now,
    trust_level: "verified",
    successful_tasks: 10,
    failed_tasks: 1,
    credentials_issued: 5,
    balance_at_departure: 0,
    attested_at: now,
    suite: "motebit-jcs-ed25519-b64-v1" as const,
  };
  const agentKp = await generateKeypair();
  return {
    migration_token: { ...tokenBody, signature: await sign(tokenBody) },
    departure_attestation: { ...attBody, signature: await sign(attBody) },
    credential_bundle: {
      motebit_id: opts.motebitId,
      exported_at: now,
      credentials: [],
      anchor_proofs: [],
      key_succession: [],
      bundle_hash: "deadbeef",
      suite: "motebit-jcs-ed25519-b64-v1",
      signature: "deadbeef",
    },
    motebit_id: opts.motebitId,
    public_key: bytesToHex(agentKp.publicKey),
  };
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
    // base64url signature per the declared suite + published schema.
    expect(migration_token.signature).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("token signature is verifiable with relay public key", async () => {
    const { migration_token } = await initiateMigration(relay, "migrate-agent");

    // Get relay public key from well-known
    const wkRes = await relay.app.request("/.well-known/motebit.json");
    const metadata = (await wkRes.json()) as { public_key: string };

    // Verify via the portable verifier (the third-party path).
    const valid = await verifyMigrationToken(migration_token, hexToBytes(metadata.public_key));
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
    expect(att.signature).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("attestation signature is verifiable", async () => {
    await initiateMigration(relay, "att-agent");

    const res = await relay.app.request(`/api/v1/agents/att-agent/migration/attestation`, {
      headers: AUTH_HEADER,
    });
    const body = (await res.json()) as { departure_attestation: DepartureAttestation };

    const wkRes = await relay.app.request("/.well-known/motebit.json");
    const metadata = (await wkRes.json()) as { public_key: string };

    const valid = await verifyDepartureAttestation(
      body.departure_attestation,
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

  it("accepts a valid migration presentation (pinned source relay, real signatures)", async () => {
    const payload = await buildPinnedAcceptPayload(relay, {
      motebitId: "incoming-agent",
      tokenId: `mig-test-${Date.now()}`,
    });

    const res = await relay.app.request(`/api/v1/agents/accept-migration`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(payload),
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

  it("rejects a migration whose source relay identity cannot be established (fail-closed)", async () => {
    // No pinned peer + unreachable well-known → key cannot be established → reject.
    const now = Date.now();
    const res = await relay.app.request(`/api/v1/agents/accept-migration`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        migration_token: {
          token_id: `unverifiable-${now}`,
          motebit_id: "ghost-agent",
          source_relay_id: "unknown-relay",
          source_relay_url: "http://unreachable:9999",
          issued_at: now,
          expires_at: now + 72 * 60 * 60 * 1000,
          suite: "motebit-jcs-ed25519-b64-v1",
          signature: "deadbeef",
        },
        departure_attestation: {
          attestation_id: "att-ghost",
          motebit_id: "ghost-agent",
          source_relay_id: "unknown-relay",
          source_relay_url: "http://unreachable:9999",
          first_seen: now,
          last_active: now,
          trust_level: "unknown",
          successful_tasks: 0,
          failed_tasks: 0,
          credentials_issued: 0,
          balance_at_departure: 0,
          attested_at: now,
          suite: "motebit-jcs-ed25519-b64-v1",
          signature: "deadbeef",
        },
        credential_bundle: {
          motebit_id: "ghost-agent",
          exported_at: now,
          credentials: [],
          anchor_proofs: [],
          key_succession: [],
          bundle_hash: "deadbeef",
          suite: "motebit-jcs-ed25519-b64-v1",
          signature: "deadbeef",
        },
        motebit_id: "ghost-agent",
        public_key: "00".repeat(32),
      }),
    });
    expect(res.status).toBe(400);
    // And the agent must NOT have been onboarded.
    const discover = await relay.app.request(`/api/v1/discover/ghost-agent`);
    expect(((await discover.json()) as { found: boolean }).found).toBe(false);
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
    const payload = await buildPinnedAcceptPayload(relay, {
      motebitId: "replay-agent",
      tokenId: "replay-token",
    });

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

describe("Migration: end-to-end (performMigration across two relays)", () => {
  let source: SyncRelay;
  let dest: SyncRelay;
  const SOURCE = "http://source.test";
  const DEST = "http://dest.test";

  beforeEach(async () => {
    // The source advertises an endpoint URL so its issued tokens carry a valid
    // source_relay_url (a real relay always has one).
    source = await createTestRelay({
      enableDeviceAuth: false,
      federation: { endpointUrl: SOURCE },
    });
    dest = await createTestRelay({ enableDeviceAuth: false });
  });
  afterEach(async () => {
    await source.close();
    await dest.close();
  });

  // Route the orchestrator's fetch into the two in-process relay apps by host.
  function twoRelayFetch(): typeof globalThis.fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(SOURCE)) return source.app.request(url.slice(SOURCE.length) || "/", init);
      if (url.startsWith(DEST)) return dest.app.request(url.slice(DEST.length) || "/", init);
      return new Response("no route", { status: 404 });
    }) as typeof globalThis.fetch;
  }

  it("an agent leaves the source relay and is onboarded + discoverable on the destination", async () => {
    // The agent exists on the source relay.
    const agentKp = await generateKeypair();
    const agentPubHex = bytesToHex(agentKp.publicKey);
    await registerAgent(source, "nomad-agent", agentPubHex);

    // The destination establishes the source relay's identity the strong way
    // (Tier 1): pin the source as a known federation peer using its real relay
    // key from /.well-known/motebit.json.
    const wk = await source.app.request("/.well-known/motebit.json");
    const meta = (await wk.json()) as { relay_id: string; public_key: string };
    dest.moteDb.db
      .prepare(
        `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, nonce, missed_heartbeats, agent_count, trust_score, peer_protocol_version)
         VALUES (?, ?, ?, ?, 'active', ?, 0, 0, 0.5, ?)`,
      )
      .run(meta.relay_id, meta.public_key, SOURCE, "Source", null, "1.0");

    // The agent performs the full migration.
    const result = await performMigration({
      sourceRelayUrl: SOURCE,
      destRelayUrl: DEST,
      motebitId: "nomad-agent",
      publicKeyHex: agentPubHex,
      signingPrivateKey: agentKp.privateKey,
      sourceAuth: API_TOKEN,
      reason: "moving to a relay I trust more",
      fetch: twoRelayFetch(),
    });

    // The sovereign migration succeeded — the destination verified the source's
    // relay-signed token against the pinned key and onboarded the agent,
    // trusting neither the agent's self-report nor a fetched key.
    expect(result).toEqual({ ok: true, acceptedMotebitId: "nomad-agent" });

    const discover = await dest.app.request("/api/v1/discover/nomad-agent");
    expect(((await discover.json()) as { found: boolean }).found).toBe(true);
  });

  it("the destination rejects the migration when it cannot establish the source's identity", async () => {
    // Same flow, but the source is NOT pinned on the destination and its
    // well-known is unreachable in-process → the destination cannot establish
    // the source key → fail-closed (no onboarding).
    const agentKp = await generateKeypair();
    const agentPubHex = bytesToHex(agentKp.publicKey);
    await registerAgent(source, "nomad-agent", agentPubHex);

    const result = await performMigration({
      sourceRelayUrl: SOURCE,
      destRelayUrl: DEST,
      motebitId: "nomad-agent",
      publicKeyHex: agentPubHex,
      signingPrivateKey: agentKp.privateKey,
      sourceAuth: API_TOKEN,
      fetch: twoRelayFetch(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.step).toBe("accept");
    const discover = await dest.app.request("/api/v1/discover/nomad-agent");
    expect(((await discover.json()) as { found: boolean }).found).toBe(false);
  });
});
