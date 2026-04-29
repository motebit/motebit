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
  /** Hardware-attestation snapshot. Absent when the relay forwarded no claim. */
  hardware_attestation?: AgentHardwareAttestation;
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
    discoveredView,
    dispose,
  };
}

// Re-export the shared fetch-init type so AgentsFetchAdapter consumers can
// compose without importing from the sovereign module — panels/index.ts
// re-exports this from the sovereign controller.
export type { SovereignFetchInit };
