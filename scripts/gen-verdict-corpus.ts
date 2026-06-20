/**
 * Generator for the VerificationVerdict conformance corpus.
 *
 * Writes spec/conformance/verification-verdict/corpus.json — the versioned,
 * pinnable set of vectors a second implementation runs ITS verifiers against
 * (the "neither of us in the room" bar from docs/doctrine/verify-family-fail-closed.md).
 *
 * Determinism: every artifact is minted from FIXED private keys. Ed25519 keygen
 * and signing are deterministic, so the signed bytes — and therefore the
 * verdicts — are byte-stable across runs. Re-running this generator on an
 * unchanged producer reproduces corpus.json exactly.
 *
 * Non-circularity guard: each case carries a hand-coded INVARIANT on its load-
 * bearing axes; the generator asserts the producer's output matches the
 * invariant BEFORE writing. A producer regression that changes a status can't be
 * silently re-frozen into the corpus — the generator throws.
 *
 * Regenerate:  npx tsx scripts/gen-verdict-corpus.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  signExecutionReceipt,
  signStandingDelegation,
  signDelegation,
  signDelegationRevocation,
  deriveSovereignMotebitId,
  bytesToHex,
  hash,
  verifyReceiptVerdict,
  verifyDelegationTokenVerdict,
  type SignableReceipt,
  type VerificationVerdict,
} from "../packages/crypto/src/index.js";
import { getPublicKeyBySuite } from "../packages/crypto/src/suite-dispatch.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "spec/conformance/verification-verdict");
const OUT = join(OUT_DIR, "corpus.json");
const SUITE = "motebit-jcs-ed25519-b64-v1" as const;
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

async function fixedKp(fill: number) {
  const priv = new Uint8Array(32).fill(fill);
  const pub = await getPublicKeyBySuite(priv, SUITE);
  return { priv, pub, hex: bytesToHex(pub) };
}

function makeReceipt(
  overrides: Partial<Omit<SignableReceipt, "signature" | "suite">> = {},
): Omit<SignableReceipt, "signature" | "suite"> {
  return {
    task_id: "task-001",
    motebit_id: "mote-alice",
    device_id: "device-001",
    submitted_at: NOW,
    completed_at: NOW + 60_000,
    status: "completed",
    result: "Task completed successfully",
    tools_used: ["web_search"],
    memories_formed: 1,
    prompt_hash: "a".repeat(64),
    result_hash: "b".repeat(64),
    ...overrides,
  };
}

interface ReceiptCase {
  name: string;
  kind: "receipt";
  description: string;
  input: { receipt: SignableReceipt };
  expected: VerificationVerdict;
}
interface TokenCase {
  name: string;
  kind: "delegation_token";
  description: string;
  input: { token: unknown; grant: unknown; options?: unknown };
  expected: VerificationVerdict;
}
type Case = ReceiptCase | TokenCase;

/** Assert the producer's output matches the hand-coded invariant on the load-bearing axes. */
function assertInvariant(
  name: string,
  v: VerificationVerdict,
  inv: Partial<Record<string, unknown>>,
) {
  for (const [path, want] of Object.entries(inv)) {
    const got = path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], v);
    if (got !== want) {
      throw new Error(
        `corpus invariant failed for "${name}": ${path} = ${String(got)}, want ${String(want)}`,
      );
    }
  }
}

async function main() {
  const cases: Case[] = [];

  // --- Receipt path -------------------------------------------------------
  const del = await fixedKp(1);
  const sovereignId = await deriveSovereignMotebitId(del.hex);

  const realResultHash = await hash(new TextEncoder().encode(makeReceipt().result));
  const r2 = await signExecutionReceipt(
    makeReceipt({ motebit_id: sovereignId, result_hash: realResultHash }),
    del.priv,
    del.pub,
  );
  const v2 = await verifyReceiptVerdict(r2);
  assertInvariant("receipt-sovereign-not-pinned", v2, {
    integrity: "verified",
    identityBinding: "sovereign",
    authority: "unknown",
    "revocation.status": "unchecked",
    temporalBasis: "clockless",
  });
  cases.push({
    name: "receipt-sovereign-not-pinned",
    kind: "receipt",
    description:
      "A real signed receipt whose motebit_id commits to its embedded key (sovereign) but is NOT a pinned agent. integrity verified, binding sovereign (< pinned); authority/revocation are 'not established', never manufactured.",
    input: { receipt: r2 },
    expected: v2,
  });

  const tampered: SignableReceipt = { ...r2, result_hash: "c".repeat(64) };
  const vT = await verifyReceiptVerdict(tampered);
  assertInvariant("receipt-tampered", vT, { integrity: "invalid" });
  cases.push({
    name: "receipt-tampered",
    kind: "receipt",
    description: "result_hash tampered after signing → integrity invalid + integrity repair.",
    input: { receipt: tampered },
    expected: vT,
  });

  // A VALID signature over a receipt whose result_hash does NOT bind `result`.
  const rHashInconsistent = await signExecutionReceipt(
    { ...makeReceipt({ motebit_id: sovereignId }), result_hash: "d".repeat(64) },
    del.priv,
    del.pub,
  );
  const vHI = await verifyReceiptVerdict(rHashInconsistent);
  assertInvariant("receipt-signed-hash-inconsistent", vHI, { integrity: "invalid" });
  cases.push({
    name: "receipt-signed-hash-inconsistent",
    kind: "receipt",
    description:
      "A VALID Ed25519 signature over a receipt whose result_hash does NOT bind result (hex(SHA-256(result)) != result_hash). integrity 'invalid' with a hash_inconsistent repair — DISTINCT from a bad signature. A valid signature over a self-inconsistent body is the silent-true integrity must catch.",
    input: { receipt: rHashInconsistent },
    expected: vHI,
  });

  const rEmbedded = await signExecutionReceipt(
    makeReceipt({ motebit_id: "mote-not-sovereign", result_hash: realResultHash }),
    del.priv,
    del.pub,
  );
  const vE = await verifyReceiptVerdict(rEmbedded);
  assertInvariant("receipt-embedded-key-only", vE, {
    integrity: "verified",
    identityBinding: "unverified",
  });
  cases.push({
    name: "receipt-embedded-key-only",
    kind: "receipt",
    description:
      "Signature verifies but the motebit_id does NOT commit to the embedded key → integrity verified, identityBinding unverified (the embedded-key footgun, named) + repair.",
    input: { receipt: rEmbedded },
    expected: vE,
  });

  // --- Token path ---------------------------------------------------------
  const delegate = await fixedKp(2);
  const parties = {
    delegator_id: sovereignId,
    delegator_public_key: del.hex,
    delegate_id: "mote-delegate",
    delegate_public_key: delegate.hex,
  };
  const grant = await signStandingDelegation(
    {
      grant_id: "grant-1",
      ...parties,
      scope: "web.search,brief.compose",
      subject: "research:thesis=x",
      cadence_ms: DAY,
      issued_at: NOW - 1000,
      not_before: null,
      expires_at: NOW + 30 * DAY,
      max_token_ttl_ms: HOUR,
    },
    del.priv,
  );
  const tickFields = { ...parties, scope: "web.search", grant_id: "grant-1" };

  // Fixture 1 — revoked grant, well-formed in-TTL tick.
  const tok1 = await signDelegation(
    { ...tickFields, issued_at: NOW, expires_at: NOW + HOUR },
    del.priv,
  );
  const revocation = await signDelegationRevocation(
    {
      grant_id: "grant-1",
      delegator_id: parties.delegator_id,
      delegator_public_key: parties.delegator_public_key,
      revoked_at: NOW - 500,
    },
    del.priv,
  );
  const opts1 = {
    revocations: [revocation],
    revocationFreshness: { basis: "asserted", asOf: { timestamp_ms: NOW } },
    now: NOW,
  };
  const v1 = await verifyDelegationTokenVerdict(tok1, grant, opts1 as never);
  assertInvariant("token-revoked-grant-self-mint", v1, {
    integrity: "verified",
    authority: "valid",
    "revocation.status": "revoked",
    temporalBasis: "local_clock",
  });
  cases.push({
    name: "token-revoked-grant-self-mint",
    kind: "delegation_token",
    description:
      "A revoked grant's tick that is itself well-formed and in-TTL. Every axis a consumer might compose a pass over LOOKS like a pass — except revocation, which is its own load-bearing axis. The bare boolean lies; the verdict can't.",
    input: { token: tok1, grant, options: opts1 },
    expected: v1,
  });

  // Fixture 3 + anti — pre-minted future-slot token, verifier clock rolled back.
  const slot = NOW + 10 * DAY;
  const tok3 = await signDelegation(
    { ...tickFields, issued_at: slot, not_before: slot, expires_at: slot + HOUR },
    del.priv,
  );
  const freshness = { basis: "asserted", asOf: { timestamp_ms: NOW } };

  const opts3o = {
    now: NOW,
    temporalMode: "ordering",
    revocations: [],
    revocationFreshness: freshness,
  };
  const v3o = await verifyDelegationTokenVerdict(tok3, grant, opts3o as never);
  assertInvariant("token-clock-rollback-ordering", v3o, {
    authority: "valid",
    temporalBasis: "clockless",
    "revocation.status": "fresh",
  });
  cases.push({
    name: "token-clock-rollback-ordering",
    kind: "delegation_token",
    description:
      "Pre-minted future-slot token, verifier clock rolled BACK before the slot, judged by ORDERING. The wall-clock window is not consulted → authority valid, temporalBasis clockless. The rollback is irrelevant.",
    input: { token: tok3, grant, options: opts3o },
    expected: v3o,
  });

  const opts3w = {
    now: NOW,
    temporalMode: "wall_clock",
    revocations: [],
    revocationFreshness: freshness,
  };
  const v3w = await verifyDelegationTokenVerdict(tok3, grant, opts3w as never);
  assertInvariant("token-clock-rollback-wall-clock", v3w, {
    authority: "not_yet_valid",
    temporalBasis: "local_clock",
  });
  cases.push({
    name: "token-clock-rollback-wall-clock",
    kind: "delegation_token",
    description:
      "The SAME token as token-clock-rollback-ordering, judged by WALL-CLOCK with the rolled-back clock → authority not_yet_valid, temporalBasis local_clock. The pair proves a consumer MUST branch on temporalBasis, never assume wall-clock.",
    input: { token: tok3, grant, options: opts3w },
    expected: v3w,
  });

  mkdirSync(OUT_DIR, { recursive: true });
  const corpus = {
    schema: "motebit.verification-verdict-corpus.v1",
    description:
      "Conformance vectors for the VerificationVerdict arc. Each case: run the named producer over `input`, assert the result deep-equals `expected`. See ./README.md.",
    generator: "scripts/gen-verdict-corpus.ts",
    cases,
  };
  writeFileSync(OUT, JSON.stringify(corpus, null, 2) + "\n");
  process.stdout.write(`wrote ${cases.length} cases → ${OUT.replace(ROOT + "/", "")}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(
    `gen-verdict-corpus failed: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(1);
});
