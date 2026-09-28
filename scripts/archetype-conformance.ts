#!/usr/bin/env tsx
/**
 * archetype-conformance — the living conformance probe for the archetype
 * slate (docs/doctrine/agent-archetypes.md §4: the happy path IS the probe;
 * `--self-test` generalized to market scale).
 *
 * Per archetype it checks, in order:
 *   1. PRESENCE — discoverable on the target relay with the expected
 *      capability, a display-name claim, a non-empty description, listed
 *      pricing, and freshness better than cold.
 *   2. DELEGATION (DELEGATE=1) — a REAL paid P2P task (devnet USDC on
 *      staging; free delegation to a priced agent is structurally
 *      impossible — Arc 3.5 requiresP2pProof, and that's correct: no probe
 *      allowlist, the probe pays like any stranger).
 *        - The Researcher: fixed question → signed receipt →
 *          verifyReceiptVerdict fail-closed → every nested atom receipt
 *          verified → the self-attested `sub_settlements` prove the atoms
 *          were PAID P2P (external atom work ⇒ ≥1 p2p hop with an onchain
 *          tx_hash, else FAIL — a molecule may never do atom work for free) →
 *          citation receipt_task_id ⊆ nested task_ids →
 *          EvidenceProvenance STRUCTURAL violations FAIL; byte re-fetch
 *          drift WARNs (live pages move — honest split).
 *        - The Auditor: audits the Researcher (the self-referential
 *          showcase) → receipt verified → embedded EvalAttestation
 *          verified (verifyEvalAttestation) → subject is the Researcher →
 *          issuer key matches the Auditor's registered key.
 *
 * Exit code 0 = all PASS (WARNs allowed); 1 = any FAIL. The scheduled
 * workflow (archetype-conformance.yml) feeds check-promotion-ready: 5
 * consecutive scheduled greens gate staging → prod promotion.
 *
 * Env:
 *   RELAY_URL              target relay (default staging)
 *   AUTH_TOKEN             optional bearer for the (public) discover read only —
 *                          NEVER used on the paid path
 *   DELEGATE               "1" to run the paid delegation legs (default: presence only)
 * Paid-leg env (DELEGATE=1; devnet on staging):
 *   DELEGATOR_SEED_HEX, SOLANA_RPC_URL, SOLANA_USDC_MINT
 *
 * The delegator is a SOVEREIGN motebit derived from DELEGATOR_SEED_HEX alone
 * (scripts/lib/probe-delegator.ts): the seed is its identity key, its Solana
 * wallet, and — via deriveSovereignMotebitId — its motebit_id. It bootstraps
 * itself through the public door and authenticates every relay call with a
 * token signed by that key, so the wallet that pays IS the submitter's
 * identity-derived wallet (#955). `DELEGATOR_MOTEBIT_ID` is no longer read;
 * a value that disagrees with the seed is reported as a WARN.
 */

import {
  verifyReceiptVerdict,
  verifyEvalAttestation,
  verifyEvidenceProvenance,
  verifyRoutingTranscript,
} from "@motebit/verifier";
import type { SolanaWalletRail } from "@motebit/wallet-solana";
import { recomputeRoutingDecision } from "@motebit/semiring";
import type { EvalAttestation } from "@motebit/protocol";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapProbeDelegator,
  declaredIdMismatch,
  deriveProbeDelegator,
  probeTokenMinter,
  type ProbeDelegator,
} from "./lib/probe-delegator.js";

interface Expectation {
  service: string;
  capability: string;
  displayName: string;
  kind: "atom" | "molecule";
}

// Parsed by check-archetype-slate — must stay in parity with the deploy
// script's SLATE and the docs gallery table.
export const ARCHETYPES: Expectation[] = [
  { service: "web-search", capability: "web_search", displayName: "", kind: "atom" },
  { service: "read-url", capability: "read_url", displayName: "", kind: "atom" },
  { service: "summarize", capability: "summarize_search", displayName: "", kind: "atom" },
  { service: "research", capability: "research", displayName: "The Researcher", kind: "molecule" },
  { service: "auditor", capability: "audit_agent", displayName: "The Auditor", kind: "molecule" },
  {
    service: "clerk",
    capability: "execute_delegation",
    displayName: "The Clerk",
    kind: "molecule",
  },
];

const RELAY_URL = (process.env["RELAY_URL"] ?? "https://motebit-sync-stg.fly.dev").replace(
  /\/$/,
  "",
);
const AUTH_TOKEN = process.env["AUTH_TOKEN"] ?? "";
const DELEGATE = process.env["DELEGATE"] === "1";

type Grade = "PASS" | "WARN" | "FAIL";
const ledger: Array<{ check: string; grade: Grade; detail: string }> = [];
function record(check: string, grade: Grade, detail = ""): void {
  ledger.push({ check, grade, detail });
  const mark = grade === "PASS" ? "✓" : grade === "WARN" ? "⚠" : "✗";
  console.log(`${mark} ${check}${detail ? ` — ${detail}` : ""}`);
}

interface DiscoveredWireAgent {
  motebit_id: string;
  public_key: string;
  endpoint_url: string;
  capabilities: string[];
  display_name?: string | null;
  description?: string | null;
  pricing?: Array<{ capability: string; unit_cost: number; per: string }> | null;
  freshness?: string;
  settlement_address?: string | null;
  settlement_modes?: string | null;
}

async function discover(): Promise<DiscoveredWireAgent[]> {
  const res = await fetch(`${RELAY_URL}/api/v1/agents/discover`, {
    headers: AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {},
  });
  if (!res.ok) throw new Error(`discover returned ${res.status}`);
  const data = (await res.json()) as { agents?: DiscoveredWireAgent[] };
  return data.agents ?? [];
}

function checkPresence(agents: DiscoveredWireAgent[]): Map<string, DiscoveredWireAgent> {
  const bySlate = new Map<string, DiscoveredWireAgent>();
  for (const exp of ARCHETYPES) {
    const agent = agents.find((a) => a.capabilities.includes(exp.capability));
    if (!agent) {
      record(`${exp.service}: discoverable`, "FAIL", `no agent advertises ${exp.capability}`);
      continue;
    }
    bySlate.set(exp.service, agent);
    record(`${exp.service}: discoverable`, "PASS", agent.motebit_id.slice(0, 13));

    if (exp.displayName !== "") {
      const claimed = agent.display_name ?? "";
      record(
        `${exp.service}: display-name claim`,
        claimed === exp.displayName ? "PASS" : "FAIL",
        `claims "${claimed}"`,
      );
    }
    record(
      `${exp.service}: description`,
      (agent.description ?? "").trim().length > 0 ? "PASS" : "FAIL",
    );
    const priced = Array.isArray(agent.pricing) && agent.pricing.length > 0;
    record(`${exp.service}: pricing listed`, priced ? "PASS" : "FAIL");
    record(
      `${exp.service}: freshness`,
      agent.freshness === "cold" ? "FAIL" : agent.freshness === "dormant" ? "WARN" : "PASS",
      agent.freshness ?? "unknown",
    );
    if (exp.kind === "molecule") {
      record(
        `${exp.service}: p2p-payable`,
        agent.settlement_address != null && (agent.settlement_modes ?? "").includes("p2p")
          ? "PASS"
          : "FAIL",
        p2pPayableDetail(agent),
      );
    }
  }
  return bySlate;
}

/**
 * The p2p-payable detail, with a repair pointer when an agent that HAS a
 * settlement address has lost `p2p` from its modes. Every slate molecule
 * registers `relay,p2p` (deploy-archetype-slate.ts) and re-registers hourly,
 * so a molecule reading `relay` with an address was stripped by the relay: the
 * p2p-verifier's `downgradeP2pTrust` removes `p2p` from the DELEGATOR of a P2P
 * payment that failed onchain verification — for the Researcher, one of its
 * own paid atom hops. Staging's verifier only runs when SOLANA_RPC_URL is set.
 * (Witnessed 2026-09-28: the relay's parent-P2P audit row records the
 * SUBMITTER as payee, so the Researcher's atom hops "fail" the worker-leg
 * check against the Researcher's own address — a relay defect, reported
 * separately; this detail only points the operator at the evidence.)
 */
export function p2pPayableDetail(agent: {
  settlement_address?: string | null;
  settlement_modes?: string | null;
}): string {
  const modes = `modes=${agent.settlement_modes ?? "none"}`;
  if (agent.settlement_address == null) return `${modes}; no settlement_address registered`;
  if ((agent.settlement_modes ?? "").includes("p2p")) return modes;
  return (
    `${modes} (address set, p2p missing) — the relay's p2p-verifier strips p2p from a ` +
    `delegator whose P2P payment failed verification (services/relay/src/p2p-verifier.ts ` +
    `downgradeP2pTrust); read the relay log for p2p_verifier.failed / legs_mismatch naming ` +
    `this agent's settlements. The worker restores p2p on its next hourly re-registration.`
  );
}

/**
 * The probe's sovereign delegator for one relay, derived from the seed and
 * introduced to that relay once per run (memoized per relay + seed, so the
 * three paid legs share one bootstrap and a test's fresh relay gets its own).
 */
const delegators = new Map<string, Promise<ProbeDelegator>>();
export function bootstrappedDelegator(relayUrl: string, seedHex: string): Promise<ProbeDelegator> {
  const key = `${relayUrl}\u0000${seedHex}`;
  let pending = delegators.get(key);
  if (pending == null) {
    pending = (async () => {
      const d = await deriveProbeDelegator(seedHex);
      await bootstrapProbeDelegator(relayUrl, d);
      return d;
    })();
    // A failed bootstrap is not cached — the next leg retries it.
    pending.catch(() => delegators.delete(key));
    delegators.set(key, pending);
  }
  return pending;
}

function seedFromEnv(): string {
  const seedHex = process.env["DELEGATOR_SEED_HEX"];
  if (!seedHex) throw new Error("DELEGATE=1 requires DELEGATOR_SEED_HEX");
  return seedHex;
}

/**
 * The probe's own Solana rail (devnet). Built from the seed in
 * DELEGATOR_SEED_HEX; its `address` is the wallet an operator funds.
 */
async function delegatorRail(): Promise<SolanaWalletRail> {
  const { Buffer } = await import("node:buffer");
  const { createSolanaWalletRail } = await import("@motebit/wallet-solana");
  const required = ["DELEGATOR_SEED_HEX", "SOLANA_RPC_URL"] as const;
  for (const k of required) {
    if (!process.env[k]) throw new Error(`DELEGATE=1 requires ${k}`);
  }
  const seedHex = process.env["DELEGATOR_SEED_HEX"]!.replace(/^0x/, "");
  const usdcMint = process.env["SOLANA_USDC_MINT"]?.trim() || undefined;
  return createSolanaWalletRail({
    rpcUrl: process.env["SOLANA_RPC_URL"]!,
    identitySeed: Buffer.from(seedHex, "hex"),
    ...(usdcMint ? { usdcMint } : {}),
  });
}

/** Where to top the probe up — a public address; the seed never prints. */
const FUNDING_HINT = (address: string): string =>
  `delegator wallet ${address} — devnet USDC (mint ${process.env["SOLANA_USDC_MINT"] ?? "default"}); ` +
  `top up at https://faucet.circle.com (Solana Devnet)`;

/** The rail surface a paid leg needs — structurally `SolanaWalletRail`. */
export type PaidLegRail = Pick<SolanaWalletRail, "address" | "buildP2pPayment"> &
  Partial<Pick<SolanaWalletRail, "confirmP2pPayment">>;

export interface PaidLegInput {
  relayUrl: string;
  /** DELEGATOR_SEED_HEX — the one secret: identity key, wallet, and id. */
  seedHex: string;
  rail: PaidLegRail;
  /** The relay key pinned from /.well-known — the fee leg's trust root. */
  relayPublicKeyHex: string;
  workerId: string;
  capability: string;
  prompt: string;
  timeoutMs: number;
  logger: { warn(message: string, context?: Record<string, unknown>): void };
}

type DelegationOutcome = Awaited<
  ReturnType<(typeof import("@motebit/runtime"))["resolveAndSubmitP2pDelegation"]>
>;

/**
 * One paid P2P hire through the REAL delegator client
 * (`resolveAndSubmitP2pDelegation`, the call the CLI's sovereign path makes),
 * made the way a conforming sovereign client makes it:
 *
 *   - the submitter is the seed's own sovereign identity, bootstrapped
 *     through the public door;
 *   - every bearer is minted per audience and SIGNED by that identity key —
 *     never the operator's master token, which names an identity without
 *     proving it (the relay can then only look the payer up among that
 *     identity's keys, and a wallet key it never held is refused:
 *     TASK_P2P_PROOF_NOT_PAYER, #955);
 *   - the paying wallet is asserted to be that identity's derived wallet
 *     BEFORE anything is broadcast.
 *
 * The probe is still a stranger with no history — no allowlist and no
 * operator credential (protocol-primacy): it pays and acknowledges like one.
 */
export async function submitPaidDelegation(input: PaidLegInput): Promise<DelegationOutcome> {
  const { resolveAndSubmitP2pDelegation, p2pPaymentConfirmerOf } = await import("@motebit/runtime");
  const { deriveSolanaAddress } = await import("@motebit/wallet-solana");
  const delegator = await bootstrappedDelegator(input.relayUrl, input.seedHex);

  // The same seed, so the same key: the wallet that pays IS the identity that
  // submits. Asserted, not assumed — a rail on a different key would spend
  // money on a proof the relay must refuse.
  const identityWallet = deriveSolanaAddress(delegator.publicKey);
  if (identityWallet !== input.rail.address) {
    throw new Error(
      `delegator wallet ${input.rail.address} is not ${delegator.motebitId}'s identity-derived ` +
        `wallet ${identityWallet} — refusing to pay: the relay would refuse the proof ` +
        `(TASK_P2P_PROOF_NOT_PAYER)`,
    );
  }

  const confirm = p2pPaymentConfirmerOf(input.rail);
  return resolveAndSubmitP2pDelegation({
    motebitId: delegator.motebitId,
    syncUrl: input.relayUrl,
    authToken: probeTokenMinter(delegator),
    prompt: input.prompt,
    capability: input.capability,
    targetWorkerId: input.workerId,
    relayPublicKeyHex: input.relayPublicKeyHex,
    buildP2pPayment: (req, hooks) => input.rail.buildP2pPayment(req, hooks),
    // #885: a builder that throws is not proof nothing moved — the rail's
    // read-only lookup decides, and "unknown" never pays again (as the CLI).
    ...(confirm != null ? { confirmP2pPayment: confirm } : {}),
    acknowledgeNoHistoryRisk: true,
    timeoutMs: input.timeoutMs,
    logger: input.logger,
  });
}

async function delegatePaid(
  workerId: string,
  capability: string,
  prompt: string,
): Promise<Record<string, unknown>> {
  const rail = await delegatorRail();

  // Fee-leg trust root: pin the relay key from /.well-known (TOFU) — the
  // treasury derives from THIS, matching the staging-proof harness.
  const wk = (await (await fetch(`${RELAY_URL}/.well-known/motebit.json`)).json()) as {
    public_key?: string;
  };
  if (!wk.public_key) throw new Error("relay /.well-known/motebit.json has no public_key");

  const result = await submitPaidDelegation({
    relayUrl: RELAY_URL,
    seedHex: seedFromEnv(),
    rail,
    relayPublicKeyHex: wk.public_key,
    workerId,
    capability,
    prompt,
    timeoutMs: Number(process.env["TIMEOUT_MS"] ?? "180000"),
    logger: { warn: (m, ctx) => console.warn(`[conformance] warn: ${m}`, ctx ?? "") },
  });
  if (!result.ok) {
    // A funding failure names the wallet to fund: four consecutive daily reds
    // (2026-09-10 → 09-13) said "insufficient_balance" and nothing else — an
    // operator could not act on it without the seed. The address is public.
    const hint =
      result.error.code === "insufficient_balance" ? ` — ${FUNDING_HINT(rail.address)}` : "";
    throw new Error(`${result.error.code}: ${result.error.message}${hint}`);
  }
  return result.receipt as unknown as Record<string, unknown>;
}

async function verifyReceiptTree(label: string, receipt: Record<string, unknown>): Promise<void> {
  const verdict = await verifyReceiptVerdict(receipt as Parameters<typeof verifyReceiptVerdict>[0]);
  record(
    `${label}: receipt integrity`,
    verdict.integrity === "verified" ? "PASS" : "FAIL",
    `binding=${verdict.identityBinding}`,
  );
  const nested = (receipt["delegation_receipts"] ?? []) as Array<Record<string, unknown>>;
  let nestedOk = 0;
  for (const sub of nested) {
    const v = await verifyReceiptVerdict(sub as Parameters<typeof verifyReceiptVerdict>[0]);
    if (v.integrity === "verified") nestedOk++;
  }
  record(
    `${label}: nested receipts`,
    nestedOk === nested.length ? "PASS" : "FAIL",
    `${nestedOk}/${nested.length} verified`,
  );
}

/**
 * The purchased payload, or a legible refusal — read the receipt's own
 * verdict BEFORE parsing its body.
 *
 * A worker that cannot do the work signs an HONEST `failed` receipt whose
 * `result` is the error TEXT, not JSON (see the catch in
 * `services/research/src/index.ts`). Parsing that text as JSON turns one
 * operator-actionable sentence into a JSON syntax error — repeated once per
 * dependent check. That is exactly what hid a six-night staging outage
 * (2026-08-27 → 2026-09-01): the Researcher's Anthropic key was out of
 * credits and said so in plain English inside every receipt, while this probe
 * reported three copies of "Unexpected non-whitespace character after JSON at
 * position 4" and nothing else. Six red nights, cause unreadable.
 *
 * gate-repair-instructions.md: a red must be self-serviceable from its text
 * alone. So a failed receipt is ONE failure carrying the worker's own words,
 * and the payload-dependent checks are not-applicable rather than
 * separately-failed — one root cause reports as one line, not as N.
 */
export function purchasedPayload(
  label: string,
  receipt: Record<string, unknown>,
): Record<string, unknown> | null {
  const status = String(receipt["status"] ?? "");
  const body = String(receipt["result"] ?? "");
  if (status === "failed" || receipt["ok"] === false) {
    record(
      `${label}: worker completed the work`,
      "FAIL",
      `worker signed a FAILED receipt — its own words: ${body.slice(0, 400) || "(empty result)"}`,
    );
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(body === "" ? "{}" : body);
    if (typeof parsed !== "object" || parsed === null) {
      record(
        `${label}: result payload`,
        "FAIL",
        `result is not a JSON object (got ${typeof parsed}) — the worker's payload contract is one JSON object; raw: ${body.slice(0, 200)}`,
      );
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    record(
      `${label}: result payload`,
      "FAIL",
      `receipt status=${status || "(absent)"} but result is not JSON (${err instanceof Error ? err.message : String(err)}) — raw: ${body.slice(0, 200)}`,
    );
    return null;
  }
}

async function checkResearcher(
  agent: DiscoveredWireAgent,
): Promise<Record<string, unknown> | null> {
  const question =
    "What is the current stable version of the RFC 8785 JSON Canonicalization Scheme and who published it?";
  let receipt: Record<string, unknown>;
  try {
    receipt = await delegatePaid(agent.motebit_id, "research", question);
  } catch (err) {
    record("research: paid delegation", "FAIL", err instanceof Error ? err.message : String(err));
    return null;
  }
  record("research: paid delegation", "PASS");
  await verifyReceiptTree("research", receipt);

  // Read the verdict before the body: an honest `failed` receipt is a legible
  // refusal, never a parse error. Integrity above still ran — a refusal is
  // still a signed artifact, and it must still verify.
  const purchased = purchasedPayload("research", receipt);
  if (purchased == null) return receipt;

  // The multi-hop-as-P2P invariant: a molecule that did external atom work MUST
  // have PAID for it P2P — never silently for free. Read the self-attested money
  // facts (`sub_settlements`, stamped by the molecule with mode + onchain tx) and
  // the work counters from the SAME signed payload. The gate:
  //   external atom work happened  ⇒  ≥1 p2p sub-hop with an onchain tx_hash.
  // Gating on work-done (not "always ≥1") keeps it non-flaky: a pure-interior
  // recall answer legitimately settles nothing. This closes the exact regression
  // #333 fixed — research dropping to free direct-MCP would keep the receipt tree
  // verifying while paying no one; here that is a hard FAIL.
  try {
    const settlePayload = purchased as {
      sub_settlements?: Array<{ mode?: string; tx_hash?: string; capability?: string }>;
      search_count?: number;
      fetch_count?: number;
    };
    const externalWork = (settlePayload.search_count ?? 0) + (settlePayload.fetch_count ?? 0);
    const p2pHops = (settlePayload.sub_settlements ?? []).filter(
      (s) => s.mode === "p2p" && typeof s.tx_hash === "string" && s.tx_hash.length > 0,
    );
    record(
      "research: atoms paid P2P (multi-hop settles)",
      p2pHops.length > 0 ? "PASS" : externalWork > 0 ? "FAIL" : "WARN",
      `${p2pHops.length} p2p sub-hop(s) [${p2pHops.map((s) => s.capability ?? "?").join(",")}], external work=${externalWork}`,
    );
  } catch (err) {
    record(
      "research: atoms paid P2P (multi-hop settles)",
      "FAIL",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Routing-decision transcripts (docs/doctrine/routing-decision-transcript.md
  // Inc 4 — the arc's accept-on-proof close): when the molecule self-attested
  // transcripts of its ranked paid hires, each MUST verify on BOTH rungs —
  // integrity (the delegator committed to this decision record) and
  // faithfulness (the recorded winner recomputes from the frozen inputs).
  // "The newcomer won on merit" as a checkable sentence, not the operator's
  // word. Presence is verify-if-present: a pinned or sole-candidate hop
  // legitimately ranks nothing (the selector is consulted only when >1
  // admissible candidate survives), so absence alone is a WARN-with-count,
  // never a FAIL — the emission drift gate holds the producer structurally.
  try {
    const tPayload = purchased as {
      routing_transcripts?: Array<Record<string, unknown>>;
      sub_settlements?: Array<{ mode?: string }>;
    };
    const transcripts = tPayload.routing_transcripts ?? [];
    let bothRungs = 0;
    const failures: string[] = [];
    for (const t of transcripts) {
      const integrity = await verifyRoutingTranscript(t as never);
      if (!integrity.valid) {
        failures.push(`integrity:${integrity.reason ?? "?"}`);
        continue;
      }
      const faith = recomputeRoutingDecision(t as never);
      if (!faith.consistent) {
        failures.push(`faithfulness:${faith.reason ?? "?"}`);
        continue;
      }
      bothRungs++;
    }
    record(
      "research: routing transcripts verify (both rungs)",
      failures.length > 0 ? "FAIL" : transcripts.length > 0 ? "PASS" : "WARN",
      transcripts.length > 0
        ? `${bothRungs}/${transcripts.length} transcript(s) verified${failures.length > 0 ? ` [${failures.join(",")}]` : ""}`
        : "no transcripts (pinned/sole-candidate hops rank nothing)",
    );
  } catch (err) {
    record(
      "research: routing transcripts verify (both rungs)",
      "FAIL",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Citation chain: parse the result payload, cross-check receipt_task_id
  // and run the structural provenance discipline.
  try {
    const payload = purchased as {
      report?: string;
      citations?: Array<{
        receipt_task_id?: string;
        excerpt?: string;
        provenance?: { digest?: { algorithm?: string; value?: string }; span?: string };
      }>;
    };
    // #479: a completed receipt over an empty report body is worse than an
    // honest failure — the purchased artifact is the report; citations alone
    // are scaffolding. Non-empty body is a Researcher conformance criterion.
    const reportChars = (payload.report ?? "").trim().length;
    record(
      "research: report body non-empty",
      reportChars > 0 ? "PASS" : "FAIL",
      `${reportChars} chars`,
    );
    const nested = (receipt["delegation_receipts"] ?? []) as Array<{ task_id?: string }>;
    const nestedIds = new Set(nested.map((r) => r.task_id).filter(Boolean));
    const citations = payload.citations ?? [];
    // #504 — the quality half of #479: a non-empty body can still be a
    // notes-dump ("mid-work notes plus source snippets", witnessed live
    // 2026-07-30 on a paid hire). Grade the report against the SAME v1
    // shape contract the producer retries against — deterministic shape,
    // never an LLM judge; quality beyond shape stays the archetype's
    // earned record, not a relay gate.
    // Imported by RELATIVE PATH, not as `@motebit/research/report-shape`, and
    // the distinction is load-bearing rather than stylistic. A `workspace:*`
    // entry in the ROOT package.json must resolve inside the relay's Docker
    // build, which copies only `packages/` and `services/relay/` — so a root
    // dependency on any other `services/*` package makes `pnpm deploy --prod`
    // fail with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND and takes the relay's entire
    // deploy + image-publish pipeline down. That is not hypothetical: it
    // stranded production relay for four days (2026-07-31 → 08-04). This is a
    // repo script, never a published consumer, so the relative import (the
    // same shape `build-self-knowledge.ts` and `gen-verdict-corpus.ts` use)
    // gets the same code with no workspace edge. See check-root-workspace-deps.
    const { reportShapeIssues } = await import("../services/research/src/report-shape.js");
    const shapeIssues = reportShapeIssues(payload.report ?? "", {
      sourcesRead: citations.length > 0,
    });
    record(
      "research: report shape (synthesis, not notes)",
      shapeIssues.length === 0 ? "PASS" : "FAIL",
      shapeIssues.length === 0
        ? "Findings + Sources present, floor cleared"
        : shapeIssues.map((i) => `${i.code}: ${i.detail}`).join("; "),
    );
    const orphan = citations.filter(
      (c) => c.receipt_task_id != null && !nestedIds.has(c.receipt_task_id),
    );
    record(
      "research: citation ⊆ receipt chain",
      orphan.length === 0 ? "PASS" : "FAIL",
      `${citations.length} citation(s), ${orphan.length} orphaned`,
    );
    // Structural provenance: digest shape + span presence are the issuer's
    // own discipline — violations FAIL. Byte-level re-verification of live
    // pages is drift-prone — WARN only.
    const withProv = citations.filter((c) => c.provenance != null);
    const malformed = withProv.filter(
      (c) =>
        c.provenance?.digest?.algorithm !== "sha-256" ||
        !/^[0-9a-f]{64}$/.test(c.provenance?.digest?.value ?? "") ||
        (c.provenance?.span ?? "").length === 0,
    );
    record(
      "research: provenance structural",
      malformed.length === 0 ? "PASS" : "FAIL",
      `${withProv.length} provenanced, ${malformed.length} malformed`,
    );
  } catch (err) {
    record("research: result payload", "FAIL", err instanceof Error ? err.message : String(err));
  }
  return receipt;
}

async function checkAuditor(
  agent: DiscoveredWireAgent,
  researcher: DiscoveredWireAgent | undefined,
  researchReceipt: Record<string, unknown> | null,
): Promise<void> {
  if (!researcher) {
    record("auditor: paid delegation", "FAIL", "no Researcher to audit");
    return;
  }
  const request = JSON.stringify({
    target: researcher.motebit_id,
    ...(researchReceipt != null ? { receipts: [researchReceipt] } : {}),
  });
  let receipt: Record<string, unknown>;
  try {
    receipt = await delegatePaid(agent.motebit_id, "audit_agent", request);
  } catch (err) {
    record("auditor: paid delegation", "FAIL", err instanceof Error ? err.message : String(err));
    return;
  }
  record("auditor: paid delegation", "PASS");
  await verifyReceiptTree("auditor", receipt);

  const purchased = purchasedPayload("auditor", receipt);
  if (purchased == null) return;

  try {
    const payload = purchased as {
      attestation?: EvalAttestation;
    };
    if (payload.attestation == null) {
      record("auditor: attestation present", "FAIL", "result payload carries no attestation");
      return;
    }
    const verdict = await verifyEvalAttestation(payload.attestation);
    record(
      "auditor: attestation verifies",
      verdict.valid ? "PASS" : "FAIL",
      verdict.valid ? "" : (verdict as { reason?: string }).reason,
    );
    record(
      "auditor: subject is the Researcher",
      payload.attestation.subject.motebit_id === researcher.motebit_id ? "PASS" : "FAIL",
    );
    record(
      "auditor: issuer key matches registration",
      payload.attestation.issuer.public_key.toLowerCase() === agent.public_key.toLowerCase()
        ? "PASS"
        : "FAIL",
    );
    // Re-check one raw-byte provenance span offline when present — the
    // artifact's own re-verifiability claim (evidence-provenance law).
    const provRef = (payload.attestation.evidence ?? []).find((e) => e.provenance != null);
    if (provRef?.provenance != null) {
      // Structural only here — the bytes live behind the relay's endpoints
      // and re-fetch drift is a WARN class, matching the research split.
      const ok =
        /^[0-9a-f]{64}$/.test(provRef.provenance.digest.value) &&
        provRef.provenance.span.length > 0;
      record("auditor: evidence provenance structural", ok ? "PASS" : "FAIL");
      void verifyEvidenceProvenance; // law re-exported for offline consumers; byte re-check is theirs
    }
  } catch (err) {
    record("auditor: result payload", "FAIL", err instanceof Error ? err.message : String(err));
  }
}

async function checkClerk(
  agent: DiscoveredWireAgent,
  researcher: DiscoveredWireAgent | undefined,
): Promise<void> {
  if (!researcher) {
    record("clerk: paid delegation", "FAIL", "no Researcher for the Clerk to sub-delegate to");
    return;
  }
  // The delegator pays the CLERK for an execute_delegation task; the Clerk then
  // runs its OWN metered sub-delegation to the Researcher under its self-grant.
  // On staging the Clerk runs DRY_RUN=1, so that inner spend is metered but not
  // broadcast — the outer receipt is real, the inner settlement is dry.
  const request = JSON.stringify({
    capability: "research",
    prompt: "What is the RFC 8785 JSON Canonicalization Scheme?",
  });
  let receipt: Record<string, unknown>;
  try {
    receipt = await delegatePaid(agent.motebit_id, "execute_delegation", request);
  } catch (err) {
    record("clerk: paid delegation", "FAIL", err instanceof Error ? err.message : String(err));
    return;
  }
  record("clerk: paid delegation", "PASS");
  await verifyReceiptTree("clerk", receipt);

  const purchased = purchasedPayload("clerk", receipt);
  if (purchased == null) return;

  try {
    const status = String(receipt["status"] ?? "");
    const payload = purchased as {
      ok?: boolean;
      dry_run?: boolean;
      code?: string;
      settlement?: { mode?: string } | null;
    };
    // A completed grant-authorized spend: ok:true with settlement facts. On the
    // dry-run staging slate it is a metered-not-broadcast settlement; live it
    // nests the worker's receipt (delegation_receipts).
    if (payload.ok === true) {
      record(
        "clerk: granted spend authorized",
        "PASS",
        payload.dry_run ? "dry-run (metered, not broadcast)" : "live settlement",
      );
      record(
        "clerk: settlement present",
        payload.settlement?.mode != null ||
          (receipt["delegation_receipts"] as unknown[] | undefined)?.length
          ? "PASS"
          : "WARN",
        "no settlement facts on the outcome",
      );
    } else {
      // A refusal is a VALID conformance outcome (fail-closed) — it must be a
      // signed ok:false receipt carrying only a denial CODE, never an overage.
      record(
        "clerk: refusal is a signed denial code",
        status === "failed" &&
          typeof payload.code === "string" &&
          !JSON.stringify(payload).includes("micro")
          ? "PASS"
          : "FAIL",
        `code=${payload.code ?? "?"}`,
      );
    }
  } catch (err) {
    record("clerk: result payload", "FAIL", err instanceof Error ? err.message : String(err));
  }
}

async function main(): Promise<void> {
  console.log(
    `archetype-conformance — relay=${RELAY_URL} delegate=${DELEGATE ? "PAID" : "presence-only"}\n`,
  );

  const agents = await discover();
  const bySlate = checkPresence(agents);

  if (DELEGATE) {
    // Say which wallet pays BEFORE anything is attempted, so a funding gap is
    // diagnosable from the run header alone.
    try {
      const d = await bootstrappedDelegator(RELAY_URL, seedFromEnv());
      console.log(`[conformance] delegator ${d.motebitId} (sovereign, derived from the seed)`);
      const mismatch = declaredIdMismatch(process.env["DELEGATOR_MOTEBIT_ID"], d);
      if (mismatch != null) record("delegator: declared id", "WARN", mismatch);
      console.log(`[conformance] ${FUNDING_HINT((await delegatorRail()).address)}\n`);
    } catch (err) {
      console.log(
        `[conformance] delegator unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const researcher = bySlate.get("research");
    const auditor = bySlate.get("auditor");
    const clerk = bySlate.get("clerk");
    let researchReceipt: Record<string, unknown> | null = null;
    if (researcher) researchReceipt = await checkResearcher(researcher);
    if (auditor) await checkAuditor(auditor, researcher, researchReceipt);
    if (clerk) await checkClerk(clerk, researcher);
  }

  const fails = ledger.filter((l) => l.grade === "FAIL");
  const warns = ledger.filter((l) => l.grade === "WARN");
  console.log(
    `\n${ledger.length} checks: ${ledger.length - fails.length - warns.length} pass, ${warns.length} warn, ${fails.length} fail`,
  );
  if (fails.length > 0) process.exit(1);
}

// Entrypoint guard: running the probe is a side effect (network, process.exit),
// so it must fire only when this file IS the program. Importing it — which the
// regression test around `purchasedPayload` does — must stay inert.
const invokedDirectly =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
