import { describe, it, expect } from "vitest";
import { parse } from "../parse.js";

// Minimal valid motebit.md content for testing the parser
const MINIMAL_IDENTITY = `---
spec: motebit/identity@1.0
motebit_id: 019abc12-3456-7890-abcd-ef0123456789
created_at: 2026-01-15T10:00:00Z
owner_id: owner-abc-123
identity:
  algorithm: Ed25519
  public_key: aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233
governance:
  trust_mode: guarded
  max_risk_auto: R1_DRAFT
  require_approval_above: R2_WRITE
  deny_above: R4_MONEY
  operator_mode: true
privacy:
  default_sensitivity: personal
  retention_days:
    none: 365
    personal: 180
    medical: 90
  fail_closed: true
memory:
  half_life_days: 7
  confidence_threshold: 0.3
  per_turn_limit: 3
devices:
  - device_id: dev-001
    name: laptop
    public_key: 1122334455
    registered_at: 2026-01-15T10:00:00Z
---

# My Agent

<!-- motebit:sig:motebit-jcs-ed25519-hex-v1:dGVzdHNpZ25hdHVyZQ -->
`;

describe("parse", () => {
  it("extracts frontmatter fields", () => {
    const result = parse(MINIMAL_IDENTITY);
    const fm = result.frontmatter;
    expect(fm.spec).toBe("motebit/identity@1.0");
    expect(fm.motebit_id).toBe("019abc12-3456-7890-abcd-ef0123456789");
    expect(fm.created_at).toBe("2026-01-15T10:00:00Z");
    expect(fm.owner_id).toBe("owner-abc-123");
  });

  it("extracts identity section", () => {
    const fm = parse(MINIMAL_IDENTITY).frontmatter;
    expect(fm.identity.algorithm).toBe("Ed25519");
    expect(fm.identity.public_key).toBe(
      "aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233",
    );
  });

  it("extracts governance section", () => {
    const fm = parse(MINIMAL_IDENTITY).frontmatter;
    expect(fm.governance.trust_mode).toBe("guarded");
    expect(fm.governance.max_risk_auto).toBe("R1_DRAFT");
    expect(fm.governance.require_approval_above).toBe("R2_WRITE");
    expect(fm.governance.deny_above).toBe("R4_MONEY");
    expect(fm.governance.operator_mode).toBe(true);
  });

  it("extracts privacy section with retention days", () => {
    const fm = parse(MINIMAL_IDENTITY).frontmatter;
    expect(fm.privacy.default_sensitivity).toBe("personal");
    expect(fm.privacy.fail_closed).toBe(true);
    expect(fm.privacy.retention_days).toEqual({
      none: 365,
      personal: 180,
      medical: 90,
    });
  });

  it("extracts memory section with numeric values", () => {
    const fm = parse(MINIMAL_IDENTITY).frontmatter;
    expect(fm.memory.half_life_days).toBe(7);
    expect(fm.memory.confidence_threshold).toBe(0.3);
    expect(fm.memory.per_turn_limit).toBe(3);
  });

  it("extracts device list", () => {
    const fm = parse(MINIMAL_IDENTITY).frontmatter;
    expect(fm.devices).toHaveLength(1);
    expect(fm.devices[0]).toEqual({
      device_id: "dev-001",
      name: "laptop",
      public_key: 1122334455,
      registered_at: "2026-01-15T10:00:00Z",
    });
  });

  it("extracts signature from comment", () => {
    const result = parse(MINIMAL_IDENTITY);
    expect(result.signature).toBe("dGVzdHNpZ25hdHVyZQ");
  });

  it("returns rawFrontmatter without delimiters", () => {
    const result = parse(MINIMAL_IDENTITY);
    expect(result.rawFrontmatter).toContain("spec: motebit/identity@1.0");
    expect(result.rawFrontmatter).not.toContain("---");
  });

  it("normalizes CRLF to LF", () => {
    const crlf = MINIMAL_IDENTITY.replace(/\n/g, "\r\n");
    const result = parse(crlf);
    expect(result.frontmatter.spec).toBe("motebit/identity@1.0");
  });

  it("throws on missing frontmatter opening", () => {
    expect(() => parse("no frontmatter here")).toThrow("Missing frontmatter opening ---");
  });

  it("throws on missing frontmatter closing", () => {
    expect(() => parse("---\nspec: test\n")).toThrow("Missing frontmatter closing ---");
  });

  it("throws on missing signature", () => {
    expect(() => parse("---\nspec: test\n---\nno signature here")).toThrow(
      "Missing signature comment",
    );
  });
});

describe("parse — service identity", () => {
  const SERVICE_IDENTITY = `---
spec: motebit/identity@1.0
motebit_id: 019abc12-0000-0000-0000-000000000001
created_at: 2026-01-15T10:00:00Z
owner_id: owner-001
type: service
service_name: Web Search
service_description: Search the web
capabilities:
  - web_search
  - read_url
identity:
  algorithm: Ed25519
  public_key: aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233
governance:
  trust_mode: full
  max_risk_auto: R3_EXECUTE
  require_approval_above: R3_EXECUTE
  deny_above: R4_MONEY
  operator_mode: false
privacy:
  default_sensitivity: none
  retention_days:
    none: 365
  fail_closed: true
memory:
  half_life_days: 7
  confidence_threshold: 0.3
  per_turn_limit: 3
devices:
  - device_id: svc-001
    name: fly-instance
    public_key: aabb
    registered_at: 2026-01-15T10:00:00Z
---

<!-- motebit:sig:motebit-jcs-ed25519-hex-v1:c2VydmljZXNpZw -->
`;

  it("extracts service type and metadata", () => {
    const fm = parse(SERVICE_IDENTITY).frontmatter;
    expect(fm.type).toBe("service");
    expect(fm.service_name).toBe("Web Search");
    expect(fm.service_description).toBe("Search the web");
  });

  it("extracts capabilities array", () => {
    const fm = parse(SERVICE_IDENTITY).frontmatter;
    expect(fm.capabilities).toEqual(["web_search", "read_url"]);
  });
});
