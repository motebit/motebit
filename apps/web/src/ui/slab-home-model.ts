/**
 * Slab home-register model — the derived capability-seed.
 *
 * `motebit-computer.md` §home: "Derive the seed; never author it. The seed
 * is capability-registry × config-state … so the N=0 surface CANNOT lie
 * about what the motebit can do — a mirror, not a brochure."
 *
 * This module is the pure half of that sentence: zero DOM, zero
 * `@motebit/runtime` imports (inputs structurally typed), one derivation
 * function. Per-surface located by the surface-controller-extraction
 * four-question test (web is the only home-rendering surface today — Q1
 * fails for a package); written as the Ring-1 contract so the lift to
 * `@motebit/panels` when a second home surface begins is a file move.
 *
 * Honesty is structural, then gate-locked:
 *   - `HomeSeedInputs.config` requires EVERY `HomeConfigKey` — the
 *     assembly site (web-app.ts `buildHomeSeedInputs`) must answer each
 *     from a live accessor; `check-home-seed-basis` anchors that coupling.
 *   - Every tile carries a `basis` — the evidence that minted it
 *     (attribution-because-produced, the felt-accumulation discipline
 *     applied to the resting face).
 *   - `HomeTileAction` is promptless by construction: no variant carries
 *     free text, so a tile handler CANNOT synthesize a prompt into the AI
 *     loop (surface-determinism, enforced shape-first).
 *
 * The wallet is deliberately NOT a config key: `getSolanaAddress()` derives
 * from the identity key (one motebit = one wallet), so it is non-null for
 * every motebit that can render a home at all — a witness that is always
 * true gates nothing and would make the seed lie by ceremony.
 */

import type { UserInputForwardedPayload } from "@motebit/sdk";

// ─── Resumption basis (moved verbatim from slab-home.ts) ────────────────

/**
 * A forward-framed resumption destination derived from the motebit's own
 * redacted navigate audit (scheme + host only survive redaction — tiles
 * point to sites, never specific pages; privacy-aligned by construction).
 */
export interface SlabHomeAffordance {
  /** Stable id derived from host for dedup. */
  readonly id: string;
  /** Hostname (e.g., `google.com`). */
  readonly host: string;
  /** URL scheme (e.g., `https`). */
  readonly scheme: string;
  /** Last engagement timestamp — used for sorting; NOT displayed. */
  readonly lastEngagedAt: number;
}

const MAX_AFFORDANCES = 4;

/**
 * Canonicalize a hostname for tile dedup: lowercase, strip leading
 * `www.`, reject dot-less typos (`"gmail"`); `localhost` survives.
 * Returns null for rejects so the caller drops the affordance.
 */
export function canonicalizeHost(host: string): string | null {
  const lower = host.toLowerCase().trim();
  if (lower === "" || lower === "unknown") return null;
  const stripped = lower.startsWith("www.") ? lower.slice(4) : lower;
  if (stripped === "localhost") return stripped;
  if (!stripped.includes(".")) return null;
  return stripped;
}

/**
 * Compute resumption affordances from redacted navigate audit events.
 * Pure: dedups by canonical host (most-recent engagement wins), returns
 * the top N by recency.
 */
export function computeSlabHomeAffordances(
  events: ReadonlyArray<{ payload: UserInputForwardedPayload; timestamp: number }>,
  maxAffordances: number = MAX_AFFORDANCES,
): SlabHomeAffordance[] {
  const seen = new Map<string, SlabHomeAffordance>();
  const sorted = [...events].sort((a, b) => b.timestamp - a.timestamp);
  for (const ev of sorted) {
    const detail = ev.payload.detail;
    if (detail.kind !== "navigate") continue;
    const canonical = canonicalizeHost(detail.host);
    if (canonical == null) continue;
    if (seen.has(canonical)) continue;
    seen.set(canonical, {
      id: `aff-${canonical}`,
      host: canonical,
      scheme: detail.scheme === "unknown" ? "https" : detail.scheme,
      lastEngagedAt: ev.timestamp,
    });
    if (seen.size >= maxAffordances) break;
  }
  return [...seen.values()];
}

// ─── The config-state registry (closed; gate-locked) ────────────────────

/**
 * The closed registry of config axes the seed derives from. Locked by
 * `check-home-seed-basis`: each key must be answered from a live runtime
 * accessor at the assembly site, and each must have a recede test (wired
 * ⇒ its setup tile is absent). Adding an axis is intentional work — all
 * sites in the same commit.
 */
export const HOME_CONFIG_KEYS = ["mind", "relay", "computer"] as const;
export type HomeConfigKey = (typeof HOME_CONFIG_KEYS)[number];

export interface HomeSeedInputs {
  readonly identity: { readonly motebitId: string };
  /** ALL keys required — the assembly site answers each from a live accessor. */
  readonly config: Readonly<Record<HomeConfigKey, boolean>>;
  /** Names from the live tool registry — evidence, never authorship. */
  readonly toolNames: readonly string[];
  /** Redacted navigate audit rows (scheme + host only) — the resumption basis. */
  readonly navigateEvents: ReadonlyArray<{
    payload: UserInputForwardedPayload;
    timestamp: number;
  }>;
}

// ─── Tiles ───────────────────────────────────────────────────────────────

/**
 * Promptless by construction — no variant carries free text, so a tile
 * handler cannot synthesize a prompt into the AI loop.
 */
export type HomeTileAction =
  | { readonly kind: "navigate"; readonly url: string }
  | { readonly kind: "focus_ingress" }
  | { readonly kind: "open_goals" }
  | { readonly kind: "open_agents" }
  | { readonly kind: "open_setup"; readonly key: HomeConfigKey };

export type HomeTileLayer = "intrinsic" | "config_gated" | "setup" | "resumption";

/**
 * Attribution-because-PRODUCED: every tile carries the evidence that
 * minted it. A tile with no live basis is unconstructible from this
 * module's public API (deriveHomeSeed is the only producer; the gate
 * scans for stray literals).
 */
export type HomeTileBasis =
  | { readonly kind: "identity" }
  | { readonly kind: "config"; readonly key: HomeConfigKey; readonly wired: boolean }
  | { readonly kind: "audit"; readonly host: string; readonly lastEngagedAt: number };

export interface HomeTile {
  readonly id: string;
  readonly layer: HomeTileLayer;
  /** Forward verb ONLY — the body shows acts, never "Visited …" records. */
  readonly verb: string;
  /** Host for resumption tiles; absent elsewhere. */
  readonly subject?: string;
  readonly action: HomeTileAction;
  readonly basis: HomeTileBasis;
}

// ─── The seed ────────────────────────────────────────────────────────────

/** The N-arc: invitation (no record yet) → mixed → resumption-dominant. */
export type HomeSeedPhase = "invitation" | "mixed" | "resumption";

/**
 * Honest-degradation truth for the chrome ingress: a bare motebit (no
 * mind wired) never renders a chat that pretends to think — its ingress
 * offers "go" only, and the connect-a-mind setup tile is the path to more.
 */
export type HomeIngressMode = "ask_or_go" | "go_only";

export interface HomeSeed {
  readonly identity: { readonly motebitId: string };
  readonly phase: HomeSeedPhase;
  /**
   * ≤ TILE_BUDGET total, INCLUSIVE of setup tiles. Order: resumption,
   * then config-gated launchpads, then setup.
   */
  readonly tiles: readonly HomeTile[];
  readonly ingressMode: HomeIngressMode;
}

/** Total tile budget — setup tiles reserve slots first (they are the
 *  honest first move for an unconfigured motebit and must never be
 *  crowded out by resumption). */
export const TILE_BUDGET = 5;

/**
 * The launchpad table — module-private, copy is the only authored part;
 * PRESENCE is derived (witness = a config key that must be true). "Set a
 * goal" is the intrinsic floor: genuinely model-free, never gated.
 * Deliberately NO ask-me tile: address-me is the always-present chat
 * input plus the ingress line — a second ready signal would compete
 * (`motebit-computer.md`: "Two ready signals competing is a violation").
 */
const LAUNCHPADS: ReadonlyArray<{
  readonly id: string;
  readonly verb: string;
  readonly witness: HomeConfigKey | null; // null ⇒ intrinsic floor
  readonly action: HomeTileAction;
}> = [
  { id: "lp-goal", verb: "Set a goal", witness: null, action: { kind: "open_goals" } },
  { id: "lp-read", verb: "Read a page", witness: "computer", action: { kind: "focus_ingress" } },
  { id: "lp-find", verb: "Find an agent", witness: "relay", action: { kind: "open_agents" } },
  { id: "lp-hire", verb: "Hire", witness: "relay", action: { kind: "open_agents" } },
];

/** Setup affordances — surfaced ONLY while the dependency is missing;
 *  structurally absent (not hidden) once wired. Calm, not nags. */
const SETUP_TILES: ReadonlyArray<{
  readonly key: HomeConfigKey;
  readonly verb: string;
}> = [
  { key: "mind", verb: "Connect a mind" },
  { key: "relay", verb: "Connect a relay" },
];

/**
 * Derive the home seed. Pure; the ONLY producer of `HomeTile`s.
 *
 * Budget arithmetic (property-tested): setup tiles (≤2, only while unmet)
 * reserve slots FIRST; resumption fills next (≤4); config-gated
 * launchpads fill the remainder and recede to zero exactly when the
 * phase reaches `resumption` (boundary aligned by construction: both key
 * off the same resumption count).
 */
export function deriveHomeSeed(inputs: HomeSeedInputs): HomeSeed {
  const resumption = computeSlabHomeAffordances(inputs.navigateEvents);
  const phase: HomeSeedPhase =
    resumption.length === 0 ? "invitation" : resumption.length <= 2 ? "mixed" : "resumption";

  const setupTiles: HomeTile[] = SETUP_TILES.filter((s) => !inputs.config[s.key]).map((s) => ({
    id: `setup-${s.key}`,
    layer: "setup",
    verb: s.verb,
    action: { kind: "open_setup", key: s.key },
    basis: { kind: "config", key: s.key, wired: false },
  }));

  // The intrinsic floor survives EVERY phase — "present at absolute
  // zero", and never crowded out by the record: one slot is reserved
  // for it before resumption fills. Only CONFIG-GATED capability
  // recedes as resumption dominates (`motebit-computer.md` §home
  // N-arc: "capability recedes to secondary").
  const intrinsicTiles: HomeTile[] = LAUNCHPADS.filter((lp) => lp.witness == null).map((lp) => ({
    id: lp.id,
    layer: "intrinsic" as const,
    verb: lp.verb,
    action: lp.action,
    basis: { kind: "identity" as const },
  }));

  const resumptionTiles: HomeTile[] = resumption
    .slice(0, Math.max(0, TILE_BUDGET - setupTiles.length - intrinsicTiles.length))
    .map((aff) => ({
      id: aff.id,
      layer: "resumption" as const,
      verb: "Continue",
      subject: aff.host,
      action: { kind: "navigate" as const, url: `${aff.scheme}://${aff.host}` },
      basis: { kind: "audit" as const, host: aff.host, lastEngagedAt: aff.lastEngagedAt },
    }));

  // Config-gated launchpads fill the remaining budget — and recede
  // entirely once the record dominates (phase === "resumption").
  let configGatedTiles: HomeTile[] = [];
  if (phase !== "resumption") {
    const remaining =
      TILE_BUDGET - setupTiles.length - intrinsicTiles.length - resumptionTiles.length;
    configGatedTiles = LAUNCHPADS.filter((lp) => lp.witness != null && inputs.config[lp.witness])
      .slice(0, Math.max(0, remaining))
      .map((lp) => ({
        id: lp.id,
        layer: "config_gated" as const,
        verb: lp.verb,
        action: lp.action,
        basis: { kind: "config" as const, key: lp.witness as HomeConfigKey, wired: true },
      }));
  }

  return {
    identity: inputs.identity,
    phase,
    tiles: [...resumptionTiles, ...intrinsicTiles, ...configGatedTiles, ...setupTiles],
    ingressMode: inputs.config.mind ? "ask_or_go" : "go_only",
  };
}
