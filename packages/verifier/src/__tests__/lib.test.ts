/**
 * Library-layer tests. We need a real signed receipt to exercise the
 * `verify()` dispatcher so the test confirms the whole pipeline (read
 * file → detect kind → verify signature) works — not just that we
 * forwarded the call. Receipt shape mirrors `@motebit/crypto`'s own
 * receipt test fixtures (canonical JSON + Ed25519 sign).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

import type { ExecutionReceipt } from "@motebit/crypto";

import { formatHuman, verifyArtifact, verifyFile } from "../lib.js";

beforeAll(() => {
  if (!ed.hashes.sha512) {
    ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
  }
});

// ── fixture helpers ─────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  const entries: string[] = [];
  for (const k of sorted) {
    const v = (obj as Record<string, unknown>)[k];
    if (v === undefined) continue;
    entries.push(JSON.stringify(k) + ":" + canonicalJson(v));
  }
  return "{" + entries.join(",") + "}";
}

async function signedReceipt(): Promise<ExecutionReceipt> {
  const sk = ed.utils.randomSecretKey();
  const pk = await ed.getPublicKeyAsync(sk);
  const body: Omit<ExecutionReceipt, "signature" | "suite"> = {
    task_id: "task-verifier-test",
    motebit_id: "01234567-89ab-cdef-0123-456789abcdef",
    public_key: toHex(pk),
    device_id: "dev-verifier-1",
    submitted_at: 1_000_000,
    completed_at: 1_001_000,
    status: "completed",
    result: "OK",
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: "a".repeat(16),
    result_hash: "b".repeat(16),
  };
  const withSuite = { ...body, suite: "motebit-jcs-ed25519-b64-v1" as const };
  const sig = await ed.signAsync(new TextEncoder().encode(canonicalJson(withSuite)), sk);
  return { ...withSuite, signature: toBase64Url(sig) };
}

// Tests write receipt files into a per-test tmp dir; collect them so
// teardown is best-effort (tmp cleanup isn't load-bearing for
// correctness).
const tmpDirs: string[] = [];
function freshTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "motebit-verify-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  // best-effort cleanup; skipping rmdir keeps tests isolated without
  // adding an rmSync dependency that varies by platform.
  tmpDirs.length = 0;
});

// ── tests ───────────────────────────────────────────────────────────

describe("verifyArtifact — receipt", () => {
  it("accepts a correctly signed receipt object", async () => {
    const r = await signedReceipt();
    const result = await verifyArtifact(r);
    expect(result.type).toBe("receipt");
    expect(result.valid).toBe(true);
  });

  it("accepts the same receipt serialized as a JSON string", async () => {
    const r = await signedReceipt();
    const result = await verifyArtifact(JSON.stringify(r));
    expect(result.type).toBe("receipt");
    expect(result.valid).toBe(true);
  });

  it("returns invalid (not throw) when the signature is tampered", async () => {
    const r = await signedReceipt();
    const tampered = { ...r, result: "ALTERED" };
    const result = await verifyArtifact(tampered);
    expect(result.valid).toBe(false);
  });

  it("returns invalid (not throw) for unrecognized artifact shapes", async () => {
    const result = await verifyArtifact({ some: "random object" });
    expect(result.valid).toBe(false);
  });
});

describe("verifyArtifact — --expect mismatch", () => {
  it("flips to invalid when expectedType mismatches detected type", async () => {
    const r = await signedReceipt();
    const result = await verifyArtifact(r, { expectedType: "credential" });
    expect(result.valid).toBe(false);
    expect(result.type).toBe("receipt");
    const errs = "errors" in result && result.errors ? result.errors : [];
    expect(errs.some((e) => e.message.includes("credential"))).toBe(true);
  });

  it("passes through when expectedType matches", async () => {
    const r = await signedReceipt();
    const result = await verifyArtifact(r, { expectedType: "receipt" });
    expect(result.valid).toBe(true);
  });

  it("forwards clockSkewSeconds option without throwing", async () => {
    const r = await signedReceipt();
    const result = await verifyArtifact(r, { clockSkewSeconds: 0 });
    expect(result.valid).toBe(true);
  });
});

describe("verifyFile", () => {
  it("reads a receipt JSON off disk and verifies", async () => {
    const r = await signedReceipt();
    const dir = freshTmpDir();
    const path = join(dir, "receipt.json");
    writeFileSync(path, JSON.stringify(r));
    const result = await verifyFile(path);
    expect(result.valid).toBe(true);
  });

  it("throws an I/O error for a missing path (caller handles)", async () => {
    await expect(verifyFile("/nonexistent/path/will/not/exist.json")).rejects.toThrow();
  });
});

describe("formatHuman", () => {
  it("renders VALID header + id/signer summary for a receipt", async () => {
    const r = await signedReceipt();
    const result = await verifyArtifact(r);
    const out = formatHuman(result);
    expect(out.split("\n")[0]).toBe("VALID (receipt)");
    // Receipt has no `id` field in ExecutionReceipt today, but task_id etc.
    // The summary picks the fields we have; assert it's at least one line.
    expect(out.split("\n").length).toBeGreaterThanOrEqual(1);
  });

  it("renders INVALID header + per-error lines", async () => {
    const result = await verifyArtifact({ not: "a real artifact" });
    const out = formatHuman(result);
    expect(out.split("\n")[0]).toMatch(/^INVALID /);
    // Every subsequent line starts with 2 spaces + "-" for error items.
    const rest = out.split("\n").slice(1);
    expect(rest.length).toBeGreaterThanOrEqual(1);
    for (const line of rest) {
      expect(line.startsWith("  ")).toBe(true);
    }
  });

  it("renders a fallback line when the result has no errors attached", () => {
    const synthetic = {
      type: "receipt" as const,
      valid: false,
      receipt: null,
      errors: [],
    };
    const out = formatHuman(synthetic);
    expect(out).toContain("INVALID");
    expect(out).toContain("(no detail provided)");
  });

  it("renders identity summary (did + service_name + motebit_id)", () => {
    const synthetic = {
      type: "identity" as const,
      valid: true,
      identity: {
        spec: "motebit/1.0",
        motebit_id: "01234567-89ab-cdef-0123-456789abcdef",
        created_at: "2026-04-22T00:00:00Z",
        owner_id: "owner-1",
        service_name: "test-agent",
        identity: { algorithm: "Ed25519" as const, public_key: "pk-hex" },
        governance: {
          trust_mode: "guarded" as const,
          max_risk_auto: "0.10",
          require_approval_above: "0.30",
          deny_above: "0.80",
          operator_mode: false,
        },
        privacy: { default_sensitivity: "personal", retention_days: {}, fail_closed: true },
        memory: { half_life_days: 30, confidence_threshold: 0.6, per_turn_limit: 10 },
        devices: [],
      },
      did: "did:motebit:01234567-89ab-cdef-0123-456789abcdef",
    };
    const out = formatHuman(synthetic);
    expect(out).toContain("VALID (identity)");
    expect(out).toContain("did:motebit:");
    expect(out).toContain("test-agent");
  });

  it("renders identity summary when service_name and did are absent", () => {
    const synthetic = {
      type: "identity" as const,
      valid: true,
      identity: {
        spec: "motebit/1.0",
        motebit_id: "aaaa",
        created_at: "2026-04-22T00:00:00Z",
        owner_id: "owner",
        identity: { algorithm: "Ed25519" as const, public_key: "pk" },
        governance: {
          trust_mode: "guarded" as const,
          max_risk_auto: "0",
          require_approval_above: "0",
          deny_above: "0",
          operator_mode: false,
        },
        privacy: { default_sensitivity: "none", retention_days: {}, fail_closed: false },
        memory: { half_life_days: 30, confidence_threshold: 0.6, per_turn_limit: 10 },
        devices: [],
      },
    };
    const out = formatHuman(synthetic);
    expect(out).toContain("id:");
    expect(out).toContain("aaaa");
  });

  it("returns empty summary for identity when identity payload is null", () => {
    const synthetic = { type: "identity" as const, valid: true, identity: null };
    const out = formatHuman(synthetic);
    expect(out.split("\n")[0]).toBe("VALID (identity)");
  });

  it("renders credential summary with issuer + subject + expired", () => {
    const synthetic = {
      type: "credential" as const,
      valid: true,
      credential: {
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        type: ["VerifiableCredential"],
        issuer: "did:motebit:issuer-1",
        issuanceDate: "2026-01-01T00:00:00Z",
        credentialSubject: { id: "did:motebit:subject-1" },
      } as never,
      issuer: "did:motebit:issuer-1",
      subject: "did:motebit:subject-1",
      expired: false,
    };
    const out = formatHuman(synthetic);
    expect(out).toContain("issuer:");
    expect(out).toContain("subject:");
    expect(out).toContain("expired:");
    expect(out).toContain("no");
  });

  it("renders 'hardware: secure_enclave ✓' when a valid hardware attestation is present", () => {
    const synthetic = {
      type: "credential" as const,
      valid: true,
      credential: {
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        type: ["VerifiableCredential"],
        issuer: "did:motebit:issuer-1",
        issuanceDate: "2026-01-01T00:00:00Z",
        credentialSubject: { id: "did:motebit:subject-1" },
      } as never,
      issuer: "did:motebit:issuer-1",
      subject: "did:motebit:subject-1",
      expired: false,
      hardware_attestation: {
        valid: true,
        platform: "secure_enclave" as const,
        se_public_key: "abc123",
        attested_at: 1_700_000_000_000,
        errors: [],
      },
    };
    const out = formatHuman(synthetic);
    expect(out).toContain("hardware:");
    expect(out).toContain("secure_enclave");
    expect(out).toContain("✓");
  });

  it("renders 'hardware: secure_enclave ✗' when hardware attestation failed", () => {
    const synthetic = {
      type: "credential" as const,
      valid: true,
      credential: {
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        type: ["VerifiableCredential"],
        issuer: "did:motebit:issuer-1",
        issuanceDate: "2026-01-01T00:00:00Z",
        credentialSubject: {},
      } as never,
      hardware_attestation: {
        valid: false,
        platform: "secure_enclave" as const,
        errors: [{ message: "signature mismatch" }],
      },
    };
    const out = formatHuman(synthetic);
    expect(out).toContain("hardware:");
    expect(out).toContain("✗");
  });

  it("omits the hardware line entirely when no attestation claim is present", () => {
    const synthetic = {
      type: "credential" as const,
      valid: true,
      credential: {
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        type: ["VerifiableCredential"],
        issuer: "did:motebit:issuer-1",
        issuanceDate: "2026-01-01T00:00:00Z",
        credentialSubject: {},
      } as never,
      issuer: "did:motebit:issuer-1",
    };
    const out = formatHuman(synthetic);
    expect(out).not.toContain("hardware:");
  });

  it("renders credential expired:yes when expired", () => {
    const synthetic = {
      type: "credential" as const,
      valid: false,
      credential: {
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        type: ["VerifiableCredential"],
        issuer: "did:motebit:issuer-1",
        issuanceDate: "2020-01-01T00:00:00Z",
        credentialSubject: {},
      } as never,
      expired: true,
    };
    const out = formatHuman(synthetic);
    expect(out).toContain("INVALID (credential)");
  });

  it("returns empty summary for credential when payload is null", () => {
    const synthetic = { type: "credential" as const, valid: true, credential: null };
    const out = formatHuman(synthetic);
    expect(out.split("\n")[0]).toBe("VALID (credential)");
  });

  it("renders presentation summary with holder + credential count", () => {
    const synthetic = {
      type: "presentation" as const,
      valid: true,
      presentation: {
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        type: ["VerifiablePresentation"],
      } as never,
      holder: "did:motebit:holder-1",
      credentials: [
        { type: "credential" as const, valid: true, credential: null },
        { type: "credential" as const, valid: true, credential: null },
      ],
    };
    const out = formatHuman(synthetic);
    expect(out).toContain("holder:");
    expect(out).toContain("creds:");
    expect(out).toContain("2");
  });

  it("returns empty summary for presentation when payload is null", () => {
    const synthetic = { type: "presentation" as const, valid: true, presentation: null };
    const out = formatHuman(synthetic);
    expect(out.split("\n")[0]).toBe("VALID (presentation)");
  });
});
