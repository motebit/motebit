/**
 * `verifyArtifact` / `formatHuman` on an identity file: intact only when
 * the signature AND the succession chain verify (`identityVerifyOutcome` from
 * `@motebit/crypto`). A signature-valid file whose chain is forged is
 * `valid: false` — the same verdict `motebit verify` gives.
 */
import { describe, it, expect } from "vitest";
import { verifyArtifact, formatHuman } from "../lib.js";

// Signature-valid; its one succession link carries all-zero signatures.
const FORGED_CHAIN_MOTEBIT_MD = [
  "---",
  'spec: "motebit/identity@1.0"',
  'motebit_id: "019e2aa5-7649-7fa3-ab27-2e4d9d4f0ffb"',
  'created_at: "2026-01-15T00:00:00.000Z"',
  'owner_id: "owner"',
  "identity:",
  '  algorithm: "Ed25519"',
  '  public_key: "fe6f3a57e46193242ed0c260cc8d8728a7f29dcb82b3f90e07cdeaea298f99a0"',
  "governance:",
  '  trust_mode: "guarded"',
  '  max_risk_auto: "R1_DRAFT"',
  '  require_approval_above: "R1_DRAFT"',
  '  deny_above: "R4_MONEY"',
  "  operator_mode: false",
  "privacy:",
  '  default_sensitivity: "personal"',
  "  retention_days:",
  "    none: 365",
  "    personal: 90",
  "    medical: 30",
  "    financial: 30",
  "    secret: 7",
  "  fail_closed: true",
  "memory:",
  "  half_life_days: 7",
  "  confidence_threshold: 0.3",
  "  per_turn_limit: 5",
  "devices: []",
  "succession:",
  '  - old_public_key: "994ea5575436a6d23700b5e768c825a41a8fd542fe8fbefd23de103e63d4bcf5"',
  '    new_public_key: "fe6f3a57e46193242ed0c260cc8d8728a7f29dcb82b3f90e07cdeaea298f99a0"',
  "    timestamp: 1768435200000",
  '    old_key_signature: "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"',
  '    new_key_signature: "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"',
  '    suite: "motebit-jcs-ed25519-hex-v1"',
  "---",
  "<!-- motebit:sig:motebit-jcs-ed25519-hex-v1:28dc8a5c6dd17ba441835c70a11a55bf12f9743747cf4bef6b14268c5cf8b17420cd74196d317c4366bb42355d2324fea88686a20a63d166bf4b44aa3dee600e -->",
  "",
].join("\n");

describe("verifyArtifact — identity succession chain", () => {
  it("a forged succession chain is invalid, with the chain's reason", async () => {
    const result = await verifyArtifact(FORGED_CHAIN_MOTEBIT_MD);
    expect(result.type).toBe("identity");
    expect(result.valid).toBe(false);
    const out = formatHuman(result);
    expect(out).toMatch(/^INVALID \(identity\)/);
    expect(out).toMatch(/succession chain invalid/i);
  });

  it("the --expect identity path reads the chain too", async () => {
    const result = await verifyArtifact(FORGED_CHAIN_MOTEBIT_MD, { expectedType: "identity" });
    expect(result.valid).toBe(false);
  });
});
