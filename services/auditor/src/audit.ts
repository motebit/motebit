/**
 * The audit engine — pure orchestration over injected dependencies. Runs
 * the trust bootstrap (verify the relay's transparency declaration, pin its
 * key), executes the requested checks from the catalog, and assembles the
 * UNSIGNED EvalAttestation body. Signing stays in index.ts, which owns the
 * molecule's identity key.
 *
 * Refusal semantics (the deny-band pattern): a malformed request, an
 * unknown check name, a transparency-pin mismatch, or a nonexistent target
 * throws `AuditRefusal` — the caller returns an ok:false receipt and NO
 * attestation. You cannot measure a subject you cannot see; a refusal is
 * itself signed (the receipt), but no measurement is minted.
 */

import type { EvalAttestation, EvalResult, EvidenceRef, DigestRef } from "@motebit/sdk";
import { verifyTransparencyDeclaration } from "@motebit/state-export-client";
import {
  checkIdentityBinding,
  checkSuccession,
  checkRevocation,
  checkReceipts,
  checkBond,
  type CheckContext,
  type CheckOutput,
} from "./checks.js";
import { isWellFormedMotebitId, type RelayFetcher } from "./evidence.js";

export const DEFAULT_CHECKS = ["identity_binding", "succession", "revocation", "bond"] as const;

export interface AuditRequest {
  /** The measured party's motebit_id. */
  target: string;
  /** Check names to run; defaults to DEFAULT_CHECKS. Unknown names refuse. */
  checks?: string[];
  /** Receipts of the target supplied by the delegator for spot-checking. */
  receipts?: unknown[];
}

export interface AuditDeps {
  fetchRelay: RelayFetcher;
  /** Optional env pin for the relay transparency key; mismatch refuses. */
  pinnedRelayKey?: string;
  now: () => number;
  receiptSampleN: number;
  issuer: { motebitId: string; publicKeyHex: string };
  invocation?: { task_id?: string; relay_task_id?: string };
}

export class AuditRefusal extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuditRefusal";
  }
}

/** Parse the task prompt: bare motebit_id, or a JSON AuditRequest. */
export function parseAuditPrompt(prompt: string): AuditRequest {
  const trimmed = prompt.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new AuditRefusal("request.malformed", "prompt is not valid JSON");
    }
    const req = parsed as Partial<AuditRequest>;
    if (typeof req.target !== "string" || req.target.length === 0) {
      throw new AuditRefusal(
        "request.missing_target",
        'JSON prompt requires a "target" motebit_id',
      );
    }
    return {
      target: req.target,
      ...(Array.isArray(req.checks) ? { checks: req.checks.map(String) } : {}),
      ...(Array.isArray(req.receipts) ? { receipts: req.receipts } : {}),
    };
  }
  if (trimmed.length === 0) {
    throw new AuditRefusal("request.missing_target", "empty prompt — supply a target motebit_id");
  }
  return { target: trimmed };
}

export interface AuditOutcome {
  body: Omit<EvalAttestation, "signature" | "suite">;
  summary: string;
}

export async function runAudit(req: AuditRequest, deps: AuditDeps): Promise<AuditOutcome> {
  if (!isWellFormedMotebitId(req.target)) {
    throw new AuditRefusal(
      "request.malformed_target",
      `target is not a well-formed motebit_id: ${req.target.slice(0, 64)}`,
    );
  }

  const requested = req.checks ?? [
    ...DEFAULT_CHECKS,
    ...(req.receipts ? ["receipt_spot_check"] : []),
  ];
  const known = new Set([...DEFAULT_CHECKS, "receipt_spot_check"]);
  const unknown = requested.filter((c) => !known.has(c));
  if (unknown.length > 0) {
    throw new AuditRefusal(
      "request.unknown_check",
      `unknown check(s): ${unknown.join(", ")} — known: ${[...known].join(", ")}`,
    );
  }

  // === Trust bootstrap — verify the transparency declaration, pin the key.
  const tRes = await deps.fetchRelay("/.well-known/motebit-transparency.json");
  if (tRes.status !== 200) {
    throw new AuditRefusal(
      "bootstrap.transparency_unreachable",
      `transparency declaration returned ${tRes.status} — no trust anchor, no audit`,
    );
  }
  let declaration: unknown;
  try {
    declaration = JSON.parse(tRes.text);
  } catch {
    throw new AuditRefusal(
      "bootstrap.transparency_malformed",
      "transparency declaration is not JSON",
    );
  }
  const anchorResult = await verifyTransparencyDeclaration(
    declaration as Parameters<typeof verifyTransparencyDeclaration>[0],
  );
  if (!anchorResult.ok) {
    throw new AuditRefusal(
      "bootstrap.transparency_invalid",
      `transparency declaration failed verification: ${anchorResult.reason}`,
    );
  }
  const relayPublicKey = anchorResult.anchor.relayPublicKeyHex;
  if (typeof relayPublicKey !== "string" || relayPublicKey.length === 0) {
    throw new AuditRefusal(
      "bootstrap.transparency_invalid",
      "verified declaration carries no relay key",
    );
  }
  if (
    deps.pinnedRelayKey != null &&
    deps.pinnedRelayKey.toLowerCase() !== relayPublicKey.toLowerCase()
  ) {
    throw new AuditRefusal(
      "bootstrap.pin_mismatch",
      "the relay's transparency key does not match the configured pin — refusing to audit against an unexpected trust root",
    );
  }

  // === Target existence — you cannot measure a nonexistent subject.
  const dRes = await deps.fetchRelay(`/api/v1/discover/${req.target}`);
  if (dRes.status === 404) {
    throw new AuditRefusal("request.target_not_found", `no agent registered as ${req.target}`);
  }

  // === Run the catalog.
  const ctx: CheckContext = {
    target: req.target,
    fetchRelay: deps.fetchRelay,
    relayPublicKey,
    now: deps.now,
  };

  const results: EvalResult[] = [];
  const evidence: EvidenceRef[] = [];
  const artifactDigests: DigestRef[] = [];
  const absorb = (out: CheckOutput): void => {
    results.push(...out.results);
    evidence.push(...out.evidence);
    artifactDigests.push(...out.artifactDigests);
  };

  for (const check of requested) {
    if (check === "identity_binding") absorb(await checkIdentityBinding(ctx));
    else if (check === "succession") absorb(await checkSuccession(ctx));
    else if (check === "revocation") absorb(await checkRevocation(ctx));
    else if (check === "bond") absorb(await checkBond(ctx));
    else if (check === "receipt_spot_check")
      absorb(await checkReceipts(req.receipts ?? [], deps.receiptSampleN));
  }

  if (results.length === 0) {
    throw new AuditRefusal(
      "audit.nothing_measured",
      "no check produced a measurement (unclaimed properties only) — an attestation that measured nothing is not an attestation",
    );
  }

  const passing = results.filter(
    (r) => r.verdict.integrity === "verified" && r.verdict.repair == null,
  ).length;
  const summary = `audit of ${req.target}: ${results.length} measurement(s), ${passing} clean; checks: ${requested.join(", ")}`;

  const body: Omit<EvalAttestation, "signature" | "suite"> = {
    attestation_id: crypto.randomUUID(),
    eval_kind: "verification_audit",
    subject: {
      motebit_id: req.target,
      ...(artifactDigests.length > 0 ? { artifact_digests: artifactDigests } : {}),
    },
    issuer: { motebit_id: deps.issuer.motebitId, public_key: deps.issuer.publicKeyHex },
    issued_at: deps.now(),
    as_of: { timestamp_ms: deps.now() },
    results,
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(deps.invocation ? { invocation: deps.invocation } : {}),
  };

  return { body, summary };
}
