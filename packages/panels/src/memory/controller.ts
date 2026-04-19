// Surface-agnostic state controller for the Memory panel.
//
// Memory shows up in three surfaces (desktop graph+list+deletions,
// mobile list, web list) with the same underlying runtime API
// (`listMemories` / `deleteMemory` / `pinMemory` / `getDecayedConfidence`)
// and the same filtering semantics (search, audit flags, tombstone exclusion,
// sensitivity floor). Render — canvas force-graph, DOM list, RN FlatList —
// stays surface-specific. The controller lifts the state and the three
// divergences the extraction uncovered:
//
//  1. Sensitivity filter: web silently hides medical/financial/secret;
//     desktop/mobile show them all. Now an explicit `sensitivityFilter`
//     option the surface declares, not a silent divergence.
//  2. Decayed confidence: web rendered raw `node.confidence`; desktop/mobile
//     rendered `getDecayedConfidence(node)`. Adapter supplies the decay
//     function; all three render the same value.
//  3. Tombstone + valid_until filtering: web checked explicitly; desktop/
//     mobile trusted the runtime. Controller applies the same guard
//     everywhere so a buggy runtime doesn't leak tombstoned rows to one
//     surface and not another.

// ── MemoryNode shape (minimal, no @motebit/sdk import) ────────────────
//
// The controller never constructs MemoryNodes — it only reads + filters
// what the adapter returns. A structural type lets surfaces pass their
// own (potentially richer) MemoryNode through without the panels package
// depending on @motebit/sdk and thereby pulling it out of Layer 5.

export interface MemoryNode {
  node_id: string;
  content: string;
  confidence: number;
  /** "none" | "personal" | "medical" | "financial" | "secret". Left open for forward compatibility. */
  sensitivity: string;
  created_at: number;
  last_accessed: number;
  half_life: number;
  tombstoned: boolean;
  pinned: boolean;
  valid_until?: number | null;
}

/**
 * Opaque deletion-certificate shape. Each runtime produces a different
 * certificate (desktop's @motebit/encryption cert carries target_type +
 * deleted_at + signature + tombstone_hash; mobile surfaces nothing; web
 * surfaces nothing today). The panel controller stores + returns the cert
 * without inspecting it; surfaces cast to their runtime's concrete type
 * before rendering.
 */
export type DeletionCertificate = Record<string, unknown>;

// ── Adapter ──────────────────────────────────────────────────────────

export interface MemoryFetchAdapter {
  listMemories(): Promise<MemoryNode[]>;
  deleteMemory(nodeId: string): Promise<DeletionCertificate | null>;
  /**
   * Toggle pin state. Surfaces that don't expose pinning can supply a
   * no-op; `setActivePinSupport: false` in options would be cleaner but
   * this way surfaces discover at runtime without plumbing capability.
   */
  pinMemory(nodeId: string, pinned: boolean): Promise<void>;
  /**
   * Synchronous decay math. Canonicalizing here closes the drift where
   * web rendered raw confidence and desktop/mobile rendered decayed.
   */
  getDecayedConfidence(node: MemoryNode): number;
}

// ── Options ──────────────────────────────────────────────────────────

/**
 * Sensitivity floor for the display. Web defaults to ["none", "personal"]
 * to match the CLI export convention (sensitive memories stay in the
 * database but don't surface in the UI). Desktop and mobile default to all
 * five — the user is looking at their own memories on their own device,
 * the sensitivity taxonomy is informational not fail-closed.
 *
 * This is an explicit config now, not a silent per-surface divergence.
 */
export interface MemoryControllerOptions {
  /** Default: undefined = all sensitivities visible. */
  sensitivityFilter?: ReadonlyArray<string>;
}

// ── State ────────────────────────────────────────────────────────────

export interface MemoryState {
  memories: MemoryNode[];
  search: string;
  auditFlags: Map<string, string>;
  loading: boolean;
  error: string | null;
  /**
   * Set transiently after `deleteMemory()` returns a certificate — surfaces
   * can read this to flash a "cert: abc123..." confirmation before the next
   * refresh clears it.
   */
  lastDeletionCert: DeletionCertificate | null;
}

function initialState(): MemoryState {
  return {
    memories: [],
    search: "",
    auditFlags: new Map(),
    loading: false,
    error: null,
    lastDeletionCert: null,
  };
}

// ── Derived-view filter (pure, exported for test + direct surface use) ─

/**
 * Apply the memory panel's display filters in order:
 *   1. Drop tombstoned nodes.
 *   2. Drop nodes past their `valid_until` (privacy-retention expiry).
 *   3. If a sensitivity filter is set, drop nodes outside it.
 *   4. Apply the search query (content substring, case-insensitive).
 *   5. Sort: pinned first; within each group, audit-flagged first (if any),
 *      then newest created_at.
 *
 * Exported so a renderer can compute the filtered list once per
 * subscription tick without the controller allocating on every read.
 */
export function filterMemoriesView(
  memories: readonly MemoryNode[],
  options: {
    search: string;
    auditFlags: Map<string, string>;
    sensitivityFilter?: ReadonlyArray<string>;
    now?: number;
  },
): MemoryNode[] {
  const { search, auditFlags, sensitivityFilter, now = Date.now() } = options;
  const query = search.trim().toLowerCase();
  const sensitivitySet = sensitivityFilter ? new Set(sensitivityFilter) : null;

  const filtered: MemoryNode[] = [];
  for (const m of memories) {
    if (m.tombstoned) continue;
    if (m.valid_until != null && m.valid_until <= now) continue;
    // null and undefined both mean "no expiry"
    if (sensitivitySet && !sensitivitySet.has(m.sensitivity)) continue;
    if (query !== "" && !m.content.toLowerCase().includes(query)) continue;
    filtered.push(m);
  }

  const auditSort =
    auditFlags.size > 0
      ? (a: MemoryNode, b: MemoryNode): number => {
          const aFlag = auditFlags.has(a.node_id) ? 0 : 1;
          const bFlag = auditFlags.has(b.node_id) ? 0 : 1;
          if (aFlag !== bFlag) return aFlag - bFlag;
          return b.created_at - a.created_at;
        }
      : (a: MemoryNode, b: MemoryNode): number => b.created_at - a.created_at;

  // Pinned first, then everything else. Within each bucket: audit sort.
  const pinned: MemoryNode[] = [];
  const unpinned: MemoryNode[] = [];
  for (const m of filtered) {
    if (m.pinned) pinned.push(m);
    else unpinned.push(m);
  }
  pinned.sort(auditSort);
  unpinned.sort(auditSort);
  return [...pinned, ...unpinned];
}

// ── Controller ────────────────────────────────────────────────────────

export interface MemoryController {
  getState(): MemoryState;
  subscribe(listener: (state: MemoryState) => void): () => void;
  refresh(): Promise<void>;
  setSearch(q: string): void;
  setAuditFlags(flags: Map<string, string>): void;
  clearAuditFlags(): void;
  deleteMemory(nodeId: string): Promise<DeletionCertificate | null>;
  pinMemory(nodeId: string, pinned: boolean): Promise<void>;
  /** Derived view — filtered + sorted memories per the display rules. */
  filteredView(): MemoryNode[];
  /** Pass-through to the adapter's decay function (so callers don't juggle both). */
  getDecayedConfidence(node: MemoryNode): number;
  dispose(): void;
}

export function createMemoryController(
  adapter: MemoryFetchAdapter,
  options: MemoryControllerOptions = {},
): MemoryController {
  let state = initialState();
  const listeners = new Set<(state: MemoryState) => void>();
  let disposed = false;

  function emit(next: MemoryState): void {
    state = next;
    for (const listener of listeners) listener(state);
  }

  function patch(partial: Partial<MemoryState>): void {
    if (disposed) return;
    emit({ ...state, ...partial });
  }

  async function refresh(): Promise<void> {
    if (disposed) return;
    patch({ loading: true, error: null });
    try {
      const memories = await adapter.listMemories();
      if (disposed) return;
      patch({ memories, loading: false });
    } catch (err) {
      if (disposed) return;
      patch({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function setSearch(q: string): void {
    if (state.search === q) return;
    patch({ search: q });
  }

  function setAuditFlags(flags: Map<string, string>): void {
    patch({ auditFlags: flags });
  }

  function clearAuditFlags(): void {
    if (state.auditFlags.size === 0) return;
    patch({ auditFlags: new Map() });
  }

  async function deleteMemory(nodeId: string): Promise<DeletionCertificate | null> {
    try {
      const cert = await adapter.deleteMemory(nodeId);
      if (disposed) return cert;
      // Optimistically remove from the in-memory list so the render doesn't
      // briefly show the stale row. The next refresh is the authoritative
      // read; this just keeps the UI calm between call and re-fetch.
      const remaining = state.memories.filter((m) => m.node_id !== nodeId);
      patch({ memories: remaining, lastDeletionCert: cert });
      return cert;
    } catch (err) {
      if (!disposed) {
        patch({ error: err instanceof Error ? err.message : String(err) });
      }
      return null;
    }
  }

  async function pinMemory(nodeId: string, pinned: boolean): Promise<void> {
    try {
      await adapter.pinMemory(nodeId, pinned);
      if (disposed) return;
      // Mutate in place so the pin reordering renders immediately.
      const updated = state.memories.map((m) => (m.node_id === nodeId ? { ...m, pinned } : m));
      patch({ memories: updated });
    } catch (err) {
      if (!disposed) {
        patch({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  function filteredView(): MemoryNode[] {
    return filterMemoriesView(state.memories, {
      search: state.search,
      auditFlags: state.auditFlags,
      sensitivityFilter: options.sensitivityFilter,
    });
  }

  function getDecayedConfidence(node: MemoryNode): number {
    return adapter.getDecayedConfidence(node);
  }

  function subscribe(listener: (state: MemoryState) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getState(): MemoryState {
    return state;
  }

  function dispose(): void {
    disposed = true;
    listeners.clear();
  }

  return {
    getState,
    subscribe,
    refresh,
    setSearch,
    setAuditFlags,
    clearAuditFlags,
    deleteMemory,
    pinMemory,
    filteredView,
    getDecayedConfidence,
    dispose,
  };
}
