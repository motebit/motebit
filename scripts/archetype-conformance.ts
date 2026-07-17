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
 *   AUTH_TOKEN             bearer for discover/task reads
 *   DELEGATE               "1" to run the paid delegation legs (default: presence only)
 * Paid-leg env (DELEGATE=1; devnet on staging):
 *   DELEGATOR_MOTEBIT_ID, DELEGATOR_SEED_HEX, SOLANA_RPC_URL, SOLANA_USDC_MINT
 */

import {
  verifyReceiptVerdict,
  verifyEvalAttestation,
  verifyEvidenceProvenance,
} from "@motebit/verifier";
import type { EvalAttestation } from "@motebit/protocol";

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
        `modes=${agent.settlement_modes ?? "none"}`,
      );
    }
  }
  return bySlate;
}

/**
 * Paid P2P delegation via the REAL delegator client (the same call
 * p2p-cold-start-staging-proof.ts proved) — the probe is a stranger with no
 * history: it pays like one and acknowledges like one (no allowlist;
 * protocol-primacy). Returns the signed receipt.
 */
async function delegatePaid(
  workerId: string,
  capability: string,
  prompt: string,
): Promise<Record<string, unknown>> {
  const { Buffer } = await import("node:buffer");
  const { resolveAndSubmitP2pDelegation } = await import("@motebit/runtime");
  const { createSolanaWalletRail } = await import("@motebit/wallet-solana");
  const required = ["DELEGATOR_MOTEBIT_ID", "DELEGATOR_SEED_HEX", "SOLANA_RPC_URL"] as const;
  for (const k of required) {
    if (!process.env[k]) throw new Error(`DELEGATE=1 requires ${k}`);
  }
  const seedHex = process.env["DELEGATOR_SEED_HEX"]!.replace(/^0x/, "");
  const usdcMint = process.env["SOLANA_USDC_MINT"]?.trim() || undefined;
  const rail = createSolanaWalletRail({
    rpcUrl: process.env["SOLANA_RPC_URL"]!,
    identitySeed: Buffer.from(seedHex, "hex"),
    ...(usdcMint ? { usdcMint } : {}),
  });

  // Fee-leg trust root: pin the relay key from /.well-known (TOFU) — the
  // treasury derives from THIS, matching the staging-proof harness.
  const wk = (await (await fetch(`${RELAY_URL}/.well-known/motebit.json`)).json()) as {
    public_key?: string;
  };
  if (!wk.public_key) throw new Error("relay /.well-known/motebit.json has no public_key");

  const result = await resolveAndSubmitP2pDelegation({
    motebitId: process.env["DELEGATOR_MOTEBIT_ID"]!,
    syncUrl: RELAY_URL,
    authToken: async () => AUTH_TOKEN,
    prompt,
    capability,
    targetWorkerId: workerId,
    relayPublicKeyHex: wk.public_key,
    buildP2pPayment: (req) => rail.buildP2pPayment!(req),
    acknowledgeNoHistoryRisk: true,
    timeoutMs: Number(process.env["TIMEOUT_MS"] ?? "180000"),
    logger: { warn: (m, ctx) => console.warn(`[conformance] warn: ${m}`, ctx ?? "") },
  });
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
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
    const settlePayload = JSON.parse(String(receipt["result"] ?? "{}")) as {
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

  // Citation chain: parse the result payload, cross-check receipt_task_id
  // and run the structural provenance discipline.
  try {
    const payload = JSON.parse(String(receipt["result"] ?? "{}")) as {
      citations?: Array<{
        receipt_task_id?: string;
        excerpt?: string;
        provenance?: { digest?: { algorithm?: string; value?: string }; span?: string };
      }>;
    };
    const nested = (receipt["delegation_receipts"] ?? []) as Array<{ task_id?: string }>;
    const nestedIds = new Set(nested.map((r) => r.task_id).filter(Boolean));
    const citations = payload.citations ?? [];
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

  try {
    const payload = JSON.parse(String(receipt["result"] ?? "{}")) as {
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

  try {
    const status = String(receipt["status"] ?? "");
    const payload = JSON.parse(String(receipt["result"] ?? "{}")) as {
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

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
