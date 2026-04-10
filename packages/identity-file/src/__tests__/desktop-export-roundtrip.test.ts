/**
 * Round-trip sanity check for the desktop identity export flow.
 *
 * Tests the exact governance/memory field mappings that DesktopApp.exportIdentityFile()
 * produces, ensuring they survive: generate → verify → parse → governanceToPolicyConfig
 * without throwing or losing data. This locks the schema contract between the desktop
 * app and the identity-file/verify packages.
 */
import { describe, it, expect } from "vitest";
import { generateKeypair } from "@motebit/encryption";
import { RiskLevel } from "@motebit/sdk";
import { generate, parse, governanceToPolicyConfig, toHex } from "../index.js";
import { verifyIdentityFile as verify } from "@motebit/crypto";

// ---------------------------------------------------------------------------
// Desktop preset mappings — mirrored from apps/desktop/src/index.ts
// ---------------------------------------------------------------------------

const RISK_NAMES = ["R0_READ", "R1_DRAFT", "R2_WRITE", "R3_EXECUTE", "R4_MONEY"];

const PRESET_GOV: Record<string, { require: number; deny: number }> = {
  cautious: { require: 0, deny: 3 },
  balanced: { require: 1, deny: 3 },
  autonomous: { require: 3, deny: 4 },
};

function buildDesktopGovernance(preset: string) {
  const gov = PRESET_GOV[preset]!;
  return {
    trust_mode: (preset === "autonomous" ? "full" : "guarded") as "full" | "guarded" | "minimal",
    max_risk_auto: RISK_NAMES[gov.require]!,
    require_approval_above: RISK_NAMES[gov.require]!,
    deny_above: RISK_NAMES[gov.deny]!,
    operator_mode: false,
  };
}

function buildDesktopMemory(persistenceThreshold = 0.3) {
  return {
    confidence_threshold: persistenceThreshold,
    half_life_days: 7,
    per_turn_limit: 5,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeKeypairHex() {
  const kp = await generateKeypair();
  return { publicKeyHex: toHex(kp.publicKey), privateKey: kp.privateKey };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("desktop export round-trip", () => {
  const presets = ["cautious", "balanced", "autonomous"] as const;

  for (const preset of presets) {
    it(`${preset}: generate → verify → parse → governanceToPolicyConfig`, async () => {
      const kp = await makeKeypairHex();
      const governance = buildDesktopGovernance(preset);
      const memory = buildDesktopMemory();

      // Step 1: Generate (same call exportIdentityFile makes)
      const content = await generate(
        {
          motebitId: "test-motebit-id",
          ownerId: "test-motebit-id",
          publicKeyHex: kp.publicKeyHex,
          governance,
          memory,
          devices: [
            {
              device_id: "dev-test",
              name: "Desktop",
              public_key: kp.publicKeyHex,
              registered_at: new Date().toISOString(),
            },
          ],
        },
        kp.privateKey,
      );

      // Step 2: Verify signature
      const verifyResult = await verify(content);
      expect(verifyResult.valid).toBe(true);
      expect(verifyResult.error).toBeUndefined();

      // Step 3: Parse frontmatter
      const parsed = parse(content);

      // Governance fields survive round-trip
      expect(parsed.frontmatter.governance.trust_mode).toBe(governance.trust_mode);
      expect(parsed.frontmatter.governance.max_risk_auto).toBe(governance.max_risk_auto);
      expect(parsed.frontmatter.governance.require_approval_above).toBe(
        governance.require_approval_above,
      );
      expect(parsed.frontmatter.governance.deny_above).toBe(governance.deny_above);
      expect(parsed.frontmatter.governance.operator_mode).toBe(false);

      // Memory fields survive round-trip
      expect(parsed.frontmatter.memory.confidence_threshold).toBe(memory.confidence_threshold);
      expect(parsed.frontmatter.memory.half_life_days).toBe(7);
      expect(parsed.frontmatter.memory.per_turn_limit).toBe(5);

      // Step 4: governanceToPolicyConfig doesn't throw and returns typed enums
      const policyConfig = governanceToPolicyConfig(parsed.frontmatter.governance);
      expect(policyConfig.operatorMode).toBe(false);
      expect(typeof policyConfig.maxRiskAuto).toBe("number");
      expect(typeof policyConfig.requireApprovalAbove).toBe("number");
      expect(typeof policyConfig.denyAbove).toBe("number");

      // Values are valid RiskLevel enums (0-4)
      expect(policyConfig.maxRiskAuto).toBeGreaterThanOrEqual(RiskLevel.R0_READ);
      expect(policyConfig.maxRiskAuto).toBeLessThanOrEqual(RiskLevel.R4_MONEY);
      expect(policyConfig.denyAbove).toBeGreaterThanOrEqual(RiskLevel.R0_READ);
      expect(policyConfig.denyAbove).toBeLessThanOrEqual(RiskLevel.R4_MONEY);
    });
  }

  it("cautious preset maps to R0_READ / R3_EXECUTE", async () => {
    const kp = await makeKeypairHex();
    const content = await generate(
      {
        motebitId: "test-id",
        ownerId: "test-id",
        publicKeyHex: kp.publicKeyHex,
        governance: buildDesktopGovernance("cautious"),
        memory: buildDesktopMemory(),
      },
      kp.privateKey,
    );

    const parsed = parse(content);
    const policy = governanceToPolicyConfig(parsed.frontmatter.governance);
    expect(policy.maxRiskAuto).toBe(RiskLevel.R0_READ);
    expect(policy.requireApprovalAbove).toBe(RiskLevel.R0_READ);
    expect(policy.denyAbove).toBe(RiskLevel.R3_EXECUTE);
  });

  it("balanced preset maps to R1_DRAFT / R3_EXECUTE", async () => {
    const kp = await makeKeypairHex();
    const content = await generate(
      {
        motebitId: "test-id",
        ownerId: "test-id",
        publicKeyHex: kp.publicKeyHex,
        governance: buildDesktopGovernance("balanced"),
        memory: buildDesktopMemory(),
      },
      kp.privateKey,
    );

    const parsed = parse(content);
    const policy = governanceToPolicyConfig(parsed.frontmatter.governance);
    expect(policy.maxRiskAuto).toBe(RiskLevel.R1_DRAFT);
    expect(policy.requireApprovalAbove).toBe(RiskLevel.R1_DRAFT);
    expect(policy.denyAbove).toBe(RiskLevel.R3_EXECUTE);
  });

  it("autonomous preset maps to R3_EXECUTE / R4_MONEY", async () => {
    const kp = await makeKeypairHex();
    const content = await generate(
      {
        motebitId: "test-id",
        ownerId: "test-id",
        publicKeyHex: kp.publicKeyHex,
        governance: buildDesktopGovernance("autonomous"),
        memory: buildDesktopMemory(),
      },
      kp.privateKey,
    );

    const parsed = parse(content);
    const policy = governanceToPolicyConfig(parsed.frontmatter.governance);
    expect(policy.maxRiskAuto).toBe(RiskLevel.R3_EXECUTE);
    expect(policy.requireApprovalAbove).toBe(RiskLevel.R3_EXECUTE);
    expect(policy.denyAbove).toBe(RiskLevel.R4_MONEY);
  });

  it("custom persistence threshold survives round-trip", async () => {
    const kp = await makeKeypairHex();
    const content = await generate(
      {
        motebitId: "test-id",
        ownerId: "test-id",
        publicKeyHex: kp.publicKeyHex,
        governance: buildDesktopGovernance("balanced"),
        memory: buildDesktopMemory(0.7),
      },
      kp.privateKey,
    );

    const result = await verify(content);
    expect(result.valid).toBe(true);

    const parsed = parse(content);
    expect(parsed.frontmatter.memory.confidence_threshold).toBe(0.7);
  });
});
