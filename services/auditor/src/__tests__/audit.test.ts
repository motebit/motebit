/**
 * Auditor engine tests — refusal paths, per-check honesty (the load-bearing
 * negatives: a tampered feed reads `unchecked`, NEVER `fresh`), and the
 * full attestation roundtrip.
 *
 * Fixtures are minted with @motebit/crypto (devDependency — test files are
 * exempt from check-service-primitives; production src consumes only the
 * verifier/state-export-client aggregators). The relay is a Map-backed
 * fetcher stub: the engine's fetchRelay seam is the whole I/O surface, so
 * no HTTP server is needed to exercise every path end-to-end.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  sha256,
  canonicalJson,
  signBySuite,
  deriveSovereignMotebitId,
  signExecutionReceipt,
  hash,
} from "@motebit/crypto";
import { verifyEvalAttestation } from "@motebit/verifier";
import type { SuiteId } from "@motebit/sdk";

import { runAudit, parseAuditPrompt, AuditRefusal, type AuditDeps } from "../audit.js";
import type { FetchedEvidence, RelayFetcher } from "../evidence.js";

const HEX_SUITE: SuiteId = "motebit-jcs-ed25519-hex-v1";
const NOW = 1_752_000_000_000;

interface Keys {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  publicKeyHex: string;
}

async function makeKeys(): Promise<Keys> {
  const kp = await generateKeypair();
  return {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyHex: bytesToHex(kp.publicKey),
  };
}

/** Signed transparency declaration — the relay transparency.ts shape. */
async function buildDeclaration(signer: Keys): Promise<Record<string, unknown>> {
  const payload = {
    spec: "motebit-transparency/draft-2026-04-14",
    declared_at: NOW - 1000,
    relay_id: "test-relay",
    relay_public_key: signer.publicKeyHex,
    content: { purpose: "test" },
  };
  const canonical = new TextEncoder().encode(canonicalJson(payload));
  return {
    ...payload,
    hash: bytesToHex(await sha256(canonical)),
    suite: HEX_SUITE,
    signature: bytesToHex(await signBySuite(HEX_SUITE, canonical, signer.privateKey)),
  };
}

/** Individually-signed revocation record (agent-revocation shape). */
async function buildRevocationRecord(
  signer: Keys,
  motebitId: string,
  revoked: boolean,
): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    spec: "motebit-agent-revocation/draft-2026-06-04",
    motebit_id: motebitId,
    revoked,
    reason: revoked ? "operator_test_cleanup" : "reinstated",
    actor: "operator",
    effective_at: NOW - 5000,
    relay_id: "test-relay",
    relay_public_key: signer.publicKeyHex,
  };
  const canonical = new TextEncoder().encode(canonicalJson(payload));
  return {
    ...payload,
    hash: bytesToHex(await sha256(canonical)),
    suite: HEX_SUITE,
    signature: bytesToHex(await signBySuite(HEX_SUITE, canonical, signer.privateKey)),
  };
}

/** Relay-signed revocation feed over the records. */
async function buildFeed(
  signer: Keys,
  records: Array<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const payload = {
    spec: "motebit-agent-revocation/draft-2026-06-04",
    relay_id: "test-relay",
    relay_public_key: signer.publicKeyHex,
    generated_at: NOW - 2000,
    records,
  };
  const canonical = new TextEncoder().encode(canonicalJson(payload));
  return {
    ...payload,
    suite: HEX_SUITE,
    signature: bytesToHex(await signBySuite(HEX_SUITE, canonical, signer.privateKey)),
  };
}

function stubFetcher(routes: Map<string, { status: number; body: unknown }>): RelayFetcher {
  return async (path: string): Promise<FetchedEvidence> => {
    const hit = routes.get(path);
    if (!hit) {
      const bytes = new TextEncoder().encode("{}");
      return { status: 404, bytes, text: "{}" };
    }
    const text = typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body);
    const bytes = new TextEncoder().encode(text);
    return { status: hit.status, bytes, text };
  };
}

let relay: Keys;
let issuer: Keys;
let target: Keys;
let targetId: string;
let declaration: Record<string, unknown>;

beforeAll(async () => {
  relay = await makeKeys();
  issuer = await makeKeys();
  target = await makeKeys();
  targetId = await deriveSovereignMotebitId(target.publicKeyHex);
  declaration = await buildDeclaration(relay);
});

function baseRoutes(): Map<string, { status: number; body: unknown }> {
  return new Map([
    ["/.well-known/motebit-transparency.json", { status: 200, body: declaration }],
    [
      `/api/v1/discover/${targetId}`,
      { status: 200, body: { motebit_id: targetId, public_key: target.publicKeyHex } },
    ],
    [`/api/v1/agents/${targetId}/succession`, { status: 200, body: { chain: [] } }],
  ]);
}

function deps(routes: Map<string, { status: number; body: unknown }>): AuditDeps {
  return {
    fetchRelay: stubFetcher(routes),
    now: () => NOW,
    receiptSampleN: 3,
    issuer: {
      motebitId: "0197f000-0000-7000-8000-0000000000aa",
      publicKeyHex: issuer.publicKeyHex,
    },
  };
}

describe("parseAuditPrompt", () => {
  it("accepts a bare motebit_id", () => {
    expect(parseAuditPrompt("  abc  ")).toEqual({ target: "abc" });
  });
  it("accepts a JSON request", () => {
    expect(parseAuditPrompt('{"target":"t","checks":["revocation"]}')).toEqual({
      target: "t",
      checks: ["revocation"],
    });
  });
  it("refuses malformed JSON", () => {
    expect(() => parseAuditPrompt("{nope")).toThrowError(AuditRefusal);
  });
  it("refuses a JSON request without target", () => {
    expect(() => parseAuditPrompt('{"checks":[]}')).toThrowError(AuditRefusal);
  });
  it("refuses an empty prompt", () => {
    expect(() => parseAuditPrompt("   ")).toThrowError(AuditRefusal);
  });
});

describe("runAudit — refusal paths (no attestation is minted)", () => {
  it("refuses a malformed target id", async () => {
    await expect(runAudit({ target: "not-a-uuid" }, deps(baseRoutes()))).rejects.toMatchObject({
      code: "request.malformed_target",
    });
  });

  it("refuses unknown check names", async () => {
    await expect(
      runAudit({ target: targetId, checks: ["vibes"] }, deps(baseRoutes())),
    ).rejects.toMatchObject({ code: "request.unknown_check" });
  });

  it("refuses when the transparency declaration is unreachable", async () => {
    const routes = baseRoutes();
    routes.delete("/.well-known/motebit-transparency.json");
    await expect(runAudit({ target: targetId }, deps(routes))).rejects.toMatchObject({
      code: "bootstrap.transparency_unreachable",
    });
  });

  it("refuses when the transparency declaration fails verification", async () => {
    const routes = baseRoutes();
    routes.set("/.well-known/motebit-transparency.json", {
      status: 200,
      body: { ...declaration, declared_at: 1 }, // breaks hash + signature
    });
    await expect(runAudit({ target: targetId }, deps(routes))).rejects.toMatchObject({
      code: "bootstrap.transparency_invalid",
    });
  });

  it("refuses on a relay-key pin mismatch", async () => {
    const d = deps(baseRoutes());
    await expect(
      runAudit({ target: targetId }, { ...d, pinnedRelayKey: "ab".repeat(32) }),
    ).rejects.toMatchObject({ code: "bootstrap.pin_mismatch" });
  });

  it("refuses a nonexistent target", async () => {
    const routes = baseRoutes();
    routes.delete(`/api/v1/discover/${targetId}`);
    await expect(runAudit({ target: targetId }, deps(routes))).rejects.toMatchObject({
      code: "request.target_not_found",
    });
  });

  it("refuses when nothing was measured (unclaimed properties only)", async () => {
    // succession with an empty chain yields no verdict; requesting only it
    // measures nothing — an attestation that measured nothing is refused.
    await expect(
      runAudit({ target: targetId, checks: ["succession"] }, deps(baseRoutes())),
    ).rejects.toMatchObject({ code: "audit.nothing_measured" });
  });
});

describe("runAudit — per-check honesty", () => {
  it("identity_binding: a sovereign id reads sovereign, clean", async () => {
    const outcome = await runAudit(
      { target: targetId, checks: ["identity_binding"] },
      deps(baseRoutes()),
    );
    const r = outcome.body.results.find((x) => x.check === "identity_binding")!;
    expect(r.verdict.integrity).toBe("verified");
    expect(r.verdict.identityBinding).toBe("sovereign");
    expect(r.verdict.temporalBasis).toBe("clockless");
    expect(r.verdict.repair).toBeUndefined();
  });

  it("identity_binding: a non-sovereign id reads unverified with repair — never invalid", async () => {
    const randomId = "0197f000-0000-7000-8000-0000000000bb";
    const routes = baseRoutes();
    routes.set(`/api/v1/discover/${randomId}`, {
      status: 200,
      body: { motebit_id: randomId, public_key: target.publicKeyHex },
    });
    const outcome = await runAudit(
      { target: randomId, checks: ["identity_binding"] },
      deps(routes),
    );
    const r = outcome.body.results[0]!;
    expect(r.verdict.integrity).toBe("verified");
    expect(r.verdict.identityBinding).toBe("unverified");
    expect(r.verdict.repair?.code).toBe("identity.embedded_key_only");
  });

  it("revocation: absent from a VERIFIED feed reads fresh with a stapled basis", async () => {
    const feed = await buildFeed(relay, []);
    const routes = baseRoutes();
    routes.set("/api/v1/agents/revocations", { status: 200, body: feed });
    const outcome = await runAudit({ target: targetId, checks: ["revocation"] }, deps(routes));
    const r = outcome.body.results[0]!;
    expect(r.verdict.revocation.status).toBe("fresh");
    expect(r.verdict.revocation.freshness?.basis).toBe("stapled");
    expect(r.verdict.integrity).toBe("verified");
  });

  it("revocation: a revoked target reads revoked", async () => {
    const rec = await buildRevocationRecord(relay, targetId, true);
    const feed = await buildFeed(relay, [rec]);
    const routes = baseRoutes();
    routes.set("/api/v1/agents/revocations", { status: 200, body: feed });
    const outcome = await runAudit({ target: targetId, checks: ["revocation"] }, deps(routes));
    expect(outcome.body.results[0]!.verdict.revocation.status).toBe("revoked");
  });

  it("revocation: a reinstatement (latest revoked:false) reads fresh", async () => {
    const rev = await buildRevocationRecord(relay, targetId, true);
    const rein = await buildRevocationRecord(relay, targetId, false);
    const feed = await buildFeed(relay, [rev, rein]);
    const routes = baseRoutes();
    routes.set("/api/v1/agents/revocations", { status: 200, body: feed });
    const outcome = await runAudit({ target: targetId, checks: ["revocation"] }, deps(routes));
    expect(outcome.body.results[0]!.verdict.revocation.status).toBe("fresh");
  });

  it("revocation: a TAMPERED feed reads unchecked — never manufactured fresh", async () => {
    const feed = await buildFeed(relay, []);
    const routes = baseRoutes();
    routes.set("/api/v1/agents/revocations", {
      status: 200,
      body: { ...feed, generated_at: 1 }, // breaks the feed signature
    });
    const outcome = await runAudit({ target: targetId, checks: ["revocation"] }, deps(routes));
    const r = outcome.body.results[0]!;
    expect(r.verdict.revocation.status).toBe("unchecked");
    expect(r.verdict.repair?.code).toBe("revocation.unchecked");
  });

  it("revocation: an unreachable feed reads unchecked with repair", async () => {
    const outcome = await runAudit(
      { target: targetId, checks: ["revocation"] },
      deps(baseRoutes()),
    );
    const r = outcome.body.results[0]!;
    expect(r.verdict.revocation.status).toBe("unchecked");
    expect(r.verdict.repair).toBeDefined();
  });

  it("bond: no bond claimed yields NO verdict (unclaimed property)", async () => {
    const outcome = await runAudit(
      { target: targetId, checks: ["bond", "identity_binding"] },
      deps(baseRoutes()),
    );
    expect(outcome.body.results.find((r) => r.check === "bond")).toBeUndefined();
  });

  it("bond: an invalid commitment reads integrity invalid with repair", async () => {
    const routes = baseRoutes();
    routes.set(`/api/v1/agents/${targetId}/bond`, {
      status: 200,
      body: {
        bond_commitment: {
          suite: "motebit-jcs-ed25519-hex-v1",
          bonded_public_key: target.publicKeyHex,
          bonded_address: "not-the-derived-address",
          issued_at: NOW - 1000,
          expires_at: NOW + 1000,
          signature: "00".repeat(64),
        },
      },
    });
    const outcome = await runAudit({ target: targetId, checks: ["bond"] }, deps(routes));
    const r = outcome.body.results[0]!;
    expect(r.verdict.integrity).toBe("invalid");
    expect(r.verdict.repair?.code).toBe("bond.commitment_invalid");
  });

  it("receipt_spot_check: verifyReceiptVerdict passes through verbatim, incl. tamper", async () => {
    const worker = await makeKeys();
    const receiptBody = {
      task_id: "task-001",
      motebit_id: await deriveSovereignMotebitId(worker.publicKeyHex),
      device_id: "device-001",
      submitted_at: NOW - 60_000,
      completed_at: NOW,
      status: "completed" as const,
      result: "done",
      tools_used: ["audit_agent"],
      memories_formed: 0,
      prompt_hash: await hash(new TextEncoder().encode("audit prompt")),
      result_hash: await hash(new TextEncoder().encode("done")),
    };
    const signed = await signExecutionReceipt(receiptBody, worker.privateKey, worker.publicKey);
    const tampered = { ...signed, result: "tampered" };
    const outcome = await runAudit(
      { target: targetId, checks: ["receipt_spot_check"], receipts: [signed, tampered] },
      deps(baseRoutes()),
    );
    const clean = outcome.body.results.find((r) => r.check === "receipt_spot_check_0")!;
    const bad = outcome.body.results.find((r) => r.check === "receipt_spot_check_1")!;
    expect(clean.verdict.integrity).toBe("verified");
    expect(bad.verdict.integrity).toBe("invalid");
    // Honest unknowns survive the passthrough — no manufactured authority.
    expect(clean.verdict.authority).toBe("unknown");
  });
});

describe("runAudit — the attestation roundtrip", () => {
  it("produces a signable body that verifies as an EvalAttestation", async () => {
    const feed = await buildFeed(relay, []);
    const routes = baseRoutes();
    routes.set("/api/v1/agents/revocations", { status: 200, body: feed });

    const outcome = await runAudit({ target: targetId }, deps(routes));
    expect(outcome.body.eval_kind).toBe("verification_audit");
    expect(outcome.body.subject.motebit_id).toBe(targetId);
    expect(outcome.body.results.length).toBeGreaterThanOrEqual(2);
    expect(outcome.body.subject.artifact_digests!.length).toBeGreaterThan(0);
    expect(outcome.body.evidence!.length).toBeGreaterThan(0);
    expect(outcome.summary).toContain(targetId);

    const { signEvalAttestation } = await import("@motebit/verifier");
    const attestation = await signEvalAttestation(outcome.body, issuer.privateKey);
    expect(await verifyEvalAttestation(attestation)).toEqual({ valid: true });
    // subject ≠ signer — the category law, visible in the artifact.
    expect(attestation.subject.motebit_id).not.toBe(attestation.issuer.motebit_id);
  });
});
