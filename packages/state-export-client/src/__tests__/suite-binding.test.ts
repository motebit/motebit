/**
 * Suite-substitution probes (F-20). The transparency declaration, the
 * agent-revocation record and the agent-revocation feed all sign a payload
 * that does NOT contain `suite` (the post-sign fields are `hash`, `suite`,
 * `signature`). An unsigned dispatch key must therefore never be trusted:
 * the verifier pins the suite these artifacts are produced under. Rewriting
 * `suite` to any other value — registered or not — without re-signing must
 * be rejected, never accepted under an attacker-chosen dispatch arm.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { generateKeypair, bytesToHex, sha256, canonicalJson, signBySuite } from "@motebit/crypto";
import { SUITE_REGISTRY } from "@motebit/protocol";
import type {
  SuiteId,
  AgentRevocationRecord,
  AgentRevocationFeed,
  SignedTransparencyDeclaration,
} from "@motebit/protocol";
import { verifyAgentRevocationRecord, verifyAgentRevocationFeed } from "../agent-revocation.js";
import { verifyTransparencyDeclaration } from "../transparency-anchor.js";

const SUITE: SuiteId = "motebit-jcs-ed25519-hex-v1";
const SUBSTITUTES: string[] = [
  ...(Object.keys(SUITE_REGISTRY) as string[]).filter((s) => s !== SUITE),
  "attacker-chosen-suite-v9",
];

let pub: Uint8Array;
let priv: Uint8Array;
let pubHex: string;

beforeAll(async () => {
  const kp = await generateKeypair();
  pub = kp.publicKey;
  priv = kp.privateKey;
  pubHex = bytesToHex(pub);
});

async function declaration(): Promise<SignedTransparencyDeclaration> {
  const payload = {
    spec: "motebit-transparency/draft-2026-04-14",
    declared_at: 1736500000000,
    relay_id: "test-relay",
    relay_public_key: pubHex,
    content: { purpose: "test" },
  };
  const canonical = new TextEncoder().encode(canonicalJson(payload));
  return {
    ...payload,
    hash: bytesToHex(await sha256(canonical)),
    suite: SUITE,
    signature: bytesToHex(await signBySuite(SUITE, canonical, priv)),
  } as SignedTransparencyDeclaration;
}

async function record(): Promise<AgentRevocationRecord> {
  const payload = {
    spec: "motebit-agent-revocation/draft-2026-06-04",
    motebit_id: "019dd011-0000-7000-8000-00000000be7c",
    revoked: true,
    reason: "operator_test_cleanup",
    actor: "operator",
    effective_at: 1_780_000_000_000,
    relay_id: "test-relay",
    relay_public_key: pubHex,
  };
  const canonical = new TextEncoder().encode(canonicalJson(payload));
  return {
    ...payload,
    hash: bytesToHex(await sha256(canonical)),
    suite: SUITE,
    signature: bytesToHex(await signBySuite(SUITE, canonical, priv)),
  } as AgentRevocationRecord;
}

async function feed(records: AgentRevocationRecord[]): Promise<AgentRevocationFeed> {
  const payload = {
    spec: "motebit-agent-revocation/draft-2026-06-04",
    relay_id: "test-relay",
    relay_public_key: pubHex,
    generated_at: 1_780_000_001_000,
    records,
  };
  const canonical = new TextEncoder().encode(canonicalJson(payload));
  return {
    ...payload,
    suite: SUITE,
    signature: bytesToHex(await signBySuite(SUITE, canonical, priv)),
  } as AgentRevocationFeed;
}

describe("suite substitution without re-signing (F-20)", () => {
  it("controls: untampered artifacts verify", async () => {
    expect((await verifyTransparencyDeclaration(await declaration())).ok).toBe(true);
    expect((await verifyAgentRevocationRecord(await record())).ok).toBe(true);
    expect((await verifyAgentRevocationFeed(await feed([await record()]))).ok).toBe(true);
  });

  for (const s of SUBSTITUTES) {
    it(`transparency declaration rejects suite=${s}`, async () => {
      const d = { ...(await declaration()), suite: s as SuiteId };
      const r = await verifyTransparencyDeclaration(d);
      expect(r.ok).toBe(false);
    });

    it(`agent-revocation record rejects suite=${s}`, async () => {
      const rec = { ...(await record()), suite: s as SuiteId };
      expect((await verifyAgentRevocationRecord(rec)).ok).toBe(false);
    });

    it(`agent-revocation feed rejects envelope suite=${s}`, async () => {
      const f = { ...(await feed([await record()])), suite: s as SuiteId };
      expect((await verifyAgentRevocationFeed(f)).ok).toBe(false);
    });
  }
});
