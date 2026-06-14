// Felt consolidation — the owner-facing projection of what a memory
// consolidation cycle changed, bounded by sensitivity.
//
// Doctrine: `docs/doctrine/felt-interior.md`. The signed
// `ConsolidationReceipt` is the *portable* artifact and commits to structural
// counts only ("merged 3, pruned 7"). The owner-local
// `ConsolidationMutationManifest` commits the EXACT mutations. This file
// shapes both into a calm resting record — and enforces the hard honesty
// invariants in the TYPES, not the renderer:
//
//   - **Evidence is discriminated.** `projectFeltConsolidation` reads the
//     local event log and produces *candidates* carrying time-window-
//     correlated mutations — which are UNVERIFIED and must not be rendered as
//     "what this cycle did". Only `verifyFeltCoverage` may promote a candidate
//     to a `FeltConsolidationRecord`, and its mutation detail lives ONLY on
//     the `verified` arm of the evidence union. A `receipt_only` record
//     structurally cannot carry mutations — so an unverified record can never
//     make the false causal claim "these are this cycle's mutations".
//   - a no-op cycle yields NO record (honest by absence);
//   - a *retired* memory is a count, never content (it is being deleted);
//   - disclosure is sensitivity-tiered through an injectable policy;
//   - provenance rides every mutation so taught and inferred never collapse;
//   - the assurance state is read from receipt/anchor presence, never inflated.
//
// Deliberately omitted by scope (felt-interior increment 1): trust edges,
// skills, and economic accrual. Those ride the same projection seam later.

import {
  SensitivityLevel,
  isMemorySource,
  MEMORY_SOURCE_MARKERS,
  type MemorySource,
  type ConsolidationMutationManifest,
  type ConsolidationReceipt,
} from "@motebit/protocol";

/** A minimal structural slice of an `EventLogEntry` — the projection reads
 *  only these three fields, so callers (and tests) pass plain objects. */
export interface FeltSourceEvent {
  readonly event_type: string;
  readonly timestamp: number;
  readonly payload: Record<string, unknown>;
}

/** The receipt's actual assurance state, read — never inflated. Mirrors the
 *  consolidation-log badge vocabulary (`⚓` / `✓` / bare). */
export type FeltAssurance = "anchored" | "signed" | "unsigned";

/** A formed-or-refined durable mutation, sensitivity-bounded. Retirements are
 *  NOT mutations — they carry no content and live in `receiptSummary.pruned`. */
export type FeltMutationKind = "formed" | "refined";

export interface FeltMutation {
  /** The memory node this line concerns — the key the coverage verifier uses
   *  to map a displayed line to its manifest commitment and raw content.
   *  Opaque UUID, not authority. */
  readonly nodeId: string;
  readonly kind: FeltMutationKind;
  /** Sensitivity-bounded disclosure string produced by the redaction policy. */
  readonly disclosure: string;
  /** Provenance marker source so the renderer can keep taught and inferred
   *  distinct. Absent when the forming event carried unknown vocabulary. */
  readonly provenance?: MemorySource;
  readonly sensitivity: SensitivityLevel;
}

/** The signed structural counts from the `ConsolidationReceipt` — what is
 *  attested even when no manifest covers the exact mutations. `consolidated`
 *  is the receipt's `consolidate_merged` (which can exceed the verified
 *  mutation count — it counts reinforcements that form no node); `pruned`
 *  aggregates the three retirement paths (decay + notability + retention). */
export interface FeltReceiptSummary {
  readonly consolidated: number;
  readonly pruned: number;
}

/**
 * The projection's output for one cycle. It carries `candidateMutations` —
 * memory mutations correlated to the cycle ONLY by time window, hence
 * UNVERIFIED. A candidate is NOT a render contract: a surface must pass it
 * through `verifyFeltCoverage` (or `feltReceiptOnly`) first, so the unverified
 * mutations cannot escape the verifier boundary into a rendered detail line.
 */
export interface FeltCandidate {
  readonly cycleId: string;
  readonly finishedAt: number;
  readonly assurance: FeltAssurance;
  readonly receiptSummary: FeltReceiptSummary;
  readonly candidateMutations: readonly FeltMutation[];
}

/**
 * Discriminated evidence. `receipt_only` structurally cannot carry mutations,
 * so an unverified record cannot present cycle-attributed detail — the false
 * causal claim that time-window correlation could otherwise make is
 * unrepresentable, not merely avoided. Only `verifyFeltCoverage` mints
 * `verified`.
 */
export type FeltMutationEvidence =
  | {
      readonly status: "verified";
      readonly mutations: readonly FeltMutation[];
      readonly manifestId: string;
    }
  | { readonly status: "receipt_only" };

/** The render contract — what a surface draws. Detail lines exist ⟺
 *  `evidence.status === "verified"`. */
export interface FeltConsolidationRecord {
  readonly cycleId: string;
  readonly finishedAt: number;
  readonly assurance: FeltAssurance;
  readonly receiptSummary: FeltReceiptSummary;
  readonly evidence: FeltMutationEvidence;
}

/** The per-record redaction seam. Maps a formed memory to the string the
 *  owner-facing surface may show, bounded by — and free to sit below — its
 *  sensitivity tier. Default is the conservative ceiling. */
export type FeltRedactionPolicy = (input: {
  readonly content: string;
  readonly sensitivity: SensitivityLevel;
  readonly source?: MemorySource;
}) => string;

const DISCLOSURE_CAP = 140;

function cap(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= DISCLOSURE_CAP
    ? trimmed
    : `${trimmed.slice(0, DISCLOSURE_CAP - 1).trimEnd()}…`;
}

/** Conservative default: name the change for `none`/`personal`, fall to an
 *  existence phrase at `medical` and above. */
export const defaultFeltRedaction: FeltRedactionPolicy = ({ content, sensitivity }) => {
  switch (sensitivity) {
    case SensitivityLevel.None:
    case SensitivityLevel.Personal:
      return cap(content) || "a memory";
    case SensitivityLevel.Medical:
    case SensitivityLevel.Financial:
    case SensitivityLevel.Secret:
      return "a private memory";
    default:
      return "a private memory";
  }
};

interface CycleWindow {
  cycleId: string;
  startedAt: number;
  finishedAt: number;
  consolidatedCount: number;
  retiredCount: number;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Project the local event log into per-cycle candidates, newest first. Pure
 * and idempotent: the two `consolidation_cycle_run` markers (started +
 * completed) collapse by `cycle_id`. A cycle that consolidated nothing and
 * retired nothing yields no candidate. The returned `candidateMutations` are
 * UNVERIFIED — pass through `verifyFeltCoverage` before rendering detail.
 */
export function projectFeltConsolidation(
  events: readonly FeltSourceEvent[],
  redact: FeltRedactionPolicy = defaultFeltRedaction,
): FeltCandidate[] {
  const cycleRuns: FeltSourceEvent[] = [];
  const receipts: FeltSourceEvent[] = [];
  const anchors: FeltSourceEvent[] = [];
  const formed: FeltSourceEvent[] = [];
  const consolidated: FeltSourceEvent[] = [];

  for (const e of events) {
    switch (e.event_type) {
      case "consolidation_cycle_run":
        cycleRuns.push(e);
        break;
      case "consolidation_receipt_signed":
        receipts.push(e);
        break;
      case "consolidation_receipts_anchored":
        anchors.push(e);
        break;
      case "memory_formed":
        formed.push(e);
        break;
      case "memory_consolidated":
        consolidated.push(e);
        break;
      default:
        break;
    }
  }

  const receiptByCycle = new Map<string, { receiptId?: string }>();
  for (const e of receipts) {
    const r = (e.payload.receipt ?? {}) as { cycle_id?: unknown; receipt_id?: unknown };
    const cid = asString(r.cycle_id);
    if (cid) receiptByCycle.set(cid, { receiptId: asString(r.receipt_id) });
  }
  const anchoredReceiptIds = new Set<string>();
  for (const e of anchors) {
    const a = (e.payload.anchor ?? {}) as { receipt_ids?: unknown };
    if (Array.isArray(a.receipt_ids)) {
      for (const id of a.receipt_ids) {
        const s = asString(id);
        if (s) anchoredReceiptIds.add(s);
      }
    }
  }

  // Collapse started + completed markers into one window per cycle; the
  // completed marker carries the signed structural counts.
  const windows = new Map<string, CycleWindow>();
  for (const e of cycleRuns) {
    const cycleId = asString(e.payload.cycle_id);
    if (!cycleId) continue;
    const status = asString(e.payload.status);
    const summary = (e.payload.summary ?? {}) as Record<string, unknown>;
    const existing = windows.get(cycleId);
    const w: CycleWindow = existing ?? {
      cycleId,
      startedAt: e.timestamp,
      finishedAt: e.timestamp,
      consolidatedCount: 0,
      retiredCount: 0,
    };
    if (status === "completed" || existing === undefined) {
      w.finishedAt = Math.max(w.finishedAt, e.timestamp);
    }
    if (status === "started" || existing === undefined) {
      w.startedAt = Math.min(w.startedAt, e.timestamp);
    }
    if (status !== "started") {
      const consolidatedN = asNumber(summary.consolidate_merged) ?? 0;
      if (consolidatedN > 0) w.consolidatedCount = consolidatedN;
      // `faded` is the gentle owner-facing umbrella for the three retirement
      // paths (decay + low-notability + retention policy). The aggregate count
      // does NOT claim a specific dissolution mechanism.
      const retired =
        (asNumber(summary.pruned_decay) ?? 0) +
        (asNumber(summary.pruned_notability) ?? 0) +
        (asNumber(summary.pruned_retention) ?? 0);
      if (retired > 0) w.retiredCount = retired;
    }
    windows.set(cycleId, w);
  }

  const refinedNodeIds = new Set<string>();
  for (const e of consolidated) {
    const action = asString(e.payload.action);
    const newId = asString(e.payload.new_node_id);
    if ((action === "merge" || action === "supersede") && newId) refinedNodeIds.add(newId);
  }

  const candidates: FeltCandidate[] = [];
  for (const w of windows.values()) {
    const candidateMutations: FeltMutation[] = [];
    for (const e of formed) {
      if (e.timestamp < w.startedAt || e.timestamp > w.finishedAt) continue;
      const p = e.payload as {
        node_id?: unknown;
        content?: unknown;
        sensitivity?: unknown;
        source?: unknown;
        redacted_reason?: unknown;
      };
      if (p.redacted_reason === "deleted") continue;
      const nodeId = asString(p.node_id);
      if (!nodeId) continue;
      const content = asString(p.content) ?? "";
      const sensitivity = isSensitivity(p.sensitivity) ? p.sensitivity : SensitivityLevel.Secret;
      const source = isMemorySource(p.source) ? p.source : undefined;
      candidateMutations.push({
        nodeId,
        kind: refinedNodeIds.has(nodeId) ? "refined" : "formed",
        disclosure: redact({ content, sensitivity, source }),
        ...(source ? { provenance: source } : {}),
        sensitivity,
      });
    }

    // Honest by absence — a cycle that did nothing surfaces nothing. A
    // pure-prune cycle (consolidated 0, candidates 0, retired > 0) DOES surface
    // as a receipt-only summary.
    if (candidateMutations.length === 0 && w.consolidatedCount === 0 && w.retiredCount === 0) {
      continue;
    }

    const receipt = receiptByCycle.get(w.cycleId);
    const assurance: FeltAssurance =
      receipt?.receiptId !== undefined && anchoredReceiptIds.has(receipt.receiptId)
        ? "anchored"
        : receipt
          ? "signed"
          : "unsigned";

    candidates.push({
      cycleId: w.cycleId,
      finishedAt: w.finishedAt,
      assurance,
      receiptSummary: { consolidated: w.consolidatedCount, pruned: w.retiredCount },
      candidateMutations,
    });
  }

  candidates.sort((a, b) => b.finishedAt - a.finishedAt);
  return candidates;
}

/**
 * The crypto an owner-facing surface injects so coverage can be verified
 * without `@motebit/panels` taking a crypto dependency (adapter inversion).
 * All three MUST be the producer's exact functions
 * (`verifyConsolidationMutationManifest` against the OWNER's key,
 * `consolidationReceiptDigest`, `consolidationContentDigest`).
 */
export interface FeltCoverageAdapter {
  /** Verify the manifest's signature against the OWNER's public key — a
   *  manifest forged under another key must fail. (Current-key, fail-closed:
   *  a manifest signed by a rotated/historical key reads receipt-only, never
   *  falsely verified — succession-chain verification is a deferred
   *  enhancement for both surfaces, NOT implied here.) */
  verifyManifest(manifest: ConsolidationMutationManifest): Promise<boolean>;
  receiptDigest(receipt: ConsolidationReceipt): Promise<string>;
  contentDigest(content: string): Promise<string>;
}

/**
 * Promote candidates to render-safe records. A candidate becomes `verified`
 * (its mutations exposed for render) ONLY when the manifest signature
 * verifies, it is bound to the exact receipt by id + digest, and every
 * candidate mutation's raw local content hashes to its commitment (provenance
 * + sensitivity matched, displayed set == committed set). Any failure →
 * `receipt_only` (no mutations, fail-closed). Pure orchestration; crypto is
 * the injected adapter.
 */
export async function verifyFeltCoverage(
  candidates: readonly FeltCandidate[],
  events: readonly FeltSourceEvent[],
  adapter: FeltCoverageAdapter,
): Promise<FeltConsolidationRecord[]> {
  const manifestByCycle = new Map<string, ConsolidationMutationManifest>();
  const receiptByCycle = new Map<string, ConsolidationReceipt>();
  for (const e of events) {
    if (e.event_type !== "consolidation_receipt_signed") continue;
    const p = e.payload as {
      receipt?: ConsolidationReceipt;
      mutation_manifest?: ConsolidationMutationManifest;
    };
    if (p.receipt && typeof p.receipt.cycle_id === "string") {
      receiptByCycle.set(p.receipt.cycle_id, p.receipt);
    }
    if (p.mutation_manifest && typeof p.mutation_manifest.cycle_id === "string") {
      manifestByCycle.set(p.mutation_manifest.cycle_id, p.mutation_manifest);
    }
  }

  const rawByNode = new Map<
    string,
    { content: string; provenance?: MemorySource; sensitivity: SensitivityLevel }
  >();
  for (const e of events) {
    if (e.event_type !== "memory_formed") continue;
    const p = e.payload as {
      node_id?: unknown;
      content?: unknown;
      source?: unknown;
      sensitivity?: unknown;
      redacted_reason?: unknown;
    };
    const nodeId = asString(p.node_id);
    const content = asString(p.content);
    if (!nodeId || content === undefined || p.redacted_reason === "deleted") continue;
    rawByNode.set(nodeId, {
      content,
      provenance: isMemorySource(p.source) ? p.source : undefined,
      sensitivity: isSensitivity(p.sensitivity) ? p.sensitivity : SensitivityLevel.Secret,
    });
  }

  const out: FeltConsolidationRecord[] = [];
  for (const c of candidates) {
    const manifest = manifestByCycle.get(c.cycleId);
    const verified = await coverageHolds(
      c,
      manifest,
      receiptByCycle.get(c.cycleId),
      rawByNode,
      adapter,
    );
    const common = {
      cycleId: c.cycleId,
      finishedAt: c.finishedAt,
      assurance: c.assurance,
      receiptSummary: c.receiptSummary,
    };
    out.push(
      verified && manifest
        ? {
            ...common,
            evidence: {
              status: "verified",
              mutations: c.candidateMutations,
              manifestId: manifest.manifest_id,
            },
          }
        : { ...common, evidence: { status: "receipt_only" } },
    );
  }
  return out;
}

/**
 * The no-adapter path: with no signing keys, nothing can be verified, so every
 * candidate degrades to a render-safe `receipt_only` record. Surfaces use this
 * when the owner has no local identity key.
 */
// Module-exported for in-package tests only — NOT re-exported from the package
// barrel, so surfaces cannot reach the candidate-consuming primitives and must
// call `resolveFeltConsolidation`.
export function feltReceiptOnly(candidates: readonly FeltCandidate[]): FeltConsolidationRecord[] {
  return candidates.map((c) => ({
    cycleId: c.cycleId,
    finishedAt: c.finishedAt,
    assurance: c.assurance,
    receiptSummary: c.receiptSummary,
    evidence: { status: "receipt_only" } as const,
  }));
}

/**
 * The CANONICAL entry point a surface calls — the verifier boundary made
 * canonical. It projects private candidates, verifies them when an
 * expected-key adapter is supplied (else degrades every candidate to
 * receipt-only), and returns ONLY render-safe records. The candidate type —
 * which carries unverified time-window mutations — never leaves this module
 * (it is not exported from the package barrel), so no surface can render
 * unverified cycle-attributed detail or forget the receipt-only degradation.
 */
export async function resolveFeltConsolidation(
  events: readonly FeltSourceEvent[],
  adapter?: FeltCoverageAdapter,
  redact: FeltRedactionPolicy = defaultFeltRedaction,
): Promise<FeltConsolidationRecord[]> {
  const candidates = projectFeltConsolidation(events, redact);
  return adapter ? verifyFeltCoverage(candidates, events, adapter) : feltReceiptOnly(candidates);
}

async function coverageHolds(
  c: FeltCandidate,
  manifest: ConsolidationMutationManifest | undefined,
  receipt: ConsolidationReceipt | undefined,
  rawByNode: ReadonlyMap<
    string,
    { content: string; provenance?: MemorySource; sensitivity: SensitivityLevel }
  >,
  adapter: FeltCoverageAdapter,
): Promise<boolean> {
  if (!manifest || !receipt) return false;
  if (c.candidateMutations.length === 0) return false;
  if (!(await adapter.verifyManifest(manifest))) return false;
  if (manifest.receipt_id !== receipt.receipt_id) return false;
  if (manifest.receipt_digest !== (await adapter.receiptDigest(receipt))) return false;
  const committed = new Map(manifest.mutations.map((m) => [m.node_id, m]));
  if (c.candidateMutations.length !== committed.size) return false;
  for (const dm of c.candidateMutations) {
    const cm = committed.get(dm.nodeId);
    if (!cm) return false;
    const raw = rawByNode.get(dm.nodeId);
    if (!raw) return false;
    if ((await adapter.contentDigest(raw.content)) !== cm.content_sha256) return false;
    if (cm.provenance !== raw.provenance) return false;
    if (cm.sensitivity !== raw.sensitivity) return false;
  }
  return true;
}

/** Unknown/absent sensitivity fails closed to `Secret`. */
function isSensitivity(v: unknown): v is SensitivityLevel {
  return (
    v === SensitivityLevel.None ||
    v === SensitivityLevel.Personal ||
    v === SensitivityLevel.Medical ||
    v === SensitivityLevel.Financial ||
    v === SensitivityLevel.Secret
  );
}

// ── Copy formatters — the calm presentation decisions, shared ──────────────
//
// These live here (not in a surface) so every surface reads identically — the
// canonical-boundary fix, the same place `formatPeerEconomics` lives. Only
// *time* formatting stays per-surface (panels rule 6).

/**
 * The resting headline. A `verified` record shows the per-mutation split
 * ("2 learned · 1 refined") — the manifest commits each `kind`. A
 * `receipt_only` record shows the signed aggregate ("3 consolidated") — the
 * counts-only receipt has no formed/refined split, and the unverified
 * candidate split must NOT be shown. `faded` (the receipt's pruned aggregate)
 * follows either. Zero parts omitted.
 */
export function feltHeadline(record: FeltConsolidationRecord): string {
  const parts: string[] = [];
  if (record.evidence.status === "verified") {
    const learned = record.evidence.mutations.filter((m) => m.kind === "formed").length;
    const refined = record.evidence.mutations.filter((m) => m.kind === "refined").length;
    if (learned > 0) parts.push(`${learned} learned`);
    if (refined > 0) parts.push(`${refined} refined`);
  } else if (record.receiptSummary.consolidated > 0) {
    parts.push(`${record.receiptSummary.consolidated} consolidated`);
  }
  if (record.receiptSummary.pruned > 0) parts.push(`${record.receiptSummary.pruned} faded`);
  return parts.join(" · ");
}

/**
 * One reveal line. The provenance marker is shown ONLY when it is not the
 * obvious default (`consolidation_derived`) — redundant on a consolidation
 * surface, meaningful where provenance varies. Disclosure is already
 * sensitivity-bounded.
 */
export function feltMutationLine(m: FeltMutation): string {
  const verb = m.kind === "refined" ? "Refined" : "Learned";
  const marker =
    m.provenance && m.provenance !== "consolidation_derived"
      ? ` · ${MEMORY_SOURCE_MARKERS[m.provenance]}`
      : "";
  return `${verb}: ${m.disclosure}${marker}`;
}

/**
 * The calm assurance label for a `verified` record's reveal — a short word
 * plus the cryptographic scope for an accessible label. Only `verified`
 * records carry detail, so this is the only coverage assurance a surface
 * shows; a `receipt_only` record shows no coverage label at all (absence of
 * "Verified" is the honest signal). Never reads "Local"/"Unverified".
 */
export function feltVerifiedAssurance(): { label: string; detail: string } {
  return {
    label: "Verified",
    detail:
      "These exact displayed changes match the signed mutation manifest for this cycle, checked against your own key.",
  };
}

/**
 * The calm receipt-assurance glyph for the resting row. Scope is the cycle
 * RECEIPT, never the detail lines. Unsigned ⇒ no glyph (no placeholder).
 */
export function feltAssuranceGlyph(assurance: FeltAssurance): string {
  return assurance === "anchored" ? "⚓" : assurance === "signed" ? "✓" : "";
}

/**
 * The accessible scope sentence for the receipt glyph — that this cycle
 * produced a signed (optionally anchored) receipt. It does NOT claim to attest
 * the displayed counts (those are manifest-covered, `feltVerifiedAssurance`).
 *
 * The sentence is evidence-aware: a `receipt_only` row deliberately shows no
 * exact changes, so its label must not say "the exact changes shown are
 * verified separately" (state-inaccurate — there are none shown). It says the
 * detailed changes are *unavailable* without a verified manifest instead. Only
 * a `verified` row, which does show detail lines, references those changes.
 */
export function feltReceiptScope(
  assurance: FeltAssurance,
  evidenceStatus: FeltMutationEvidence["status"],
): string {
  if (assurance === "unsigned") {
    return "This cycle is unsigned (no signing keys, or a zero-phase cycle).";
  }
  const receipt =
    assurance === "anchored"
      ? "This consolidation cycle's signed receipt is anchored onchain."
      : "This consolidation cycle produced a signed receipt.";
  const detail =
    evidenceStatus === "verified"
      ? "The exact changes shown are verified separately against its signed mutation manifest."
      : "Detailed changes are unavailable without a verified mutation manifest.";
  return `${receipt} ${detail}`;
}
