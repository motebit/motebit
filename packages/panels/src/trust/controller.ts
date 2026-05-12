// Surface-agnostic state controller for the Trust panel.
//
// The slash command `/trust` (in @motebit/runtime) is the discovery
// affordance — a one-screen summary that types into chat. This
// controller is the **dwell** affordance — the panel where users land
// when they want to read, scroll, scan, or return.
//
// Both views compute the same five dimensions over the same runtime
// accessors. The controller doesn't import the runtime — it inverts
// the dependency the same way every other panel controller in this
// package does, taking pure accessor functions through its adapter
// (see ./CLAUDE.md rule 2). Surfaces wire their runtime instance into
// the adapter; controllers stay Layer-5 pure.
//
// Five dimensions, three pillars:
//
//   - **Accumulation pillar** — what motebit holds
//       memories (semantic-memory graph nodes)
//       conversations (persisted dialogs)
//       receipts (signed ToolInvocationReceipts in the runtime's ring)
//   - **Governance pillar** — sovereignty made concrete
//       deletions (audit-log rows whose action signed a deletion cert)
//   - **Network pillar** — federation reach without exposing identities
//       peers (agents this motebit has accumulated trust records for)
//
// Web-only sixth dimension: persisted cookies for the cloud browser.
// Cookies are surface-locked by architecture (cloud-browser exists on
// web only); the adapter exposes `getPersistedCookies?` as optional and
// the state carries the result as `cookies: null` when absent.
//
// Doctrine: `docs/doctrine/runtime-invariants-over-prompt-rules.md` —
// trust-accumulation visibility arc. Phase 1 of the panel elevation
// follows Phase 1 (slash command) + Phase 2 (ambient pip in
// cobrowse-chrome) shipped 2026-05-12.

// ── Structural copies (Layer 5 isolation) ─────────────────────────────
//
// `@motebit/panels` is Layer 5; importing `@motebit/protocol` or
// `@motebit/runtime` directly would pull the panels package into a
// layering cycle. The shapes below mirror the upstream types just
// enough for the controller's logic to project state; surfaces pass
// the full upstream values through the adapter and the controller's
// shape compatibility is structural.

/**
 * A memory-graph node — only the fields the trust summary reads.
 * Mirrors `MemoryNode.sensitivity` from `@motebit/memory-graph`.
 */
export interface TrustMemoryNode {
  readonly node_id: string;
  /** Sensitivity tier — `"none" | "personal" | "medical" | "financial" | "secret"`. */
  readonly sensitivity?: string | null;
}

/**
 * A persisted conversation — only the field count matters at this layer.
 */
export interface TrustConversation {
  readonly id: string;
}

/**
 * A signed receipt — only the tool name is surfaced in detail. Mirrors
 * `SignableToolInvocationReceipt.tool_name`.
 */
export interface TrustReceipt {
  readonly tool_name: string;
}

/**
 * An audit-log row — `action` discriminates deletion rows from other
 * sovereignty events. Mirrors `AuditRecord.action`.
 */
export interface TrustAuditRecord {
  readonly action: string;
}

/**
 * A peer-trust record — `trust_level` lets the panel show the
 * level distribution alongside the bare count.
 */
export interface TrustPeerRecord {
  readonly remote_motebit_id?: string;
  readonly trust_level?: string;
}

/**
 * A persisted cloud-browser cookie — only the domain matters for the
 * summary. Mirrors `PersistentCookieWire.domain`.
 */
export interface TrustCookie {
  readonly domain: string;
}

// ── Adapter ───────────────────────────────────────────────────────────

export interface TrustFetchAdapter {
  /**
   * The semantic-memory graph for this motebit. Returns all live nodes
   * (the trust summary doesn't filter on decay state — the count is
   * "what motebit has stored," not "what's salient right now").
   */
  getMemoryNodes(): Promise<readonly TrustMemoryNode[]>;
  /**
   * Persisted conversations. Synchronous because the runtime's
   * conversation list is in-memory after bootstrap.
   */
  getConversations(): readonly TrustConversation[];
  /**
   * Signed receipts the runtime still holds. The ring buffer caps at
   * the runtime's configured size; the count is "what motebit can
   * still show," not "lifetime ever produced."
   */
  getRecentReceipts(): readonly TrustReceipt[];
  /**
   * Audit-log rows for this motebit. The controller filters for
   * deletion-class actions (`delete_*`, `flush_record`); other rows
   * are not surfaced at this layer.
   */
  getAuditRecords(): Promise<readonly TrustAuditRecord[]>;
  /**
   * Federation peers — agents the runtime has accumulated trust
   * records for. Returns `[]` when no agent-trust store is wired
   * (surfaces without federation infrastructure).
   */
  getTrustedAgents(): Promise<readonly TrustPeerRecord[]>;
  /**
   * Web-only: persisted cookies the cloud browser will replay on
   * future sessions. Omitted on surfaces without a cloud-browser
   * substrate (desktop, mobile, CLI). When present, the controller
   * surfaces a redacted summary (count + domains, no values).
   */
  getPersistedCookies?(): Promise<readonly TrustCookie[]>;
}

// ── State ─────────────────────────────────────────────────────────────

export interface TrustCookieSummary {
  readonly count: number;
  /** Distinct domains, leading dot stripped, sorted ascending. */
  readonly domains: readonly string[];
}

export interface TrustState {
  loading: boolean;
  error: string | null;
  /** Epoch milliseconds of the last successful refresh. `0` until first refresh succeeds. */
  fetchedAt: number;

  // Accumulation pillar
  memoryCount: number;
  conversationCount: number;
  receiptCount: number;

  // Governance pillar
  deletionCount: number;

  // Network pillar
  peerCount: number;

  // Detail breakdowns — calm-software shape: low-cardinality maps
  // surfaces can render as one-line summaries.
  /** Memory nodes grouped by sensitivity tier; tier → count. */
  memorySensitivity: ReadonlyMap<string, number>;
  /** Last N receipt tool names, oldest-first within the slice. Default N = 5. */
  recentReceiptToolNames: readonly string[];
  /** Deletion rows grouped by action (`delete_memory`, `delete_conversation`, `flush_record`). */
  deletionActions: ReadonlyMap<string, number>;
  /** Peers grouped by trust_level (`verified`, `discovered`, etc). Missing levels collapse to `"unknown"`. */
  peerTrustLevels: ReadonlyMap<string, number>;

  // Web-only sixth dimension. `null` when the adapter has no
  // `getPersistedCookies` method (i.e. surfaces without cloud browser).
  cookies: TrustCookieSummary | null;
}

function initialState(): TrustState {
  return {
    loading: false,
    error: null,
    fetchedAt: 0,
    memoryCount: 0,
    conversationCount: 0,
    receiptCount: 0,
    deletionCount: 0,
    peerCount: 0,
    memorySensitivity: new Map(),
    recentReceiptToolNames: [],
    deletionActions: new Map(),
    peerTrustLevels: new Map(),
    cookies: null,
  };
}

// ── Controller ────────────────────────────────────────────────────────

export interface TrustController {
  getState(): TrustState;
  subscribe(listener: (state: TrustState) => void): () => void;
  refresh(): Promise<void>;
  dispose(): void;
}

export interface TrustControllerOptions {
  /**
   * How many receipt tool names to surface in `recentReceiptToolNames`.
   * Default 5 — the slash command uses the same window so the panel and
   * the on-demand summary stay coherent.
   */
  readonly recentReceiptsWindow?: number;
}

export function createTrustController(
  adapter: TrustFetchAdapter,
  options: TrustControllerOptions = {},
): TrustController {
  const window = options.recentReceiptsWindow ?? 5;
  let state = initialState();
  const listeners = new Set<(s: TrustState) => void>();
  let disposed = false;

  function emit(): void {
    for (const l of listeners) l(state);
  }

  function update(patch: Partial<TrustState>): void {
    if (disposed) return;
    state = { ...state, ...patch };
    emit();
  }

  async function refresh(): Promise<void> {
    if (disposed) return;
    update({ loading: true, error: null });

    let memoryNodes: readonly TrustMemoryNode[];
    let auditRecords: readonly TrustAuditRecord[];
    let peers: readonly TrustPeerRecord[];
    let cookies: readonly TrustCookie[] | null = null;

    try {
      // Three concurrent async accessors; if any throws, the entire
      // refresh fails-soft and the prior state stays intact. Same
      // pattern as the retention controller's two-fetch coordination.
      const [nodesResult, auditResult, peersResult, cookiesResult] = await Promise.all([
        adapter.getMemoryNodes(),
        adapter.getAuditRecords(),
        adapter.getTrustedAgents(),
        adapter.getPersistedCookies ? adapter.getPersistedCookies() : Promise.resolve(null),
      ]);
      memoryNodes = nodesResult;
      auditRecords = auditResult;
      peers = peersResult;
      cookies = cookiesResult;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      update({ loading: false, error: `trust refresh failed: ${message}` });
      return;
    }

    const conversations = adapter.getConversations();
    const receipts = adapter.getRecentReceipts();

    update({
      loading: false,
      error: null,
      fetchedAt: Date.now(),
      memoryCount: memoryNodes.length,
      conversationCount: conversations.length,
      receiptCount: receipts.length,
      deletionCount: countDeletions(auditRecords),
      peerCount: peers.length,
      memorySensitivity: groupBySensitivity(memoryNodes),
      recentReceiptToolNames: receipts.slice(-window).map((r) => r.tool_name),
      deletionActions: groupByDeletionAction(auditRecords),
      peerTrustLevels: groupByTrustLevel(peers),
      cookies: summarizeCookies(cookies),
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
      disposed = true;
      listeners.clear();
    },
  };
}

// ── Pure projections ──────────────────────────────────────────────────

/**
 * Is this audit action a signed-deletion event? Three canonical forms:
 *
 *   - `delete_memory` — user_request delete on a memory node
 *   - `delete_conversation` — user_request delete on a conversation
 *   - `flush_record` — consolidation-cycle compaction
 *
 * Per `docs/doctrine/retention-policy.md`, each carries a signed
 * `DeletionCertificate`. Other audit actions (set_sensitivity,
 * skill_trust_grant, etc.) are NOT deletions and stay excluded.
 *
 * Exported for sibling test surfaces — the same predicate `cmdTrust`
 * uses, lifted here so both views agree on what counts as a deletion.
 */
export function isDeletionAction(action: string): boolean {
  return action.startsWith("delete_") || action === "flush_record";
}

function countDeletions(records: readonly TrustAuditRecord[]): number {
  let n = 0;
  for (const r of records) {
    if (isDeletionAction(r.action)) n++;
  }
  return n;
}

function groupBySensitivity(nodes: readonly TrustMemoryNode[]): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const n of nodes) {
    const tier = n.sensitivity != null && n.sensitivity !== "" ? n.sensitivity : "none";
    out.set(tier, (out.get(tier) ?? 0) + 1);
  }
  return out;
}

function groupByDeletionAction(records: readonly TrustAuditRecord[]): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const r of records) {
    if (!isDeletionAction(r.action)) continue;
    out.set(r.action, (out.get(r.action) ?? 0) + 1);
  }
  return out;
}

function groupByTrustLevel(peers: readonly TrustPeerRecord[]): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const p of peers) {
    const level = p.trust_level != null && p.trust_level !== "" ? p.trust_level : "unknown";
    out.set(level, (out.get(level) ?? 0) + 1);
  }
  return out;
}

function summarizeCookies(cookies: readonly TrustCookie[] | null): TrustCookieSummary | null {
  if (cookies === null) return null;
  const domains = new Set<string>();
  for (const c of cookies) {
    // Strip leading dot — `.google.com` displays as `google.com`. The
    // sovereign-floor invariant is preserved upstream by the adapter
    // (each motebit's cookie store is keyed by motebit_id), so the
    // summary is automatically scoped.
    domains.add(c.domain.replace(/^\./, ""));
  }
  return {
    count: cookies.length,
    domains: [...domains].sort(),
  };
}
