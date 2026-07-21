#!/usr/bin/env tsx
/**
 * Generate the routing-transcript conformance corpus
 * (spec/routing-transcript-v1.md §6). Deterministic fixed keys, real
 * producer laws: transcripts are minted by `signRoutingTranscript` over a
 * basis frozen by the REAL `rankWorkersWithBasis` path (produced-basis —
 * never hand-written numbers), and every expectation is asserted against
 * the producer's own verifiers BEFORE writing.
 *
 * Two case families:
 *   - integrity    → expected verdict of `verifyRoutingTranscript` (@motebit/crypto)
 *   - faithfulness → expected verdict of `recomputeRoutingDecision` (@motebit/semiring)
 *
 * Regenerate: npx tsx scripts/gen-routing-transcript-corpus.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  signRoutingTranscript,
  verifyRoutingTranscript,
  bytesToHex,
  type VerifyRoutingTranscriptResult,
} from "../packages/crypto/src/index.js";
import { getPublicKeyBySuite } from "../packages/crypto/src/suite-dispatch.js";
import type { RoutingDecisionTranscript, MotebitId } from "../packages/protocol/src/index.js";
import { AgentTrustLevel } from "../packages/protocol/src/index.js";
import {
  rankWorkersWithBasis,
  recomputeRoutingDecision,
  type RecomputeRoutingDecisionResult,
} from "../packages/semiring/src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "spec/conformance/routing-transcript");
const OUT = join(OUT_DIR, "corpus.json");

const SUITE = "motebit-jcs-ed25519-b64-v1" as const;

// Fixed key — the delegator. Deterministic, test-only, never reuse.
const DELEGATOR_PRIV = new Uint8Array(32).fill(0x51);

interface IntegrityCase {
  name: string;
  check: "integrity";
  description: string;
  input: { transcript: unknown };
  expected: VerifyRoutingTranscriptResult;
}
interface FaithfulnessCase {
  name: string;
  check: "faithfulness";
  description: string;
  input: { basis: unknown };
  expected: RecomputeRoutingDecisionResult;
}

async function main(): Promise<void> {
  const delegatorPub = bytesToHex(await getPublicKeyBySuite(DELEGATOR_PRIV, SUITE));

  // The REAL selection path freezes the basis (produced-basis, never
  // hand-written): a proven incumbent vs a bonded newcomer.
  const { basis } = rankWorkersWithBasis(
    "0197f000-0000-7000-8000-0000000000d1" as MotebitId,
    [
      {
        motebit_id: "0197f000-0000-7000-8000-0000000000b0",
        trustRecord: {
          motebit_id: "0197f000-0000-7000-8000-0000000000d1",
          remote_motebit_id: "0197f000-0000-7000-8000-0000000000b0",
          trust_level: AgentTrustLevel.Verified,
          interaction_count: 21,
          successful_tasks: 20,
          failed_tasks: 1,
          first_seen_at: 0,
          last_seen_at: 0,
        },
        unitCost: 0.05,
      },
      {
        motebit_id: "0197f000-0000-7000-8000-0000000000c0",
        trustRecord: null,
        unitCost: 0.03,
        bonded: true,
      },
    ],
    { explore: { seed: "fixed-tick-signature-0001", strength: 1 }, capability: "web_search" },
  );
  if (basis == null) throw new Error("emitter produced no basis");

  const body: Omit<RoutingDecisionTranscript, "signature" | "suite"> = {
    spec: "motebit/routing-transcript@1.0",
    delegator_motebit_id: "0197f000-0000-7000-8000-0000000000d1",
    delegator_public_key: delegatorPub,
    issued_at: 1753056000000,
    ...basis,
  };

  const clean = await signRoutingTranscript(body, DELEGATOR_PRIV);
  const pinned = await signRoutingTranscript(
    {
      ...body,
      candidates: [basis.candidates[0]!],
      winner_motebit_id: basis.candidates[0]!.motebit_id,
      pinned: true,
      explored: false,
      strength: 0,
    },
    DELEGATOR_PRIV,
  );

  const loser = basis.candidates.find((c) => c.motebit_id !== basis.winner_motebit_id)!;

  const integrity: IntegrityCase[] = [
    {
      name: "clean",
      check: "integrity",
      description:
        "A well-formed transcript verifies. Establishes ONLY 'this delegator committed to this decision record' — faithfulness is the semiring rung.",
      input: { transcript: clean },
      expected: { valid: true },
    },
    {
      name: "pinned",
      check: "integrity",
      description:
        "A pinned hire mints a trivial transcript: the pin recorded as the reason, sole candidate, no draw.",
      input: { transcript: pinned },
      expected: { valid: true },
    },
    {
      name: "tampered-winner",
      check: "integrity",
      description:
        "Substituting another frozen candidate as winner breaks the signature (the transcript commits to the outcome).",
      input: { transcript: { ...clean, winner_motebit_id: loser.motebit_id } },
      expected: { valid: false, reason: "signature_invalid" },
    },
    {
      name: "winner-outside-set",
      check: "integrity",
      description:
        "A winner not in the frozen candidate set is structurally dishonest — rejected before any crypto.",
      input: { transcript: { ...clean, winner_motebit_id: "mallory" } },
      expected: { valid: false, reason: "winner_not_in_candidates" },
    },
    {
      name: "unsupported-suite",
      check: "integrity",
      description: "Unknown suite rejects fail-closed (crypto CLAUDE.md rule 3).",
      input: { transcript: { ...clean, suite: "motebit-mldsa44-v1" } },
      expected: { valid: false, reason: "unsupported_suite" },
    },
    {
      name: "unsupported-spec",
      check: "integrity",
      description: "Unknown wire-format version rejects fail-closed, never guessed at.",
      input: { transcript: { ...clean, spec: "motebit/routing-transcript@2.0" } },
      expected: { valid: false, reason: "unsupported_spec" },
    },
    {
      name: "empty-candidates",
      check: "integrity",
      description: "A decision among nobody is not a decision.",
      input: { transcript: { ...clean, candidates: [] } },
      expected: { valid: false, reason: "empty_candidates" },
    },
    {
      name: "malformed-public-key",
      check: "integrity",
      description: "Delegator key must be 64 lowercase hex chars.",
      input: { transcript: { ...clean, delegator_public_key: "nothex" } },
      expected: { valid: false, reason: "malformed_public_key" },
    },
    {
      name: "malformed-signature",
      check: "integrity",
      description: "Signature must be base64url of 64 bytes.",
      input: { transcript: { ...clean, signature: "!!!" } },
      expected: { valid: false, reason: "malformed_signature" },
    },
  ];

  const faithfulness: FaithfulnessCase[] = [
    {
      name: "consistent",
      check: "faithfulness",
      description:
        "An honestly-frozen basis recomputes: the draw chain reproduces and the composite yields the recorded winner.",
      input: { basis },
      expected: { consistent: true, recomputed_winner: basis.winner_motebit_id },
    },
    {
      name: "theta-tampered",
      check: "faithfulness",
      description:
        "A transcript that lies about its randomness is caught: the recorded draw does not reproduce from (alpha, beta, seed).",
      input: {
        basis: {
          ...basis,
          candidates: basis.candidates.map((c, i) => (i === 0 ? { ...c, theta: 0.999999 } : c)),
        },
      },
      expected: { consistent: false, reason: "theta_mismatch" },
    },
    {
      name: "winner-substituted",
      check: "faithfulness",
      description:
        "A substituted winner is caught by recomputation even with untouched inputs (the composite disagrees).",
      input: { basis: { ...basis, winner_motebit_id: loser.motebit_id } },
      expected: {
        consistent: false,
        reason: "winner_mismatch",
        recomputed_winner: basis.winner_motebit_id,
      },
    },
  ];

  // Assert every expectation against the producer's own laws BEFORE writing.
  for (const c of integrity) {
    const got = await verifyRoutingTranscript(c.input.transcript as RoutingDecisionTranscript);
    if (JSON.stringify(got) !== JSON.stringify(c.expected)) {
      throw new Error(`integrity case ${c.name}: got ${JSON.stringify(got)}`);
    }
  }
  for (const c of faithfulness) {
    const got = recomputeRoutingDecision(c.input.basis as never);
    if (JSON.stringify(got) !== JSON.stringify(c.expected)) {
      throw new Error(`faithfulness case ${c.name}: got ${JSON.stringify(got)}`);
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        schema: "motebit.routing-transcript-corpus.v1",
        spec: "motebit/routing-transcript@1.0",
        cases: [...integrity, ...faithfulness],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`wrote ${OUT} (${integrity.length + faithfulness.length} cases)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
