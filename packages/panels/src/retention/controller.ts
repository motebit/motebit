// Surface-agnostic state controller for the operator retention-manifest widget.
//
// The Activity panel (sibling controller) shows what the motebit DID
// on the user's behalf — every signed deletion, consent, export.
// This controller shows what the operator PROMISED. Together they
// form the sovereignty-visible pair: you can see what was promised
// and what was done.
//
// The operator publishes two signed manifests at
// `/.well-known/motebit-{transparency,retention}.json`. The
// transparency manifest carries the operator's `relay_public_key`;
// the retention manifest is signed by that same key. Re-verifying in
// the browser without trusting the operator is the entire point of
// `docs/doctrine/operator-transparency.md` § "Self-attesting" and
// `docs/doctrine/retention-policy.md` § "Self-attesting transparency".
// The verifier (`verifyRetentionManifest`) is shipped in
// `@motebit/crypto`; this controller orchestrates the fetch + verify
// pair and exposes the result as state surfaces render against.
//
// Render — DOM block on web, RN view on mobile, terminal table on
// CLI — stays surface-specific. The controller lifts:
//   1. Two-fetch coordination (transparency manifest first for the
//      key, then retention manifest for the body).
//   2. Hex-pubkey decode + verifier dispatch.
//   3. Verification status as discrete state
//      (`loading | verified | invalid | unreachable`) so every
//      surface renders the same calm-software badge regardless of
//      its rendering medium.

// ── Wire types — structural copies ────────────────────────────────────
//
// `@motebit/panels` is Layer 5; importing `@motebit/protocol` would
// pull the panels package into a layering cycle. The shapes below
// mirror `RetentionManifest` + `RetentionStoreDeclaration` from
// `packages/protocol/src/retention-policy.ts:613-635`. Drift would
// surface in the controller's tests when fields move.

export interface RetentionStoreDeclaration {
  readonly store_id: string;
  readonly store_name: string;
  readonly shape:
    | {
        readonly kind: "mutable_pruning";
        readonly max_retention_days_by_sensitivity: Readonly<Record<string, number>>;
      }
    | {
        readonly kind: "append_only_horizon";
        readonly horizon_advance_period_days: number;
        readonly witness_required: boolean;
      }
    | {
        readonly kind: "consolidation_flush";
        readonly flush_to: "memory" | "expire";
        readonly has_min_floor_resolver: boolean;
      };
}

export interface RetentionManifest {
  readonly spec: "motebit/retention-manifest@1";
  readonly operator_id: string;
  readonly issued_at: number;
  readonly stores: ReadonlyArray<RetentionStoreDeclaration>;
  readonly pre_classification_default_sensitivity?: string;
  readonly honest_gaps?: ReadonlyArray<string>;
  readonly suite: string;
  readonly signature: string;
}

export interface TransparencyManifestSummary {
  /** The operator's id (e.g. "relay.motebit.com"). */
  readonly relay_id: string;
  /** Hex-encoded Ed25519 public key. */
  readonly relay_public_key: string;
}

// ── Verification status ───────────────────────────────────────────────

export type RetentionVerification =
  | "idle" // never refreshed
  | "loading" // refresh in flight
  | "verified" // signature valid against operator key
  | "invalid" // fetched but signature does not verify
  | "unreachable"; // fetch threw / non-OK response / parse error

// ── Adapter ───────────────────────────────────────────────────────────

export interface RetentionFetchAdapter {
  /**
   * Fetch the operator's transparency manifest at
   * `/.well-known/motebit-transparency.json` (or wherever the surface
   * resolves it from). Returns the minimal pair needed to verify the
   * retention manifest — the rest of the transparency body is out of
   * scope for this controller.
   */
  fetchTransparency(): Promise<TransparencyManifestSummary | null>;
  /**
   * Fetch the operator's retention manifest at
   * `/.well-known/motebit-retention.json`. Returns the parsed JSON or
   * `null` on any fetch / parse failure (which the controller treats
   * as `unreachable`).
   */
  fetchRetentionManifest(): Promise<RetentionManifest | null>;
  /**
   * Re-run the cryptographic signature check. Surfaces wire this to
   * `verifyRetentionManifest` from `@motebit/crypto`. The adapter
   * decodes the hex public key into bytes (or accepts the manifest +
   * key in whichever form its target API takes) and returns the
   * boolean result + any errors the verifier reported.
   */
  verifyManifest(
    manifest: RetentionManifest,
    operatorPublicKeyHex: string,
  ): Promise<{ valid: boolean; errors: ReadonlyArray<string> }>;
}

// ── State ─────────────────────────────────────────────────────────────

export interface RetentionState {
  manifest: RetentionManifest | null;
  /** Operator id from the transparency manifest. */
  operatorId: string | null;
  /** Operator hex public key from the transparency manifest. */
  operatorPublicKey: string | null;
  verification: RetentionVerification;
  errors: ReadonlyArray<string>;
  /** Wall-clock timestamp of the last successful fetch. null until refresh. */
  fetchedAt: number | null;
}

function initialState(): RetentionState {
  return {
    manifest: null,
    operatorId: null,
    operatorPublicKey: null,
    verification: "idle",
    errors: [],
    fetchedAt: null,
  };
}

// ── Controller ────────────────────────────────────────────────────────

export interface RetentionController {
  getState(): RetentionState;
  subscribe(listener: (state: RetentionState) => void): () => void;
  refresh(): Promise<void>;
  dispose(): void;
}

export function createRetentionController(adapter: RetentionFetchAdapter): RetentionController {
  let state = initialState();
  const listeners = new Set<(s: RetentionState) => void>();

  function emit(): void {
    for (const l of listeners) l(state);
  }
  function update(patch: Partial<RetentionState>): void {
    state = { ...state, ...patch };
    emit();
  }

  async function refresh(): Promise<void> {
    update({ verification: "loading", errors: [] });
    let transparency: TransparencyManifestSummary | null;
    try {
      transparency = await adapter.fetchTransparency();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      update({
        verification: "unreachable",
        errors: [`transparency fetch failed: ${message}`],
      });
      return;
    }
    if (transparency === null) {
      update({
        verification: "unreachable",
        errors: ["transparency manifest unreachable"],
      });
      return;
    }

    let manifest: RetentionManifest | null;
    try {
      manifest = await adapter.fetchRetentionManifest();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      update({
        operatorId: transparency.relay_id,
        operatorPublicKey: transparency.relay_public_key,
        verification: "unreachable",
        errors: [`retention fetch failed: ${message}`],
      });
      return;
    }
    if (manifest === null) {
      update({
        operatorId: transparency.relay_id,
        operatorPublicKey: transparency.relay_public_key,
        verification: "unreachable",
        errors: ["retention manifest unreachable"],
      });
      return;
    }

    let result: { valid: boolean; errors: ReadonlyArray<string> };
    try {
      result = await adapter.verifyManifest(manifest, transparency.relay_public_key);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      update({
        manifest,
        operatorId: transparency.relay_id,
        operatorPublicKey: transparency.relay_public_key,
        verification: "invalid",
        errors: [`verifier threw: ${message}`],
      });
      return;
    }

    update({
      manifest,
      operatorId: transparency.relay_id,
      operatorPublicKey: transparency.relay_public_key,
      verification: result.valid ? "verified" : "invalid",
      errors: result.errors,
      fetchedAt: Date.now(),
    });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    refresh,
    dispose() {
      listeners.clear();
    },
  };
}

// ── Derived view: per-sensitivity retention summary ───────────────────

/**
 * Project a verified manifest into a per-sensitivity ceiling table
 * for display. Walks every `mutable_pruning` store in the manifest
 * and takes the strictest (smallest) ceiling per sensitivity tier
 * across all of them — the user-facing answer to "how long does my
 * operator keep <sensitivity> data?" is the worst-case ceiling
 * across every store that holds it.
 *
 * `Infinity` ceilings (e.g. `none` → unlimited) render as `null`
 * rather than the raw number; surfaces show "no expiry" or similar.
 *
 * Returns the ceilings sorted by tier strictness ascending so a
 * one-line summary chip renders the strict-most-first column. The
 * order is deterministic across surfaces.
 */
export function summarizeRetentionCeilings(
  manifest: RetentionManifest,
): Array<{ sensitivity: string; days: number | null }> {
  const tiers = new Map<string, number>();
  for (const store of manifest.stores) {
    if (store.shape.kind !== "mutable_pruning") continue;
    for (const [tier, days] of Object.entries(store.shape.max_retention_days_by_sensitivity)) {
      const prior = tiers.get(tier);
      if (prior === undefined || days < prior) {
        tiers.set(tier, days);
      }
    }
  }
  // Standard sort: strictest first (smallest finite days), then
  // unlimited (Infinity / NaN) at the end.
  const entries: Array<{ sensitivity: string; days: number | null }> = [];
  for (const [tier, days] of tiers.entries()) {
    entries.push({
      sensitivity: tier,
      days: Number.isFinite(days) ? days : null,
    });
  }
  entries.sort((a, b) => {
    if (a.days === null && b.days === null) return a.sensitivity < b.sensitivity ? -1 : 1;
    if (a.days === null) return 1;
    if (b.days === null) return -1;
    return a.days - b.days;
  });
  return entries;
}
