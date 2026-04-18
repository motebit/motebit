/**
 * Runtime-parse tests for the migration cluster — Request, Token,
 * DepartureAttestation, Presentation. The four artifacts that
 * collectively let an agent move from one relay to another while
 * preserving identity + accumulated trust.
 */
import { describe, expect, it } from "vitest";

import {
  DepartureAttestationSchema,
  MigrationPresentationSchema,
  MigrationRequestSchema,
  MigrationTokenSchema,
} from "../migration.js";

const SUITE = "motebit-jcs-ed25519-b64-v1";
const SIG = "sig-base64url";
const MOTEBIT_ID = "019cd9d4-3275-7b24-8265-61ebee41d9d0";
const RELAY_ID = "019cd9d4-3275-7b24-8265-61ebee41d9d1";

// ---------------------------------------------------------------------------
// MigrationRequest
// ---------------------------------------------------------------------------

describe("MigrationRequestSchema", () => {
  const SAMPLE: Record<string, unknown> = {
    motebit_id: MOTEBIT_ID,
    requested_at: 1_713_456_000_000,
    suite: SUITE,
    signature: SIG,
  };

  it("parses a minimal request (no optional destination/reason)", () => {
    const r = MigrationRequestSchema.parse(SAMPLE);
    expect(r.motebit_id).toBe(MOTEBIT_ID);
    expect(r.destination_relay).toBeUndefined();
    expect(r.reason).toBeUndefined();
  });

  it("parses a fully-populated request with destination + reason", () => {
    const r = MigrationRequestSchema.parse({
      ...SAMPLE,
      destination_relay: "https://other-relay.example.com",
      reason: "moving to a relay with better latency for my region",
    });
    expect(r.destination_relay).toBe("https://other-relay.example.com");
  });

  it("rejects unknown cryptosuite", () => {
    expect(() => MigrationRequestSchema.parse({ ...SAMPLE, suite: "future-pqc" })).toThrow();
  });

  it("rejects extra top-level keys (strict mode)", () => {
    expect(() => MigrationRequestSchema.parse({ ...SAMPLE, sneak: "no" })).toThrow();
  });

  it("rejects missing signature (agent-signed is the contract)", () => {
    const bad = { ...SAMPLE };
    delete bad.signature;
    expect(() => MigrationRequestSchema.parse(bad)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// MigrationToken
// ---------------------------------------------------------------------------

describe("MigrationTokenSchema", () => {
  const SAMPLE: Record<string, unknown> = {
    token_id: "01HTV8X9QZ-token-1",
    motebit_id: MOTEBIT_ID,
    source_relay_id: RELAY_ID,
    source_relay_url: "https://source-relay.example.com",
    issued_at: 1_713_456_000_000,
    expires_at: 1_713_456_000_000 + 72 * 3_600_000,
    suite: SUITE,
    signature: SIG,
  };

  it("parses a valid token", () => {
    const t = MigrationTokenSchema.parse(SAMPLE);
    expect(t.token_id).toBe("01HTV8X9QZ-token-1");
    expect(t.source_relay_url).toMatch(/^https:/);
  });

  it("rejects a non-URL source_relay_url", () => {
    expect(() =>
      MigrationTokenSchema.parse({ ...SAMPLE, source_relay_url: "not-a-url" }),
    ).toThrow();
  });

  it("rejects extra top-level keys", () => {
    expect(() => MigrationTokenSchema.parse({ ...SAMPLE, sneak: "no" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// DepartureAttestation
// ---------------------------------------------------------------------------

describe("DepartureAttestationSchema", () => {
  const SAMPLE: Record<string, unknown> = {
    attestation_id: "01HTV8X9QZ-attest-1",
    motebit_id: MOTEBIT_ID,
    source_relay_id: RELAY_ID,
    source_relay_url: "https://source-relay.example.com",
    first_seen: 1_700_000_000_000,
    last_active: 1_713_400_000_000,
    trust_level: "verified",
    successful_tasks: 142,
    failed_tasks: 3,
    credentials_issued: 12,
    balance_at_departure: 5_000_000, // $5 in micro-units
    attested_at: 1_713_456_000_000,
    suite: SUITE,
    signature: SIG,
  };

  it("parses a valid attestation", () => {
    const a = DepartureAttestationSchema.parse(SAMPLE);
    expect(a.successful_tasks).toBe(142);
    expect(a.balance_at_departure).toBe(5_000_000);
  });

  it("rejects negative task counts (counts are non-negative)", () => {
    expect(() => DepartureAttestationSchema.parse({ ...SAMPLE, successful_tasks: -1 })).toThrow();
    expect(() => DepartureAttestationSchema.parse({ ...SAMPLE, failed_tasks: -1 })).toThrow();
    expect(() => DepartureAttestationSchema.parse({ ...SAMPLE, credentials_issued: -1 })).toThrow();
  });

  it("accepts negative balance (overdraft / refund-pending state)", () => {
    const a = DepartureAttestationSchema.parse({ ...SAMPLE, balance_at_departure: -100 });
    expect(a.balance_at_departure).toBe(-100);
  });

  it("rejects empty trust_level", () => {
    expect(() => DepartureAttestationSchema.parse({ ...SAMPLE, trust_level: "" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// MigrationPresentation — the envelope nesting all three of the above
// ---------------------------------------------------------------------------

describe("MigrationPresentationSchema", () => {
  const TOKEN = {
    token_id: "01HTV8X9QZ-token-1",
    motebit_id: MOTEBIT_ID,
    source_relay_id: RELAY_ID,
    source_relay_url: "https://source-relay.example.com",
    issued_at: 1_713_456_000_000,
    expires_at: 1_713_456_000_000 + 72 * 3_600_000,
    suite: SUITE,
    signature: SIG,
  };
  const ATTESTATION = {
    attestation_id: "01HTV8X9QZ-attest-1",
    motebit_id: MOTEBIT_ID,
    source_relay_id: RELAY_ID,
    source_relay_url: "https://source-relay.example.com",
    first_seen: 1_700_000_000_000,
    last_active: 1_713_400_000_000,
    trust_level: "verified",
    successful_tasks: 142,
    failed_tasks: 3,
    credentials_issued: 12,
    balance_at_departure: 5_000_000,
    attested_at: 1_713_456_000_000,
    suite: SUITE,
    signature: SIG,
  };
  const BUNDLE = {
    motebit_id: MOTEBIT_ID,
    exported_at: 1_713_456_000_000,
    credentials: [],
    anchor_proofs: [],
    key_succession: [],
    bundle_hash: "c".repeat(64),
    suite: SUITE,
    signature: SIG,
  };

  const SAMPLE: Record<string, unknown> = {
    migration_token: TOKEN,
    departure_attestation: ATTESTATION,
    credential_bundle: BUNDLE,
    identity_file: "# motebit.md\n\n...",
    presented_at: 1_713_456_001_000,
    suite: SUITE,
    signature: SIG,
  };

  it("parses a valid presentation with all four nested artifacts", () => {
    const p = MigrationPresentationSchema.parse(SAMPLE);
    expect(p.migration_token.token_id).toBe("01HTV8X9QZ-token-1");
    expect(p.departure_attestation.trust_level).toBe("verified");
    expect(p.credential_bundle.motebit_id).toBe(MOTEBIT_ID);
  });

  it("rejects when nested migration_token is malformed", () => {
    const bad = { ...SAMPLE, migration_token: { ...TOKEN, source_relay_url: "not-a-url" } };
    expect(() => MigrationPresentationSchema.parse(bad)).toThrow();
  });

  it("rejects when nested departure_attestation is malformed", () => {
    const bad = { ...SAMPLE, departure_attestation: { ...ATTESTATION, trust_level: "" } };
    expect(() => MigrationPresentationSchema.parse(bad)).toThrow();
  });

  it("rejects when nested credential_bundle is malformed", () => {
    const bad = { ...SAMPLE, credential_bundle: { ...BUNDLE, suite: "future-pqc" } };
    expect(() => MigrationPresentationSchema.parse(bad)).toThrow();
  });

  it("rejects extra top-level keys", () => {
    expect(() => MigrationPresentationSchema.parse({ ...SAMPLE, sneak: "no" })).toThrow();
  });

  it("accepts an empty identity_file string (presentation valid even if motebit.md absent)", () => {
    const p = MigrationPresentationSchema.parse({ ...SAMPLE, identity_file: "" });
    expect(p.identity_file).toBe("");
  });
});
