// Surface-agnostic state controller for the Agents panel.
//
// Two tabs (known, discover) share state + fetch across desktop, web, and
// mobile. Lifted out of three independent implementations so the pricing
// vocabulary, freshness palette, sort semantics, and capability filter are
// defined in one place. Render stays surface-specific.

import type { SovereignFetchInit } from "../sovereign/controller";

// ── Vocabulary ────────────────────────────────────────────────────────

/**
 * The known trust-level values the relay will return. A catch-all string is
 * allowed so an unexpected value from an upgraded relay degrades gracefully
 * (it renders as `unknown` in the badge palette rather than crashing).
 */
export type TrustLevel = "unknown" | "first_contact" | "verified" | "trusted" | "blocked";

/**
 * Liveness hint attached to each discovered agent. Never a filter input —
 * a `dormant` or `cold` agent still gets delegated to, they just wake with
 * some latency. Calm-software doctrine: surfaces display these as muted
 * informational cues, never warnings.
 */
export type AgentFreshness = "awake" | "recently_seen" | "dormant" | "cold";

/**
 * Price entry for a capability the agent advertises. `unit_cost` is in the
 * declared `currency` (USD today, per the money-model doctrine) expressed in
 * dollars, not micro-units — the wire shape at this boundary is the relay's
 * public pricing readout, which stays in dollars.
 */
export interface PricingEntry {
  capability: string;
  unit_cost: number;
  currency: string;
  per: string;
}

// ── Response shapes ───────────────────────────────────────────────────

/**
 * Hardware-attestation surface a peer's identity key was minted on. Mirrors
 * `HardwareAttestationClaim.platform` from `@motebit/protocol` exactly so a
 * downgrade to the protocol-level value is one cast. `software` is the
 * explicit "no hardware-backed key" sentinel; absence of `hw_platform`
 * means "no claim received from this agent" (also software-equivalent for
 * scoring, but display-wise rendered as "—").
 *
 * Names are inlined per the panels CLAUDE.md rule 2 (no @motebit/protocol
 * imports). Drift between this union and the protocol's
 * `HardwareAttestationClaim["platform"]` would surface at the relay-wire
 * boundary, where the AgentsFetchAdapter populates the field.
 */
export type AgentHardwarePlatform =
  | "secure_enclave"
  | "tpm"
  | "play_integrity"
  | "android_keystore"
  | "device_check"
  | "webauthn"
  | "software";

/**
 * Hardware-attestation snapshot per agent row. Non-null iff the relay
 * forwarded a verified `HardwareAttestationClaim` from the agent's most
 * recent `TrustCredential` (`spec/credential-v1.md` §3.4). Surfaces render
 * a per-row "hardware-attested" badge from this; absence shows "—".
 *
 * `score` is precomputed by the controller (or the adapter) so surfaces
 * never need to import `@motebit/semiring`. Range [0, 1] per
 * `HardwareAttestationSemiring` (`packages/semiring/src/hardware-attestation.ts`).
 *
 * Per `docs/doctrine/self-attesting-system.md`: every routing-input claim
 * MUST be visible to the user. HA factored into peer ranking silently
 * before this; the badge closes the gap.
 */
export interface AgentHardwareAttestation {
  /** Attestation surface. `software` is the explicit "no hardware key" sentinel. */
  platform: AgentHardwarePlatform;
  /** True when the private key was exported from hardware (weakens the claim). */
  key_exported?: boolean;
  /**
   * Score in [0, 1] under `HardwareAttestationSemiring`. Surfaces sort or
   * tie-break on this; the score is also surfaced via the badge tooltip so
   * a user can verify "why did motebit prefer that peer" — the
   * doctrine-completeness probe this gap was deferred for.
   */
  score: number;
}

/**
 * Observed-latency snapshot per agent row. Non-null when the runtime's
 * `LatencyStatsStore` (or the relay's `relay_latency_stats` table) has
 * one or more samples for this peer. Surfaces render a per-row latency
 * readout from this; absence shows "—".
 *
 * Same drift contract as `AgentHardwareAttestation`: this shape MUST
 * stay byte-aligned with `AgentTrustRecord["latency_stats"]` in
 * `@motebit/protocol` and with the relay's enricher output. Field
 * names match `task-routing.ts` and `listings.ts` wire vocabulary
 * (`avg_ms` / `p95_ms` / `sample_count`).
 *
 * Per `docs/doctrine/self-attesting-system.md`: every routing-input
 * claim MUST be visible to the user. Latency factors into peer ranking
 * via `agent-graph.ts` (default 3000ms when stats are absent); the
 * latency readout closes the gap.
 */
export interface AgentLatencyStats {
  /** Mean of the most-recent N samples, in milliseconds. */
  avg_ms: number;
  /** 95th-percentile of the most-recent N samples, in milliseconds. */
  p95_ms: number;
  /** Number of samples in the rolling window. */
  sample_count: number;
}

/**
 * An agent the local motebit has interacted with before. The shape mirrors
 * the relay's `/api/v1/agents/{id}/trusted` response and the runtime's
 * `listTrustedAgents()` return type.
 */
export interface AgentRecord {
  remote_motebit_id: string;
  // `(string & {})` opens the literal union to forward-compat values
  // without collapsing autocomplete — idiomatic TS pattern.
  trust_level: TrustLevel | (string & {});
  first_seen_at: number;
  last_seen_at: number;
  interaction_count: number;
  successful_tasks?: number;
  failed_tasks?: number;
  notes?: string;
  /**
   * First-person local nickname for this peer (Known tab only). Naming is
   * first-person — doctrine `agents-as-first-person-trust-graph.md` §3 — so it
   * exists only for agents you've met and named; absent ⇒ show the short id.
   */
  petname?: string;
  /** Hardware-attestation snapshot. Absent when the relay forwarded no claim. */
  hardware_attestation?: AgentHardwareAttestation;
  /** Observed-latency snapshot. Absent when the local store has zero samples. */
  latency_stats?: AgentLatencyStats;
}

/**
 * An agent surfaced by the relay's `/api/v1/agents/discover` endpoint.
 * Contains everything needed to rank (pricing, trust, interactions,
 * freshness) and to delegate (motebit_id, capabilities).
 */
export interface DiscoveredAgent {
  motebit_id: string;
  capabilities: string[];
  trust_level?: TrustLevel | (string & {});
  interaction_count?: number;
  pricing?: PricingEntry[] | null;
  last_seen_at?: number;
  endpoint_url?: string;
  freshness?: AgentFreshness;
  /** Hardware-attestation snapshot. Absent when the relay forwarded no claim. */
  hardware_attestation?: AgentHardwareAttestation;
  /** Observed-latency snapshot. Absent when the relay has zero samples for this agent. */
  latency_stats?: AgentLatencyStats;
  /**
   * Self-asserted display name — a discovery-time CLAIM
   * (agents-as-first-person-trust-graph §3): squattable, unverified, never
   * an identity. Render via `formatNameClaim`; the sigil + id row stays the
   * identity. Server caps at 64 chars; clamp client-side too — federated
   * peers don't cap.
   */
  display_name?: string | null;
  /** Listing description — self-authored copy from the agent's service listing (≤200 chars server-side). */
  description?: string | null;
}

/**
 * Claim framing for a discovered agent's self-asserted name (trust-graph
 * doctrine §3): Discover shows `claims "The Researcher"` — the name is a
 * claim, never a verified handle; the derived sigil + id remain the
 * identity. Shared across the three surfaces so the epistemic register
 * cannot drift per-renderer. Client-side clamp included (federated peers
 * don't cap).
 */
export function formatNameClaim(name: string): string {
  const clamped = name.trim().slice(0, 64);
  return `claims “${clamped}”`;
}

/**
 * Pure scoring helper — accepts the wire-level `platform` + optional
 * `key_exported` flag and returns the [0, 1] score under
 * `HardwareAttestationSemiring`. Inlined here (rather than imported from
 * `@motebit/semiring`) for the same reason `AgentHardwarePlatform` is
 * inlined: panels package stays at zero internal deps. The adapter
 * imports the canonical implementation; this helper exists for surfaces
 * that have a raw claim and want a score without hitting the relay.
 *
 * Drift defense: the four constants below MUST stay byte-aligned with
 * `packages/semiring/src/hardware-attestation.ts` HW_ATTESTATION_*. A
 * sibling-boundary audit on any change to either side.
 */
export function scoreHardwareAttestation(
  platform: AgentHardwarePlatform | undefined,
  keyExported?: boolean,
): number {
  if (platform === undefined) return 0; // HW_ATTESTATION_NONE
  switch (platform) {
    case "secure_enclave":
    case "tpm":
    case "device_check":
    case "play_integrity":
    case "android_keystore":
    case "webauthn":
      return keyExported === true ? 0.5 : 1; // HW_ATTESTATION_HARDWARE_EXPORTED / HARDWARE
    case "software":
      return 0.1; // HW_ATTESTATION_SOFTWARE
  }
}

/**
 * Display label for an attestation platform. Names match the platforms
 * users actually understand on each surface ("Secure Enclave", not
 * "secure_enclave"); the verbatim doctrine-anchored term
 * "hardware-attested" is the badge text, this is the verifier name shown
 * inside the tooltip.
 */
export function formatHardwarePlatform(platform: AgentHardwarePlatform): string {
  switch (platform) {
    case "secure_enclave":
      return "Secure Enclave";
    case "tpm":
      return "TPM";
    case "play_integrity":
      return "Play Integrity";
    case "android_keystore":
      return "Android Keystore";
    case "device_check":
      return "DeviceCheck";
    case "webauthn":
      return "WebAuthn";
    case "software":
      return "software";
  }
}

/**
 * Concise display string for a latency snapshot. Returns the avg in
 * milliseconds, plus the p95 ONLY when the tail diverges meaningfully
 * (>20% above avg) — calm-software doctrine: render the noise that's
 * actually informative, suppress the noise that isn't. Avg <1000ms
 * stays in `ms`; >=1000ms switches to `s` with one decimal.
 *
 * Edge cases:
 *   - `avg_ms === 0` → renders as "—" (defensive: zero would only
 *     appear with a malformed sample window; surfaces should treat it
 *     as no-data rather than imply an instant response).
 *   - `sample_count === 0` → caller should render "—" instead of
 *     calling this helper. The helper assumes ≥1 sample.
 *
 * Examples:
 *   { avg_ms: 342, p95_ms: 380, sample_count: 12 } → "342ms"
 *   { avg_ms: 342, p95_ms: 1200, sample_count: 12 } → "342ms · p95 1.2s"
 *   { avg_ms: 1500, p95_ms: 1700, sample_count: 5 } → "1.5s"
 *   { avg_ms: 0, p95_ms: 0, sample_count: 1 } → "—"
 */
export function formatLatency(stats: AgentLatencyStats): string {
  if (stats.avg_ms === 0) return "—";
  const fmt = (ms: number): string =>
    ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
  const tailDiverges = stats.p95_ms > stats.avg_ms * 1.2;
  return tailDiverges ? `${fmt(stats.avg_ms)} · p95 ${fmt(stats.p95_ms)}` : fmt(stats.avg_ms);
}

// ── Identity display ──────────────────────────────────────────────────

/**
 * Compact, scannable form of a `motebit_id` (a UUID) for display in place of
 * the full string — head…tail, the wallet convention. The full id stays
 * available for copy/verify; this is the at-a-glance handle. Distinct from
 * `shortFingerprint` in `@motebit/sdk`, which shortens the 64-hex public key —
 * here we shorten the id the user already sees in the panel.
 */
export function shortMotebitId(id: string, head = 8, tail = 6): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}

/**
 * The at-a-glance display label for an agent: its first-person petname when set
 * (Known tab only — naming is first-person, doctrine
 * `agents-as-first-person-trust-graph.md` §3), otherwise the short motebit_id.
 * The identity sigil (from `public_key`) and the full id carry the verifiable
 * identity; this is the human-readable handle that sits beside them. Accepts
 * either record shape (`remote_motebit_id` for Known, `motebit_id` for Discover).
 */
export function agentDisplayLabel(agent: {
  motebit_id?: string;
  remote_motebit_id?: string;
  petname?: string;
}): string {
  const id = agent.remote_motebit_id ?? agent.motebit_id ?? "";
  return agent.petname != null && agent.petname.length > 0 ? agent.petname : shortMotebitId(id);
}

/**
 * Trust-aura class token for a Known agent's mark, reflecting your FIRST-PERSON
 * trust with them — a ring/glow that *wraps* the identity mark, never recolors
 * its core. The core is universal (same everywhere); the aura is local (varies
 * per viewer by relationship). Doctrine `agents-as-first-person-trust-graph.md`
 * §1 (trust is first-person) + §4 (mark core is stable).
 *
 * Honest by default: nothing below `verified` — first contact has earned no glow.
 * `blocked` is a muted treatment, never an alarm (calm software). Known only —
 * a Discover agent's `trust_level` is the relay's claim, not your earned trust,
 * so it must get no aura. Surfaces map the token to their own ring/glow CSS.
 */
export function trustAuraClass(trustLevel: string): string {
  switch (trustLevel) {
    case "verified":
      return "agent-trust-verified";
    case "trusted":
      return "agent-trust-trusted";
    case "blocked":
      return "agent-trust-blocked";
    default:
      return ""; // unknown / first_contact ⇒ no aura (no glow without earned trust)
  }
}

// ── Economic projection ───────────────────────────────────────────────
//
// The money side of the first-person trust graph
// (docs/doctrine/agents-as-first-person-trust-graph.md §6). What *I* earned
// from / paid to each peer, derived by the relay from its signed settlement
// ledger and fetched as a verified `settlement-summary` export. This is a
// **projection**, held separately from `AgentRecord` and looked up by id at
// render time — never a denormalized balance on the trust record. Money in
// integer micro-units (the panels layer never imports @motebit/protocol, so
// the shape is inlined; it mirrors `SettlementSummaryExport`).

const MICRO_PER_UNIT = 1_000_000;

/** Per-counterparty economic history with the calling motebit. */
export interface AgentPeerEconomics {
  peer_id: string;
  /** Micro-units I earned from this peer (I was the worker/payee). */
  earned_micro: number;
  /** Micro-units I paid to this peer (I was the delegator/payer). */
  paid_micro: number;
  /** `earned_micro - paid_micro`; negative ⇒ net payer to this peer. */
  net_micro: number;
  /** Platform fee (micro) I paid as the funder on legs with this peer. */
  fee_micro: number;
  settled_count: number;
  p2p_count: number;
  first_at: number;
  last_at: number;
}

/** Settlements with no attributable counterparty (legacy / pre-attribution rows). */
export interface AgentEconomicUnattributed {
  earned_micro: number;
  fee_micro: number;
  settled_count: number;
}

/**
 * The caller's whole first-person economic summary — surface-agnostic
 * view-model mirroring the relay's `settlement-summary` export. Held as one
 * object in panel state; the render looks up each Known peer's slice by id.
 */
export interface AgentEconomicSummary {
  motebit_id: string;
  peers: AgentPeerEconomics[];
  unattributed: AgentEconomicUnattributed;
}

/** The economic slice for one peer, or undefined when there's no history. */
export function economicForPeer(
  summary: AgentEconomicSummary | null,
  peerId: string,
): AgentPeerEconomics | undefined {
  return summary?.peers.find((p) => p.peer_id === peerId);
}

/**
 * Calm money line for a peer — net signed dollars + a settlement count.
 * Returns `null` when there is no settled history (the render shows nothing,
 * or an honest "no settled work yet" — never a fabricated $0 that implies
 * activity). Dollars are display-only (micro → fixed-2); the money PATH
 * stays in integer micro-units upstream.
 *
 * Examples:
 *   { net_micro: 2_500_000, settled_count: 3 } → "net +$2.50 · 3 settlements"
 *   { net_micro: -500_000, settled_count: 1 }  → "net -$0.50 · 1 settlement"
 */
export function formatPeerEconomics(e: AgentPeerEconomics | undefined): string | null {
  if (e == null || e.settled_count === 0) return null;
  const net = e.net_micro / MICRO_PER_UNIT;
  const sign = net > 0 ? "+" : net < 0 ? "-" : "";
  const abs = Math.abs(net).toFixed(2);
  const count = e.settled_count === 1 ? "1 settlement" : `${e.settled_count} settlements`;
  return `net ${sign}$${abs} · ${count}`;
}

// ── Adapter ──────────────────────────────────────────────────────────

/**
 * Each surface implements this so the controller can fetch known + discovered
 * agents without knowing about Tauri config, IndexedDB, AsyncStorage, or the
 * specific auth token format.
 *
 * `listTrustedAgents` and `discoverAgents` are adapter-provided because the
 * two operations legitimately differ per platform:
 * - `listTrustedAgents` hits the local runtime/DB (zero relay round-trip).
 * - `discoverAgents` hits the relay's discover endpoint, which two surfaces
 *   wrap through the app's sync layer (for auth + caching) and one surface
 *   (web) inlines as a plain fetch. The adapter hides both paths behind one
 *   signature.
 */
export interface AgentsFetchAdapter {
  readonly syncUrl: string | null;
  readonly motebitId: string | null;
  listTrustedAgents(): Promise<AgentRecord[]>;
  discoverAgents(): Promise<DiscoveredAgent[]>;
  /**
   * Set or clear the first-person local petname for a Known peer. Optional: a
   * surface that doesn't offer petname editing omits it (the controller's
   * `setPetname` no-ops then). Local-only — the host wires it to the runtime's
   * `setAgentPetname`; never a relay/global write. Pass `undefined` to clear.
   */
  setPetname?(remoteMotebitId: string, petname: string | undefined): Promise<void>;
  /**
   * Fetch the caller's first-person economic summary (per-peer earned / paid
   * / net, derived from the relay's signed settlement ledger). Optional: a
   * surface that hasn't wired it omits it (the controller's `refreshEconomic`
   * no-ops, and no money line renders). The host implements it over
   * `verifiedSettlementSummaryFetch` from `@motebit/state-export-client` so
   * the response is verified against the relay's pinned key before it reaches
   * the panel. Returns `null` when there's nothing to show (or verification
   * failed — fail-closed, the panel renders the mark + trust without money).
   */
  listSettlementSummary?(): Promise<AgentEconomicSummary | null>;
}

// ── Sort + filter (derived view) ──────────────────────────────────────

/**
 * Sort modes for the Discover tab. `recent` is the default — new agents or
 * recently-heartbeating ones should be visible first. Price sorts bubble
 * priced capabilities up or down; unpriced agents always sort last.
 */
export type SortKey = "recent" | "price-asc" | "price-desc" | "trust" | "interactions";

const TRUST_RANK: Record<string, number> = {
  blocked: -1,
  unknown: 0,
  first_contact: 1,
  verified: 2,
  trusted: 3,
};

function minPrice(agent: DiscoveredAgent): number {
  if (!Array.isArray(agent.pricing) || agent.pricing.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  let best = Number.POSITIVE_INFINITY;
  for (const p of agent.pricing) {
    if (typeof p.unit_cost === "number" && p.unit_cost < best) best = p.unit_cost;
  }
  return best;
}

/**
 * Unique capabilities across all discovered agents, sorted alphabetically.
 * Surfaces use this to build their capability filter dropdown (desktop does
 * today; mobile and web can adopt the same filter once it lands in their
 * render).
 */
export function collectCapabilities(agents: readonly DiscoveredAgent[]): string[] {
  const set = new Set<string>();
  for (const a of agents) {
    for (const c of a.capabilities) set.add(c);
  }
  return [...set].sort();
}

/**
 * Apply the controller's sort + filter to a discovered-agent list. Exported
 * so surfaces can compute the filtered view on demand from `state.discovered`
 * without the controller allocating a fresh array on every subscription tick.
 */
export function applySortFilter(
  agents: readonly DiscoveredAgent[],
  sort: SortKey,
  capFilter: string,
): DiscoveredAgent[] {
  const filtered =
    capFilter === "" ? agents.slice() : agents.filter((a) => a.capabilities.includes(capFilter));

  switch (sort) {
    case "price-asc":
      filtered.sort((a, b) => minPrice(a) - minPrice(b));
      break;
    case "price-desc":
      filtered.sort((a, b) => {
        const pa = minPrice(a);
        const pb = minPrice(b);
        // Unpriced agents sort last in both directions — they're not
        // directly comparable on cost.
        if (pa === Number.POSITIVE_INFINITY && pb === Number.POSITIVE_INFINITY) return 0;
        if (pa === Number.POSITIVE_INFINITY) return 1;
        if (pb === Number.POSITIVE_INFINITY) return -1;
        return pb - pa;
      });
      break;
    case "trust":
      filtered.sort(
        (a, b) =>
          (TRUST_RANK[b.trust_level ?? "unknown"] ?? 0) -
          (TRUST_RANK[a.trust_level ?? "unknown"] ?? 0),
      );
      break;
    case "interactions":
      filtered.sort((a, b) => (b.interaction_count ?? 0) - (a.interaction_count ?? 0));
      break;
    case "recent":
    default:
      filtered.sort((a, b) => (b.last_seen_at ?? 0) - (a.last_seen_at ?? 0));
      break;
  }
  return filtered;
}

// ── State ─────────────────────────────────────────────────────────────

export type AgentsTab = "known" | "discover";

export interface AgentsState {
  activeTab: AgentsTab;
  known: AgentRecord[];
  discovered: DiscoveredAgent[];
  sort: SortKey;
  /** "" = all capabilities. */
  capabilityFilter: string;
  loading: boolean;
  error: string | null;
  /**
   * First-person economic summary (per-peer earned/paid/net). Held separately
   * from `known` — a projection looked up by peer id at render, never merged
   * onto the trust record. `null` until fetched, on adapter-unsupported, or on
   * a verification/fetch failure (fail-closed: the money line just doesn't show).
   */
  economic: AgentEconomicSummary | null;
}

function initialState(): AgentsState {
  return {
    activeTab: "known",
    known: [],
    discovered: [],
    sort: "recent",
    capabilityFilter: "",
    loading: false,
    error: null,
    economic: null,
  };
}

// ── Controller ────────────────────────────────────────────────────────

export interface AgentsController {
  getState(): AgentsState;
  subscribe(listener: (state: AgentsState) => void): () => void;
  setActiveTab(tab: AgentsTab): void;
  setSort(sort: SortKey): void;
  setCapabilityFilter(filter: string): void;
  refreshKnown(): Promise<void>;
  refreshDiscover(): Promise<void>;
  /**
   * Set or clear a Known peer's first-person petname, then refresh. No-ops if the
   * adapter doesn't support it. Local record edit — never a global/relay name.
   */
  setPetname(remoteMotebitId: string, petname: string | undefined): Promise<void>;
  /**
   * Fetch the first-person economic summary and patch it into state. No-ops if
   * the adapter doesn't support it. Fail-soft: a fetch/verification failure
   * leaves `economic` unchanged (the mark + trust still render); it never
   * surfaces an error banner — money legibility is additive, not load-bearing.
   */
  refreshEconomic(): Promise<void>;
  /** Derived view — discovered agents with sort + filter applied. */
  discoveredView(): DiscoveredAgent[];
  dispose(): void;
}

export function createAgentsController(adapter: AgentsFetchAdapter): AgentsController {
  let state = initialState();
  const listeners = new Set<(state: AgentsState) => void>();
  let disposed = false;

  function emit(next: AgentsState): void {
    state = next;
    for (const listener of listeners) listener(state);
  }

  function patch(partial: Partial<AgentsState>): void {
    if (disposed) return;
    emit({ ...state, ...partial });
  }

  async function refreshKnown(): Promise<void> {
    if (disposed) return;
    patch({ loading: true, error: null });
    try {
      const records = await adapter.listTrustedAgents();
      if (disposed) return;
      // Sort by most recently seen — the default the UI wants without a
      // sort dropdown on the Known tab.
      const sorted = records.slice().sort((a, b) => b.last_seen_at - a.last_seen_at);
      patch({ known: sorted, loading: false });
    } catch (err) {
      if (disposed) return;
      patch({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function refreshDiscover(): Promise<void> {
    if (disposed) return;
    patch({ loading: true, error: null });
    try {
      const discovered = await adapter.discoverAgents();
      if (disposed) return;
      patch({ discovered, loading: false });
    } catch (err) {
      if (disposed) return;
      patch({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function setActiveTab(tab: AgentsTab): void {
    if (state.activeTab === tab) return;
    patch({ activeTab: tab });
  }

  function setSort(sort: SortKey): void {
    if (state.sort === sort) return;
    patch({ sort });
  }

  function setCapabilityFilter(filter: string): void {
    if (state.capabilityFilter === filter) return;
    patch({ capabilityFilter: filter });
  }

  async function setPetname(remoteMotebitId: string, petname: string | undefined): Promise<void> {
    if (disposed || adapter.setPetname == null) return;
    const trimmed = petname?.trim();
    await adapter.setPetname(
      remoteMotebitId,
      trimmed != null && trimmed.length > 0 ? trimmed : undefined,
    );
    if (disposed) return;
    await refreshKnown();
  }

  async function refreshEconomic(): Promise<void> {
    if (disposed || adapter.listSettlementSummary == null) return;
    try {
      const summary = await adapter.listSettlementSummary();
      if (disposed) return;
      patch({ economic: summary });
    } catch {
      // Fail-soft: money legibility is additive. Leave the prior `economic`
      // in place (or null) and let the mark + trust render unaffected. No
      // error banner — a settlement-export hiccup is not a panel failure.
    }
  }

  function discoveredView(): DiscoveredAgent[] {
    return applySortFilter(state.discovered, state.sort, state.capabilityFilter);
  }

  function subscribe(listener: (state: AgentsState) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getState(): AgentsState {
    return state;
  }

  function dispose(): void {
    disposed = true;
    listeners.clear();
  }

  return {
    getState,
    subscribe,
    setActiveTab,
    setSort,
    setCapabilityFilter,
    refreshKnown,
    refreshDiscover,
    setPetname,
    refreshEconomic,
    discoveredView,
    dispose,
  };
}

// Re-export the shared fetch-init type so AgentsFetchAdapter consumers can
// compose without importing from the sovereign module — panels/index.ts
// re-exports this from the sovereign controller.
export type { SovereignFetchInit };
