/**
 * The Auditor's v1 check catalog — each check maps public evidence onto a
 * per-axis `VerificationVerdict`, never a boolean. Per-axis honesty is the
 * whole discipline:
 *
 *   - unreachable / unverifiable evidence produces `unchecked` / `unknown` /
 *     `unverified` axis values with a `repair`, NEVER a manufactured pass;
 *   - unsigned observations (a listing read) are attestation-level EVIDENCE,
 *     never verdicts — `IntegrityVerdict` has no "unknown", so unsigned
 *     bytes cannot honestly produce one;
 *   - a subject that claims nothing (no succession chain, no bond) yields
 *     no verdict for that check — you cannot measure an unclaimed property.
 *
 * Import discipline (check-service-primitives): laws come ONLY from
 * `@motebit/verifier` and `@motebit/state-export-client`; types from
 * `@motebit/sdk`. Never `@motebit/crypto` or `@motebit/protocol` directly.
 *
 * Deferred (named in the service README): `bond_backing` (Solana RPC read
 * of the bonded address — ledger_anchored basis) and `solvency` (the
 * relay-signed solvency proof has no packaged verify law yet; adding one
 * to the aggregator is the check's prerequisite, not an excuse to inline
 * crypto here).
 */

import {
  verifySovereignBinding,
  verifySuccessionChain,
  verifyBondCommitment,
  verifyReceiptVerdict,
} from "@motebit/verifier";
import { verifyAgentRevocationFeed } from "@motebit/state-export-client";
import type { AgentRevocationFeed } from "@motebit/state-export-client";
import type {
  EvalResult,
  EvidenceRef,
  DigestRef,
  VerificationVerdict,
  RepairInstruction,
} from "@motebit/sdk";
import { evidenceRefFor, digestRef, type RelayFetcher } from "./evidence.js";

export interface CheckContext {
  readonly target: string;
  readonly fetchRelay: RelayFetcher;
  /** Pinned relay transparency key (hex) — established by the trust bootstrap. */
  readonly relayPublicKey: string;
  readonly now: () => number;
}

export interface CheckOutput {
  readonly results: EvalResult[];
  /** Attestation-level evidence (unsigned observations + raw reads). */
  readonly evidence: EvidenceRef[];
  /** Content addresses of subject artifacts consumed. */
  readonly artifactDigests: DigestRef[];
}

function repair(
  code: string,
  axis: RepairInstruction["axis"],
  summary: string,
  fix: string,
): RepairInstruction {
  return { code, axis, summary, fix };
}

/**
 * identity_binding — the sovereign rung, measured offline from the target's
 * registered public key (`GET /api/v1/discover/:id`).
 *
 * Axis mapping: `integrity` reports whether the key material was well-formed
 * enough to run the derivation (the check's own artifact); `identityBinding`
 * is the honest rung — `sovereign` when the id commits to the key, else
 * `unverified` (a legacy random id is not invalid; it simply never claimed
 * the sovereign binding). Clockless — pure derivation.
 */
export async function checkIdentityBinding(ctx: CheckContext): Promise<CheckOutput> {
  const res = await ctx.fetchRelay(`/api/v1/discover/${ctx.target}`);
  if (res.status !== 200) {
    // Target not found is a REFUSAL condition handled by the orchestrator;
    // reaching here with a non-200 mid-audit degrades honestly.
    const verdict: VerificationVerdict = {
      type: "identity",
      integrity: "invalid",
      identityBinding: "unverified",
      authority: "unknown",
      revocation: { status: "unchecked" },
      temporalBasis: "clockless",
      evidenceBasis: [],
      repair: repair(
        "evidence.unreachable",
        "identityBinding",
        `discover read for ${ctx.target} returned ${res.status}`,
        "Retry when the relay's /api/v1/discover/:id endpoint is reachable",
      ),
    };
    return { results: [{ check: "identity_binding", verdict }], evidence: [], artifactDigests: [] };
  }

  const record = JSON.parse(res.text) as { public_key?: string };
  const publicKey = record.public_key ?? "";
  const evidence = [evidenceRefFor("discover_record", res.bytes, publicKey || undefined)];
  const artifactDigests = [digestRef(res.bytes)];

  if (!/^[0-9a-f]{64}$/i.test(publicKey)) {
    const verdict: VerificationVerdict = {
      type: "identity",
      integrity: "invalid",
      identityBinding: "unverified",
      authority: "unknown",
      revocation: { status: "unchecked" },
      temporalBasis: "clockless",
      evidenceBasis: evidence,
      repair: repair(
        "identity.malformed_key",
        "identityBinding",
        "registered public key is not 32-byte hex Ed25519",
        "Inspect the agent's registration — the discover record carries a malformed key",
      ),
    };
    return { results: [{ check: "identity_binding", verdict }], evidence, artifactDigests };
  }

  const sovereign = await verifySovereignBinding(ctx.target, publicKey);
  const verdict: VerificationVerdict = {
    type: "identity",
    integrity: "verified",
    identityBinding: sovereign ? "sovereign" : "unverified",
    authority: "unknown",
    revocation: { status: "unchecked" },
    temporalBasis: "clockless",
    evidenceBasis: evidence,
    ...(sovereign
      ? {}
      : {
          repair: repair(
            "identity.embedded_key_only",
            "identityBinding",
            "the motebit_id does not commit to the registered key (legacy or non-sovereign id)",
            "Treat the binding as operator-pinned at best; consult /api/v1/identity/:id for the anchored rung",
          ),
        }),
  };
  return { results: [{ check: "identity_binding", verdict }], evidence, artifactDigests };
}

/**
 * succession — key lineage over the self-signed chain the relay serves at
 * `GET /api/v1/agents/:id/succession`. An EMPTY chain is not a verdict (the
 * subject never claimed a succession); a present chain is verified offline
 * via `verifySuccessionChain`.
 */
export async function checkSuccession(ctx: CheckContext): Promise<CheckOutput> {
  const res = await ctx.fetchRelay(`/api/v1/agents/${ctx.target}/succession`);
  if (res.status !== 200) {
    const verdict: VerificationVerdict = {
      type: "succession",
      integrity: "invalid",
      identityBinding: "unverified",
      authority: "unknown",
      revocation: { status: "unchecked" },
      temporalBasis: "clockless",
      evidenceBasis: [],
      repair: repair(
        "evidence.unreachable",
        "integrity",
        `succession read returned ${res.status}`,
        "Retry when the relay's succession endpoint is reachable",
      ),
    };
    return { results: [{ check: "succession", verdict }], evidence: [], artifactDigests: [] };
  }

  const body = JSON.parse(res.text) as { chain?: unknown[] };
  const chain = Array.isArray(body.chain) ? body.chain : [];
  const evidence = [evidenceRefFor("succession_chain", res.bytes)];
  const artifactDigests = [digestRef(res.bytes)];

  if (chain.length === 0) {
    // Nothing claimed — evidence only, no verdict. You cannot measure an
    // unclaimed property; minting an "invalid" here would manufacture a
    // failure for the common single-key agent.
    return { results: [], evidence, artifactDigests };
  }

  const chainResult = await verifySuccessionChain(
    chain as Parameters<typeof verifySuccessionChain>[0],
  );
  const verdict: VerificationVerdict = {
    type: "succession",
    integrity: chainResult.valid ? "verified" : "invalid",
    identityBinding: chainResult.valid ? "pinned" : "invalid",
    authority: "unknown",
    revocation: { status: "unchecked" },
    temporalBasis: "clockless",
    evidenceBasis: evidence,
    ...(chainResult.valid
      ? {}
      : {
          repair: repair(
            "succession.chain_invalid",
            "integrity",
            `succession chain failed at index ${chainResult.error?.index ?? 0}: ${chainResult.error?.message ?? "unknown"}`,
            "Verify each KeySuccessionRecord signature offline via @motebit/verifier verifyKeySuccession",
          ),
        }),
  };
  return { results: [{ check: "succession", verdict }], evidence, artifactDigests };
}

/**
 * revocation — the operator's signed moderation feed
 * (`GET /api/v1/agents/revocations`), verified against the PINNED relay key.
 * Absent-from-a-verified-feed is the only honest "fresh": basis `stapled`
 * (a relay-signed feed, not a chain root), asOf the feed's generated_at.
 * An unreachable or unverifiable feed is `unchecked` — never manufactured
 * fresh.
 */
export async function checkRevocation(ctx: CheckContext): Promise<CheckOutput> {
  const uncheckedVerdict = (why: string, fix: string): VerificationVerdict => ({
    type: "revocation",
    integrity: "invalid",
    identityBinding: "unverified",
    authority: "unknown",
    revocation: { status: "unchecked" },
    temporalBasis: "local_clock",
    evidenceBasis: [],
    repair: repair("revocation.unchecked", "revocation", why, fix),
  });

  const res = await ctx.fetchRelay(`/api/v1/agents/revocations`);
  if (res.status !== 200) {
    return {
      results: [
        {
          check: "revocation",
          verdict: uncheckedVerdict(
            `revocation feed returned ${res.status}`,
            "Retry when the relay's /api/v1/agents/revocations endpoint is reachable",
          ),
        },
      ],
      evidence: [],
      artifactDigests: [],
    };
  }

  const feed = JSON.parse(res.text) as AgentRevocationFeed;
  const feedResult = await verifyAgentRevocationFeed(feed, ctx.relayPublicKey);
  if (!feedResult.ok) {
    return {
      results: [
        {
          check: "revocation",
          verdict: uncheckedVerdict(
            `revocation feed failed verification: ${feedResult.reason}`,
            "Do not trust this feed instance; re-fetch and re-verify against the pinned relay key",
          ),
        },
      ],
      evidence: [evidenceRefFor("revocation_feed", res.bytes)],
      artifactDigests: [digestRef(res.bytes)],
    };
  }

  // Latest record for the target wins — `revoked: false` is a reinstatement.
  const targetRecords = feed.records.filter((r) => r.motebit_id === ctx.target);
  const latest = targetRecords.length > 0 ? targetRecords[targetRecords.length - 1] : undefined;
  const hit = latest != null && latest.revoked;
  const generatedAt = feed.generated_at;
  const evidence = [evidenceRefFor("revocation_feed", res.bytes, hit ? ctx.target : undefined)];

  const verdict: VerificationVerdict = {
    type: "revocation",
    integrity: "verified",
    identityBinding: "pinned",
    authority: "unknown",
    revocation: {
      status: hit ? "revoked" : "fresh",
      freshness: {
        basis: "stapled",
        asOf: { ...(generatedAt != null ? { timestamp_ms: generatedAt } : {}) },
      },
    },
    temporalBasis: "local_clock",
    evidenceBasis: evidence,
    ...(hit
      ? {
          repair: repair(
            "revocation.revoked",
            "revocation",
            "the target appears in the operator's signed revocation feed",
            "Treat the agent as de-listed by the operator; consult the record's reason field",
          ),
        }
      : {}),
  };
  return {
    results: [{ check: "revocation", verdict }],
    evidence,
    artifactDigests: [digestRef(res.bytes)],
  };
}

/**
 * receipt_spot_check — `verifyReceiptVerdict` VERBATIM over receipts the
 * delegator supplied in the audit request (there is no public
 * receipts-by-agent endpoint; the ledger route needs a goal id). One
 * EvalResult per sampled receipt; the producer's per-axis output drops in
 * unmodified — including its honest unknown/unchecked axes.
 */
export async function checkReceipts(receipts: unknown[], sampleN: number): Promise<CheckOutput> {
  const sample = receipts.slice(0, sampleN);
  const results: EvalResult[] = [];
  const artifactDigests: DigestRef[] = [];
  for (let i = 0; i < sample.length; i++) {
    const bytes = new TextEncoder().encode(JSON.stringify(sample[i]));
    artifactDigests.push(digestRef(bytes));
    const verdict = await verifyReceiptVerdict(
      sample[i] as Parameters<typeof verifyReceiptVerdict>[0],
    );
    results.push({ check: `receipt_spot_check_${i}`, verdict });
  }
  return { results, evidence: [], artifactDigests };
}

/**
 * bond — the anti-sybil commitment (`GET /api/v1/agents/:id/bond`), verified
 * OFFLINE: `verifyBondCommitment` (address binding + self-signature) plus
 * the sovereign binding of the bonded key to the target id. `authority`
 * carries the validity window under local_clock. Backing (the onchain
 * balance) is deliberately NOT read in v1 — a deferred `bond_backing` check
 * with a ledger_anchored basis; the verdict says so via repair rather than
 * implying it was checked.
 */
export async function checkBond(ctx: CheckContext): Promise<CheckOutput> {
  const res = await ctx.fetchRelay(`/api/v1/agents/${ctx.target}/bond`);
  if (res.status === 404) {
    // No bond claimed — nothing to measure.
    return { results: [], evidence: [], artifactDigests: [] };
  }
  if (res.status !== 200) {
    const verdict: VerificationVerdict = {
      type: "bond_commitment",
      integrity: "invalid",
      identityBinding: "unverified",
      authority: "unknown",
      revocation: { status: "unchecked" },
      temporalBasis: "local_clock",
      evidenceBasis: [],
      repair: repair(
        "evidence.unreachable",
        "integrity",
        `bond read returned ${res.status}`,
        "Retry when the relay's bond endpoint is reachable",
      ),
    };
    return { results: [{ check: "bond", verdict }], evidence: [], artifactDigests: [] };
  }

  const body = JSON.parse(res.text) as Record<string, unknown>;
  const commitment = (body["bond_commitment"] ?? body["commitment"] ?? body) as Parameters<
    typeof verifyBondCommitment
  >[0];
  const evidence = [
    evidenceRefFor(
      "bond_commitment",
      res.bytes,
      typeof commitment.bonded_address === "string" ? commitment.bonded_address : undefined,
    ),
  ];
  const artifactDigests = [digestRef(res.bytes)];

  if (typeof commitment !== "object" || typeof commitment.bonded_public_key !== "string") {
    // Response present but not commitment-shaped — evidence only.
    return { results: [], evidence, artifactDigests };
  }

  const commitmentValid = await verifyBondCommitment(commitment);
  const sovereign = commitmentValid
    ? await verifySovereignBinding(ctx.target, commitment.bonded_public_key)
    : false;

  const now = ctx.now();
  const issuedAt = typeof commitment.issued_at === "number" ? commitment.issued_at : undefined;
  const expiresAt = typeof commitment.expires_at === "number" ? commitment.expires_at : undefined;
  let authority: VerificationVerdict["authority"] = "unknown";
  if (issuedAt != null && expiresAt != null) {
    authority = now < issuedAt ? "not_yet_valid" : now > expiresAt ? "expired" : "valid";
  }

  const verdict: VerificationVerdict = {
    type: "bond_commitment",
    integrity: commitmentValid ? "verified" : "invalid",
    identityBinding: commitmentValid ? (sovereign ? "sovereign" : "unverified") : "invalid",
    authority,
    revocation: { status: "unchecked" },
    temporalBasis: "local_clock",
    evidenceBasis: evidence,
    repair: commitmentValid
      ? repair(
          "bond.backing_unchecked",
          "revocation",
          "the onchain backing balance was not read (deferred bond_backing check)",
          "Read the bonded address's USDC balance via Solana RPC for a ledger_anchored backing basis",
        )
      : repair(
          "bond.commitment_invalid",
          "integrity",
          "the bond commitment failed the address-binding + self-signature law",
          "Re-verify offline via @motebit/verifier verifyBondCommitment; do not treat the bond as a signal",
        ),
  };
  return { results: [{ check: "bond", verdict }], evidence, artifactDigests };
}
