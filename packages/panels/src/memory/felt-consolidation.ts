// Felt consolidation — the owner-facing projection of what a memory
// consolidation cycle changed, bounded by sensitivity.
//
// Doctrine: `docs/doctrine/felt-interior.md`. The signed
// `ConsolidationReceipt` is the *portable* artifact and commits to
// structural counts only ("merged 3, pruned 7"). This projection is the
// *local owner-facing* artifact — never transmitted — so it may be as rich
// as each memory's own sensitivity tier permits. Two artifacts, two
// boundaries; this file is the second.
//
// It is a pure function over the local event log. It invents no accrual:
// it reads the same `memory_formed` / `memory_consolidated` /
// `consolidation_cycle_run` / `consolidation_receipt_*` events the runtime
// already emits, and shapes them into a calm resting record. The hard
// invariants live here, not in the renderer:
//
//   - a no-op cycle forms NO record (honest by absence, never a fabricated
//     "I did nothing" notice);
//   - a *retired* memory is rendered as existence-plus-count, never its
//     content — it is being deleted, and surfacing it would contradict the
//     deletion;
//   - disclosure is sensitivity-tiered through an injectable policy (the
//     per-record redaction seam the doctrine requires — never one
//     hard-coded line per tier);
//   - provenance rides every formed mutation so a *taught* fact and an
//     *inferred* one never collapse into one voice;
//   - the assurance state is read from the receipt/anchor presence and is
//     never upgraded — the surface must not imply signing or anchoring that
//     did not occur.
//
// Deliberately omitted by scope (felt-interior increment 1): trust edges,
// skills, and economic accrual. Those ride the same projection seam later.

import {
  SensitivityLevel,
  isMemorySource,
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

/** A formed-or-refined durable mutation, sensitivity-bounded. Retirements
 *  are NOT mutations here — they carry no content by construction and live
 *  in `retired` as a count. */
export type FeltMutationKind = "formed" | "refined";

export interface FeltMutation {
  /** The memory node this line concerns — the key a coverage verifier uses to
   *  map a displayed line to its manifest commitment and raw content. Opaque
   *  UUID, not authority. */
  readonly nodeId: string;
  readonly kind: FeltMutationKind;
  /** Sensitivity-bounded disclosure string produced by the redaction
   *  policy. For `none`/`personal` this may be the memory's own content;
   *  for `medical`/`financial`/`secret` it falls to an existence phrase. */
  readonly disclosure: string;
  /** Provenance marker source so the renderer can keep taught and inferred
   *  distinct. Absent when the forming event carried unknown vocabulary
   *  (degraded per `memory-provenance.md`, never to a trusted tier). */
  readonly provenance?: MemorySource;
  readonly sensitivity: SensitivityLevel;
}

export interface FeltConsolidationRecord {
  readonly cycleId: string;
  readonly finishedAt: number;
  /** The receipt's actual assurance state. Scope: this covers the cycle
   *  *receipt* — the structural counts the signed `ConsolidationReceipt`
   *  commits to — NOT the per-mutation detail lines below. See
   *  `mutationsCoveredBySignature`. */
  readonly assurance: FeltAssurance;
  /** Formed + refined mutations, sensitivity-bounded. */
  readonly mutations: readonly FeltMutation[];
  /** Memories the cycle retired (decay + notability + retention), as a
   *  count only — never content. */
  readonly retired: { readonly count: number };
  /** Whether the detail mutations are cryptographically covered by a
   *  signature. The pure `projectFeltConsolidation` ALWAYS leaves this
   *  `false` — the signed `ConsolidationReceipt` commits to counts only, so a
   *  signed/anchored glyph alone attests the counts, never these exact
   *  sentences. `verifyFeltCoverage` upgrades it to `true` only when the
   *  cycle's signed `ConsolidationMutationManifest` verifies (signature +
   *  receipt linkage + every displayed line's content/provenance/sensitivity
   *  matched against its commitment, displayed set == committed set);
   *  fail-closed otherwise. The surface MUST render the scope honestly and
   *  never imply the details are signed when this is `false`. Doctrine:
   *  `felt-interior.md`; wire: `spec/consolidation-mutation-manifest-v1.md`. */
  readonly mutationsCoveredBySignature: boolean;
}

/** The per-record redaction seam. Maps a formed memory to the string the
 *  owner-facing surface may show, bounded by — and free to sit below — its
 *  sensitivity tier. Callers MAY pass a richer policy; the default is the
 *  conservative ceiling. The doctrine forbids hard-coding one line per tier
 *  *in the projection itself* — that is why this is a parameter. */
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
 *  existence phrase at `medical` and above (the category itself can be the
 *  sensitive content). A future policy may surface a *redacted consequence*
 *  for higher tiers where the shape is non-identifying — that extension
 *  rides this same seam without touching the projection. */
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
      // Unknown tier → fail closed to existence-only.
      return "a private memory";
  }
};

interface CycleWindow {
  cycleId: string;
  startedAt: number;
  finishedAt: number;
  retiredCount: number;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Project the local event log into per-cycle felt records, newest first.
 *
 * Pure and idempotent: the same events yield the same records, and the two
 * `consolidation_cycle_run` events a cycle emits (a `started` write-ahead
 * marker and a `completed` event) are deduped by `cycle_id` so a mutation
 * is never double-counted across a replay or a restart. A cycle that formed
 * nothing and retired nothing yields no record.
 */
export function projectFeltConsolidation(
  events: readonly FeltSourceEvent[],
  redact: FeltRedactionPolicy = defaultFeltRedaction,
): FeltConsolidationRecord[] {
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

  // Receipt presence (signed) + anchored receipt ids, keyed for assurance.
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

  // Collapse the started + completed markers into one window per cycle.
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
      retiredCount: 0,
    };
    // started marker bounds the window's lower edge; completed bounds the
    // upper edge and carries the retirement counts.
    if (status === "completed" || existing === undefined) {
      w.finishedAt = Math.max(w.finishedAt, e.timestamp);
    }
    if (status === "started" || existing === undefined) {
      w.startedAt = Math.min(w.startedAt, e.timestamp);
    }
    if (status !== "started") {
      const retired =
        (asNumber(summary.pruned_decay) ?? 0) +
        (asNumber(summary.pruned_notability) ?? 0) +
        (asNumber(summary.pruned_retention) ?? 0);
      if (retired > 0) w.retiredCount = retired;
    }
    windows.set(cycleId, w);
  }

  // Which formed nodes were refinements of an existing belief, by id.
  const refinedNodeIds = new Set<string>();
  for (const e of consolidated) {
    const action = asString(e.payload.action);
    const newId = asString(e.payload.new_node_id);
    if ((action === "merge" || action === "supersede") && newId) refinedNodeIds.add(newId);
  }

  const records: FeltConsolidationRecord[] = [];
  for (const w of windows.values()) {
    const mutations: FeltMutation[] = [];
    for (const e of formed) {
      if (e.timestamp < w.startedAt || e.timestamp > w.finishedAt) continue;
      const p = e.payload as {
        node_id?: unknown;
        content?: unknown;
        sensitivity?: unknown;
        source?: unknown;
        redacted_reason?: unknown;
      };
      // A deletion tombstone reuses memory_formed with a blanked content —
      // never a felt "learned" line.
      if (p.redacted_reason === "deleted") continue;
      const nodeId = asString(p.node_id);
      if (!nodeId) continue; // a formed event without an id cannot be covered
      const content = asString(p.content) ?? "";
      const sensitivity = isSensitivity(p.sensitivity) ? p.sensitivity : SensitivityLevel.Secret;
      const source = isMemorySource(p.source) ? p.source : undefined;
      mutations.push({
        nodeId,
        kind: refinedNodeIds.has(nodeId) ? "refined" : "formed",
        disclosure: redact({ content, sensitivity, source }),
        ...(source ? { provenance: source } : {}),
        sensitivity,
      });
    }

    // Honest by absence: a cycle that formed nothing and retired nothing is
    // not a felt record.
    if (mutations.length === 0 && w.retiredCount === 0) continue;

    const receipt = receiptByCycle.get(w.cycleId);
    const assurance: FeltAssurance =
      receipt?.receiptId !== undefined && anchoredReceiptIds.has(receipt.receiptId)
        ? "anchored"
        : receipt
          ? "signed"
          : "unsigned";

    records.push({
      cycleId: w.cycleId,
      finishedAt: w.finishedAt,
      assurance,
      mutations,
      retired: { count: w.retiredCount },
      // The receipt commits to counts only; the detail set is a local
      // time-window reconstruction. Never claim signature coverage of it.
      mutationsCoveredBySignature: false,
    });
  }

  records.sort((a, b) => b.finishedAt - a.finishedAt);
  return records;
}

/**
 * The crypto an owner-facing surface injects so coverage can be verified
 * without `@motebit/panels` taking a crypto dependency (the panels
 * adapter-inversion rule). All three MUST be the producer's exact functions
 * (`verifyConsolidationMutationManifest` against the OWNER's key,
 * `consolidationReceiptDigest`, `consolidationContentDigest`).
 */
export interface FeltCoverageAdapter {
  /** Verify the manifest's signature against the OWNER's public key — a
   *  manifest forged under another key must fail, not pass on its embedded
   *  key. */
  verifyManifest(manifest: ConsolidationMutationManifest): Promise<boolean>;
  /** Canonical SHA-256 (hex) of a signed receipt. */
  receiptDigest(receipt: ConsolidationReceipt): Promise<string>;
  /** SHA-256 (hex) of a memory node's raw content. */
  contentDigest(content: string): Promise<string>;
}

/**
 * Upgrade `mutationsCoveredBySignature` to `true` only for records whose
 * displayed mutations are cryptographically proven to be the signed cycle's:
 * the manifest signature verifies, it is bound to the exact receipt by id +
 * digest, and every displayed line's raw local content hashes to its
 * commitment (with matching provenance + sensitivity), the displayed set
 * equaling the committed set. Any failure leaves the record uncovered —
 * fail-closed. Pure orchestration; the crypto is the injected adapter.
 */
export async function verifyFeltCoverage(
  records: readonly FeltConsolidationRecord[],
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
  for (const rec of records) {
    const covered = await coverageHolds(
      rec,
      manifestByCycle.get(rec.cycleId),
      receiptByCycle.get(rec.cycleId),
      rawByNode,
      adapter,
    );
    out.push(
      covered === rec.mutationsCoveredBySignature
        ? rec
        : { ...rec, mutationsCoveredBySignature: covered },
    );
  }
  return out;
}

async function coverageHolds(
  rec: FeltConsolidationRecord,
  manifest: ConsolidationMutationManifest | undefined,
  receipt: ConsolidationReceipt | undefined,
  rawByNode: ReadonlyMap<
    string,
    { content: string; provenance?: MemorySource; sensitivity: SensitivityLevel }
  >,
  adapter: FeltCoverageAdapter,
): Promise<boolean> {
  if (!manifest || !receipt) return false;
  if (rec.mutations.length === 0) return false;
  // Signature — against the owner's key, inside the adapter.
  if (!(await adapter.verifyManifest(manifest))) return false;
  // Receipt linkage — the manifest binds the EXACT signed receipt.
  if (manifest.receipt_id !== receipt.receipt_id) return false;
  if (manifest.receipt_digest !== (await adapter.receiptDigest(receipt))) return false;
  // Displayed set === committed set, each content + provenance + sensitivity matched.
  const committed = new Map(manifest.mutations.map((m) => [m.node_id, m]));
  if (rec.mutations.length !== committed.size) return false;
  for (const dm of rec.mutations) {
    const c = committed.get(dm.nodeId);
    if (!c) return false;
    const raw = rawByNode.get(dm.nodeId);
    if (!raw) return false;
    if ((await adapter.contentDigest(raw.content)) !== c.content_sha256) return false;
    if (c.provenance !== raw.provenance) return false;
    if (c.sensitivity !== raw.sensitivity) return false;
  }
  return true;
}

/** Unknown/absent sensitivity fails closed to `Secret` (the strictest
 *  ceiling) — an omitted classification must never read as `none`. */
function isSensitivity(v: unknown): v is SensitivityLevel {
  return (
    v === SensitivityLevel.None ||
    v === SensitivityLevel.Personal ||
    v === SensitivityLevel.Medical ||
    v === SensitivityLevel.Financial ||
    v === SensitivityLevel.Secret
  );
}
