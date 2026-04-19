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
 * An agent the local motebit has interacted with before. The shape mirrors
 * the relay's `/api/v1/agents/{id}/trusted` response and the runtime's
 * `listTrustedAgents()` return type.
 */
export interface AgentRecord {
  remote_motebit_id: string;
  trust_level: TrustLevel | string;
  first_seen_at: number;
  last_seen_at: number;
  interaction_count: number;
  successful_tasks?: number;
  failed_tasks?: number;
  notes?: string;
}

/**
 * An agent surfaced by the relay's `/api/v1/agents/discover` endpoint.
 * Contains everything needed to rank (pricing, trust, interactions,
 * freshness) and to delegate (motebit_id, capabilities).
 */
export interface DiscoveredAgent {
  motebit_id: string;
  capabilities: string[];
  trust_level?: TrustLevel | string;
  interaction_count?: number;
  pricing?: PricingEntry[] | null;
  last_seen_at?: number;
  endpoint_url?: string;
  freshness?: AgentFreshness;
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
