import { RelationType, SensitivityLevel } from "@motebit/sdk";
import type { MemoryNode, MemoryEdge, DeletionCertificate } from "../index";
import type { DesktopContext } from "../types";
import { formatTimeAgo } from "../types";
import {
  createMemoryController,
  classifyCertainty,
  type MemoryFetchAdapter,
  type MemoryState,
} from "@motebit/panels";

// === DOM Refs ===

const memoryPanel = document.getElementById("memory-panel") as HTMLDivElement;
const memoryBackdrop = document.getElementById("memory-backdrop") as HTMLDivElement;
const memoryList = document.getElementById("memory-list") as HTMLDivElement;
const memoryCount = document.getElementById("memory-count") as HTMLSpanElement;
const memorySearch = document.getElementById("memory-search") as HTMLInputElement;
const memoryGraphWrap = document.getElementById("memory-graph-wrap") as HTMLDivElement;
const memoryGraphCanvas = document.getElementById("memory-graph-canvas") as HTMLCanvasElement;
const memoryGraphTooltip = document.getElementById("memory-graph-tooltip") as HTMLDivElement;
const viewListBtn = document.getElementById("mem-view-list") as HTMLButtonElement;
const viewGraphBtn = document.getElementById("mem-view-graph") as HTMLButtonElement;
const viewDeletionsBtn = document.getElementById("mem-view-deletions") as HTMLButtonElement;
const viewConsolidationsBtn = document.getElementById(
  "mem-view-consolidations",
) as HTMLButtonElement;

// === Memory Panel ===

export interface MemoryAPI {
  open(nodeId?: string, auditFlags?: Map<string, string>): void;
  close(): void;
}

type ViewMode = "list" | "graph" | "deletions" | "consolidations";

// Graph view still uses raw node/edge arrays — the force simulation cares
// about every node regardless of the list-view filter. The controller owns
// the list-view slice (search, audit sort, pin ordering); the graph reads
// the full set.
let allMemories: MemoryNode[] = [];
let allEdges: MemoryEdge[] = [];
let currentView: ViewMode = "list";

// === Graph Layout Types ===

interface GraphNode {
  id: string;
  mem: MemoryNode;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  label: string;
}

interface GraphEdge {
  edge: MemoryEdge;
  source: GraphNode;
  target: GraphNode;
}

// Cached graph layout
let cachedGraphNodes: GraphNode[] | null = null;
let cachedGraphEdges: GraphEdge[] | null = null;
let cachedMemoryCount = -1;

// Graph interaction state
let graphZoom = 1;
let graphPanX = 0;
let graphPanY = 0;
let selectedNodeId: string | null = null;
let hoveredNode: GraphNode | null = null;
let dragNode: GraphNode | null = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let graphAnimFrame: number | null = null;

// === Sensitivity Colors ===

const SENSITIVITY_COLORS: Record<string, string> = {
  none: "#22c55e",
  personal: "#3b82f6",
  medical: "#a855f7",
  financial: "#f59e0b",
  secret: "#ef4444",
};

// === Force-Directed Layout ===

function buildGraph(
  memories: MemoryNode[],
  edges: MemoryEdge[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodeMap = new Map<string, GraphNode>();
  const cx = 150;
  const cy = 150;

  for (const mem of memories) {
    const confidence = Math.max(0.5, mem.confidence);
    const radius = 8 + (confidence - 0.5) * 24; // 8-20px
    const color = SENSITIVITY_COLORS[mem.sensitivity] ?? SENSITIVITY_COLORS["none"]!;
    const label = mem.content.length > 30 ? mem.content.slice(0, 30) + "..." : mem.content;

    nodeMap.set(mem.node_id, {
      id: mem.node_id,
      mem,
      x: cx + (Math.random() - 0.5) * 200,
      y: cy + (Math.random() - 0.5) * 200,
      vx: 0,
      vy: 0,
      radius,
      color,
      label,
    });
  }

  const graphEdges: GraphEdge[] = [];
  for (const edge of edges) {
    const source = nodeMap.get(edge.source_id);
    const target = nodeMap.get(edge.target_id);
    if (source && target) {
      graphEdges.push({ edge, source, target });
    }
  }

  return { nodes: Array.from(nodeMap.values()), edges: graphEdges };
}

function runForceSimulation(nodes: GraphNode[], edges: GraphEdge[], iterations: number): void {
  const repulsionStrength = 3000;
  const attractionStrength = 0.01;
  const centerStrength = 0.005;
  const damping = 0.85;
  const cx = 150;
  const cy = 150;

  for (let iter = 0; iter < iterations; iter++) {
    // Repulsion between all pairs (Coulomb's law)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) dist = 1;
        const force = repulsionStrength / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    // Attraction along edges (Hooke's law)
    for (const e of edges) {
      const dx = e.target.x - e.source.x;
      const dy = e.target.y - e.source.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const force = dist * attractionStrength;
      const fx = (dx / (dist || 1)) * force;
      const fy = (dy / (dist || 1)) * force;
      e.source.vx += fx;
      e.source.vy += fy;
      e.target.vx -= fx;
      e.target.vy -= fy;
    }

    // Centering force
    for (const node of nodes) {
      node.vx += (cx - node.x) * centerStrength;
      node.vy += (cy - node.y) * centerStrength;
    }

    // Apply velocities with damping
    for (const node of nodes) {
      node.vx *= damping;
      node.vy *= damping;
      node.x += node.vx;
      node.y += node.vy;
    }
  }
}

// === Graph Rendering ===

function renderGraph(
  ctx2d: CanvasRenderingContext2D,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  const canvas = ctx2d.canvas;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  // Resize canvas for HiDPI
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }

  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.clearRect(0, 0, w, h);

  ctx2d.save();
  ctx2d.translate(graphPanX, graphPanY);
  ctx2d.scale(graphZoom, graphZoom);

  // Determine highlighted set for selection
  const highlightedNodes = new Set<string>();
  if (selectedNodeId != null && selectedNodeId !== "") {
    highlightedNodes.add(selectedNodeId);
    for (const e of edges) {
      if (e.source.id === selectedNodeId) highlightedNodes.add(e.target.id);
      if (e.target.id === selectedNodeId) highlightedNodes.add(e.source.id);
    }
  }

  // Draw edges
  for (const e of edges) {
    const isHighlighted =
      selectedNodeId != null &&
      selectedNodeId !== "" &&
      highlightedNodes.has(e.source.id) &&
      highlightedNodes.has(e.target.id);
    ctx2d.beginPath();
    ctx2d.moveTo(e.source.x, e.source.y);
    ctx2d.lineTo(e.target.x, e.target.y);
    ctx2d.strokeStyle = isHighlighted ? "rgba(100, 100, 100, 0.5)" : "rgba(0, 0, 0, 0.1)";
    ctx2d.lineWidth = isHighlighted ? 1.5 : 1;

    // Dash style by relation type
    const rel = e.edge.relation_type;
    if (rel === RelationType.FollowedBy) {
      ctx2d.setLineDash([4, 3]); // dashed for temporal
    } else if (rel === RelationType.CausedBy) {
      ctx2d.setLineDash([1, 3]); // dotted for causal
    } else {
      ctx2d.setLineDash([]); // solid for association/related/reinforces/etc
    }
    ctx2d.stroke();
    ctx2d.setLineDash([]);
  }

  // Draw nodes
  for (const node of nodes) {
    const isSelected = node.id === selectedNodeId;
    const isHovered = node === hoveredNode;
    const isDimmed = selectedNodeId !== null && !highlightedNodes.has(node.id);

    ctx2d.beginPath();
    ctx2d.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
    ctx2d.fillStyle = isDimmed ? hexWithAlpha(node.color, 0.2) : node.color;
    ctx2d.globalAlpha = isDimmed ? 0.4 : 1;
    ctx2d.fill();
    ctx2d.globalAlpha = 1;

    if (isSelected || isHovered) {
      ctx2d.strokeStyle = isSelected ? "rgba(0, 0, 0, 0.6)" : "rgba(0, 0, 0, 0.3)";
      ctx2d.lineWidth = isSelected ? 2 : 1;
      ctx2d.stroke();
    }

    // Label
    if (!isDimmed) {
      ctx2d.fillStyle = "rgba(0, 0, 0, 0.55)";
      ctx2d.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx2d.textAlign = "center";
      ctx2d.textBaseline = "top";
      ctx2d.fillText(node.label, node.x, node.y + node.radius + 3);
    }
  }

  ctx2d.restore();
}

function hexWithAlpha(hex: string, alpha: number): string {
  // Convert hex like #22c55e to rgba
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// === Coordinate Helpers ===

function canvasToGraph(canvasX: number, canvasY: number): { x: number; y: number } {
  return {
    x: (canvasX - graphPanX) / graphZoom,
    y: (canvasY - graphPanY) / graphZoom,
  };
}

function findNodeAt(nodes: GraphNode[], gx: number, gy: number): GraphNode | null {
  // Search in reverse so topmost (last-drawn) nodes are hit first
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!;
    const dx = gx - node.x;
    const dy = gy - node.y;
    if (dx * dx + dy * dy <= node.radius * node.radius) {
      return node;
    }
  }
  return null;
}

// === Init ===

export function initMemory(ctx: DesktopContext): MemoryAPI {
  let focusNodeId: string | null = null;

  // Controller owns list-view state (memories, search, audit flags, filter).
  // Graph view still consumes raw `allMemories` + `allEdges` (the force
  // simulation can't filter — it operates on the whole graph).
  const memoryAdapter: MemoryFetchAdapter = {
    listMemories: () => ctx.app.listMemories(),
    deleteMemory: async (nodeId) => {
      const cert = await ctx.app.deleteMemory(nodeId);
      // Encryption's cert has a concrete shape; widen to the controller's
      // Record<string, unknown> and let the surface cast back for display.
      return cert as unknown as Record<string, unknown> | null;
    },
    pinMemory: (nodeId, pinned) => ctx.app.pinMemory(nodeId, pinned),
    getDecayedConfidence: (node) => ctx.app.getDecayedConfidence(node as never),
  };
  // Desktop shows all sensitivities — the user is on their own device with
  // their own memories, and hiding them here would make the UI lie about
  // what the runtime has stored. Web's panel opts into the ["none",
  // "personal"] floor to match CLI export; desktop doesn't.
  const memoryCtrl = createMemoryController(memoryAdapter);

  memoryCtrl.subscribe((state) => {
    // Panels' MemoryNode is a narrow structural subset of the runtime's;
    // cast back here so the graph-view code keeps its richer field access.
    allMemories = state.memories as unknown as MemoryNode[];
    memoryCount.textContent = String(state.memories.length);
    // Invalidate graph cache if memory count changed
    if (state.memories.length !== cachedMemoryCount) {
      cachedGraphNodes = null;
      cachedGraphEdges = null;
      cachedMemoryCount = state.memories.length;
    }
    if (currentView === "list") {
      renderMemoryItems(state);
    } else if (currentView === "graph") {
      renderGraphView();
    }
  });

  function open(nodeId?: string, auditFlags?: Map<string, string>): void {
    focusNodeId = nodeId ?? null;
    memoryCtrl.setAuditFlags(auditFlags ?? new Map<string, string>());
    // If focusing a specific node or showing audit, ensure list view
    if ((focusNodeId != null && focusNodeId !== "" && currentView !== "list") || auditFlags) {
      setView("list");
    }
    memoryPanel.classList.add("open");
    memoryBackdrop.classList.add("open");
    refreshMemoryData();
  }

  function close(): void {
    memoryPanel.classList.remove("open");
    memoryBackdrop.classList.remove("open");
    focusNodeId = null;
    if (graphAnimFrame !== null) {
      cancelAnimationFrame(graphAnimFrame);
      graphAnimFrame = null;
    }
  }

  function refreshMemoryData(): void {
    // Fire the controller refresh (list + state) and the edges fetch
    // (graph-only) in parallel. The controller's subscription re-renders
    // the list view; the edges promise updates the graph-view cache.
    void Promise.all([memoryCtrl.refresh(), ctx.app.listMemoryEdges()]).then(([, edges]) => {
      allEdges = edges;
    });
  }

  function setView(mode: ViewMode): void {
    if (mode === currentView) return;
    currentView = mode;

    viewListBtn.classList.toggle("active", mode === "list");
    viewGraphBtn.classList.toggle("active", mode === "graph");
    viewDeletionsBtn.classList.toggle("active", mode === "deletions");
    viewConsolidationsBtn.classList.toggle("active", mode === "consolidations");

    if (graphAnimFrame !== null) {
      cancelAnimationFrame(graphAnimFrame);
      graphAnimFrame = null;
    }

    if (mode === "list") {
      memoryList.style.display = "";
      memoryGraphWrap.style.display = "none";
      renderMemoryItems(memoryCtrl.getState());
    } else if (mode === "graph") {
      memoryList.style.display = "none";
      memoryGraphWrap.style.display = "";
      renderGraphView();
    } else if (mode === "deletions") {
      memoryList.style.display = "";
      memoryGraphWrap.style.display = "none";
      renderDeletionLog();
    } else if (mode === "consolidations") {
      memoryList.style.display = "";
      memoryGraphWrap.style.display = "none";
      void renderConsolidationLog();
    }
  }

  // === List View ===

  function renderMemoryItems(state: MemoryState): void {
    memoryList.innerHTML = "";
    const filtered = memoryCtrl.filteredView() as MemoryNode[];

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mem-empty";
      empty.textContent = state.search.trim() ? "No matches" : "No memories yet";
      memoryList.appendChild(empty);
      return;
    }

    // Controller sort already put pinned first. Desktop still wants two
    // labelled sections — split on pinned flag to preserve the headers.
    const pinnedEnd = filtered.findIndex((m) => !m.pinned);
    const pinned = pinnedEnd === -1 ? filtered : filtered.slice(0, pinnedEnd);
    const unpinned = pinnedEnd === -1 ? [] : filtered.slice(pinnedEnd);

    if (pinned.length > 0) {
      const header = document.createElement("div");
      header.className = "mem-section-header";
      header.textContent = `Pinned (${pinned.length})`;
      memoryList.appendChild(header);
      for (const mem of pinned) {
        renderMemoryItem(mem, state);
      }
    }

    if (unpinned.length > 0) {
      if (pinned.length > 0) {
        const header = document.createElement("div");
        header.className = "mem-section-header";
        header.textContent = "Recent";
        memoryList.appendChild(header);
      }
      for (const mem of unpinned) {
        renderMemoryItem(mem, state);
      }
    }

    // Scroll to and highlight focused node
    if (focusNodeId != null && focusNodeId !== "") {
      const target = memoryList.querySelector(`[data-node-id="${focusNodeId}"]`);
      if (target) {
        target.classList.add("mem-item-focused");
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        setTimeout(() => target.classList.remove("mem-item-focused"), 2000);
      }
      focusNodeId = null;
    }
  }

  function renderMemoryItem(mem: MemoryNode, state: MemoryState): void {
    const auditCategory = state.auditFlags.get(mem.node_id);
    const item = document.createElement("div");
    item.className = "mem-item" + (auditCategory ? ` memory-item ${auditCategory}` : "");
    item.dataset.nodeId = mem.node_id;

    const contentDiv = document.createElement("div");
    contentDiv.className = "mem-item-content" + (auditCategory ? " memory-item-content" : "");
    contentDiv.textContent = mem.content;
    item.appendChild(contentDiv);

    const metaDiv = document.createElement("div");
    metaDiv.className = "mem-item-meta";

    // Audit tag (if flagged)
    if (auditCategory) {
      const tag = document.createElement("span");
      tag.className = `memory-audit-tag ${auditCategory}`;
      const labels: Record<string, string> = {
        phantom: "phantom",
        conflict: "conflict",
        "near-death": "fading",
      };
      tag.textContent = labels[auditCategory] ?? auditCategory;
      metaDiv.appendChild(tag);
    }

    if (mem.sensitivity != null && mem.sensitivity !== SensitivityLevel.None) {
      const badge = document.createElement("span");
      badge.className = `mem-sensitivity-badge ${mem.sensitivity}`;
      badge.textContent = mem.sensitivity;
      metaDiv.appendChild(badge);
    }

    const decayed = memoryCtrl.getDecayedConfidence(mem);
    const certainty = classifyCertainty(decayed);
    const conf = document.createElement("span");
    // Three-state certainty badge mirrors the Layer-1 memory index
    // the agent sees in its own system prompt (spec/memory-delta-v1.md
    // §5.8). When the motebit promotes a memory to "absolute", the
    // user sees the same label here.
    conf.className = `mem-certainty mem-certainty-${certainty}`;
    conf.textContent = `${certainty} · ${Math.round(decayed * 100)}%`;
    metaDiv.appendChild(conf);

    const halfDays = Math.round(mem.half_life / 86_400_000);
    const halfSpan = document.createElement("span");
    halfSpan.textContent = `${halfDays}d${mem.half_life > 30 * 86_400_000 ? " \u2191" : ""}`;
    if (mem.half_life > 30 * 86_400_000) halfSpan.style.color = "#4ade80";
    metaDiv.appendChild(halfSpan);

    const time = document.createElement("span");
    time.textContent = formatTimeAgo(mem.created_at);
    metaDiv.appendChild(time);

    item.appendChild(metaDiv);

    // Pin button
    const pinBtn = document.createElement("button");
    pinBtn.className = `mem-pin-btn${mem.pinned ? " pinned" : ""}`;
    pinBtn.textContent = mem.pinned ? "\u2605" : "\u2606";
    pinBtn.title = mem.pinned ? "Unpin memory" : "Pin memory";
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      // Controller does the optimistic pin flip + emits; edges don't
      // change on pin so no need to re-fetch.
      void memoryCtrl.pinMemory(mem.node_id, !mem.pinned);
    });
    item.appendChild(pinBtn);

    // Delete button
    const deleteBtnWrap = document.createElement("div");
    deleteBtnWrap.className = "mem-delete-wrap";

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "mem-delete-btn";
    deleteBtn.textContent = "\u00d7";
    deleteBtn.title = "Forget memory";

    let confirmTimeout: ReturnType<typeof setTimeout> | null = null;

    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();

      // Already in confirm state — execute delete
      if (deleteBtnWrap.classList.contains("mem-delete-confirming")) {
        if (confirmTimeout) clearTimeout(confirmTimeout);
        void memoryCtrl.deleteMemory(mem.node_id).then((cert) => {
          if (cert) {
            // Controller returns an opaque Record<string, unknown>; cast
            // back to the runtime's concrete encryption cert for render.
            showDeletionCertificate(item, cert as unknown as DeletionCertificate);
          } else {
            refreshMemoryData();
          }
        });
        return;
      }

      // Enter confirm state
      deleteBtnWrap.classList.add("mem-delete-confirming");
      deleteBtn.textContent = "Forget";
      deleteBtn.title = "Confirm forget";

      const cancelBtn = document.createElement("button");
      cancelBtn.className = "mem-cancel-btn";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", (ce) => {
        ce.stopPropagation();
        resetDeleteState();
      });
      deleteBtnWrap.appendChild(cancelBtn);

      // Auto-cancel after 6 seconds
      confirmTimeout = setTimeout(resetDeleteState, 6000);
    });

    function resetDeleteState(): void {
      if (confirmTimeout) {
        clearTimeout(confirmTimeout);
        confirmTimeout = null;
      }
      if (!deleteBtnWrap.isConnected) return;
      deleteBtnWrap.classList.remove("mem-delete-confirming");
      deleteBtn.textContent = "\u00d7";
      deleteBtn.title = "Forget memory";
      const cancel = deleteBtnWrap.querySelector(".mem-cancel-btn");
      if (cancel) cancel.remove();
    }

    deleteBtnWrap.appendChild(deleteBtn);
    item.appendChild(deleteBtnWrap);

    memoryList.appendChild(item);
  }

  // === Deletion Certificate Display ===

  function showDeletionCertificate(item: HTMLElement, cert: DeletionCertificate): void {
    // Replace the item content with a brief certificate confirmation
    item.classList.add("mem-item-deleted");
    const shortHash = cert.tombstone_hash.slice(0, 12);
    item.innerHTML = "";

    const certDiv = document.createElement("div");
    certDiv.className = "mem-cert-notice";
    certDiv.innerHTML =
      `<span class="mem-cert-label">Deleted</span>` +
      `<span class="mem-cert-hash" title="${cert.tombstone_hash}">cert: ${shortHash}...</span>`;
    item.appendChild(certDiv);

    // Fade out and refresh after a brief display
    setTimeout(() => {
      item.classList.add("mem-item-fading");
      setTimeout(() => refreshMemoryData(), 400);
    }, 1600);
  }

  // === Deletion Log View ===

  async function renderConsolidationLog(): Promise<void> {
    memoryList.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "mem-empty";
    loading.textContent = "";
    memoryList.appendChild(loading);

    const runtime = ctx.app.getRuntime();
    if (runtime == null) {
      memoryList.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "mem-empty";
      empty.textContent = "Runtime not initialized";
      memoryList.appendChild(empty);
      return;
    }

    const { EventType } = await import("@motebit/sdk");
    const [cycleEvents, receiptEvents, anchorEvents] = await Promise.all([
      runtime.events.query({
        motebit_id: runtime.motebitId,
        event_types: [EventType.ConsolidationCycleRun],
      }),
      runtime.events.query({
        motebit_id: runtime.motebitId,
        event_types: [EventType.ConsolidationReceiptSigned],
      }),
      runtime.events.query({
        motebit_id: runtime.motebitId,
        event_types: [EventType.ConsolidationReceiptsAnchored],
      }),
    ]);

    memoryList.innerHTML = "";

    if (cycleEvents.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mem-empty";
      empty.textContent = "No consolidation cycles yet";
      memoryList.appendChild(empty);
      return;
    }

    // Index receipts + anchors by cycle_id so we can decorate each cycle row
    // with "signed" and "anchored" indicators.
    const receiptByCycle = new Map<string, unknown>();
    for (const e of receiptEvents) {
      const p = e.payload as { receipt?: { cycle_id?: string } };
      if (p.receipt?.cycle_id) receiptByCycle.set(p.receipt.cycle_id, p.receipt);
    }
    const anchoredReceiptIds = new Set<string>();
    for (const e of anchorEvents) {
      const p = e.payload as { anchor?: { receipt_ids?: string[] } };
      for (const id of p.anchor?.receipt_ids ?? []) anchoredReceiptIds.add(id);
    }

    // Newest first.
    const sorted = [...cycleEvents].sort((a, b) => b.timestamp - a.timestamp);

    for (const ev of sorted) {
      const payload = ev.payload as {
        cycle_id?: string;
        phases_run?: string[];
        phases_yielded?: string[];
        summary?: {
          orient_nodes?: number;
          gather_clusters?: number;
          gather_notable?: number;
          consolidate_merged?: number;
          pruned_decay?: number;
          pruned_notability?: number;
          pruned_retention?: number;
        };
      };
      const cycleId = payload.cycle_id ?? "";
      const receipt = receiptByCycle.get(cycleId) as
        | { receipt_id?: string; signature?: string }
        | undefined;
      const receiptId = receipt?.receipt_id;
      const anchored = receiptId !== undefined && anchoredReceiptIds.has(receiptId);

      const row = document.createElement("div");
      row.className = "mem-cert-row";

      const badge = document.createElement("span");
      badge.className = "mem-cert-hash";
      const idShort = cycleId ? cycleId.slice(0, 8) : "cycle";
      if (anchored) {
        badge.textContent = `${idShort} ⚓`;
        badge.title = `Cycle ${cycleId} — signed and anchored onchain`;
      } else if (receipt) {
        badge.textContent = `${idShort} ✓`;
        badge.title = `Cycle ${cycleId} — signed receipt; not yet anchored`;
      } else {
        badge.textContent = idShort;
        badge.title = `Cycle ${cycleId} — unsigned (no signing keys configured or cycle ran zero phases)`;
      }

      const summary = document.createElement("span");
      summary.className = "mem-cert-target";
      const parts: string[] = [];
      const s = payload.summary ?? {};
      if (s.consolidate_merged) parts.push(`merged ${s.consolidate_merged}`);
      if (s.pruned_decay) parts.push(`pruned-decay ${s.pruned_decay}`);
      if (s.pruned_notability) parts.push(`pruned-noise ${s.pruned_notability}`);
      if (s.pruned_retention) parts.push(`retention ${s.pruned_retention}`);
      if (s.gather_clusters) parts.push(`clusters ${s.gather_clusters}`);
      if (s.orient_nodes != null) parts.push(`oriented ${s.orient_nodes}`);
      const yielded = (payload.phases_yielded ?? []).length;
      if (yielded > 0) parts.push(`${yielded} yielded`);
      summary.textContent = parts.length > 0 ? parts.join(", ") : "(no work)";

      const timeSpan = document.createElement("span");
      timeSpan.className = "mem-cert-time";
      timeSpan.textContent = formatTimeAgo(ev.timestamp);

      row.appendChild(badge);
      row.appendChild(summary);
      row.appendChild(timeSpan);
      memoryList.appendChild(row);
    }
  }

  function renderDeletionLog(): void {
    memoryList.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "mem-empty";
    loading.textContent = "";
    memoryList.appendChild(loading);

    void ctx.app.listDeletionCertificates().then((certs) => {
      memoryList.innerHTML = "";

      if (certs.length === 0) {
        const empty = document.createElement("div");
        empty.className = "mem-empty";
        empty.textContent = "No deletion records";
        memoryList.appendChild(empty);
        return;
      }

      for (const cert of certs) {
        const row = document.createElement("div");
        row.className = "mem-cert-row";

        const hashSpan = document.createElement("span");
        hashSpan.className = "mem-cert-hash";
        hashSpan.title = cert.tombstoneHash || "No hash recorded";
        hashSpan.textContent = cert.tombstoneHash
          ? `${cert.tombstoneHash.slice(0, 16)}...`
          : "no hash";

        const idSpan = document.createElement("span");
        idSpan.className = "mem-cert-target";
        idSpan.textContent = cert.targetId.slice(0, 8) + "...";
        idSpan.title = cert.targetId;

        const timeSpan = document.createElement("span");
        timeSpan.className = "mem-cert-time";
        timeSpan.textContent = formatTimeAgo(cert.timestamp);

        row.appendChild(hashSpan);
        row.appendChild(idSpan);
        row.appendChild(timeSpan);
        memoryList.appendChild(row);
      }
    });
  }

  // === Graph View ===

  function renderGraphView(): void {
    if (allMemories.length === 0) {
      memoryGraphWrap.style.display = "none";
      memoryList.style.display = "";
      memoryList.innerHTML = '<div class="mem-empty">No memories yet</div>';
      return;
    }

    // Build or reuse cached layout
    if (!cachedGraphNodes || !cachedGraphEdges) {
      const graph = buildGraph(allMemories, allEdges);
      runForceSimulation(graph.nodes, graph.edges, 120);
      cachedGraphNodes = graph.nodes;
      cachedGraphEdges = graph.edges;

      // Center the graph in the canvas
      if (graph.nodes.length > 0) {
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        for (const n of graph.nodes) {
          minX = Math.min(minX, n.x - n.radius);
          minY = Math.min(minY, n.y - n.radius);
          maxX = Math.max(maxX, n.x + n.radius);
          maxY = Math.max(maxY, n.y + n.radius);
        }
        const gw = maxX - minX;
        const gh = maxY - minY;
        const cw = memoryGraphCanvas.clientWidth || 280;
        const ch = memoryGraphCanvas.clientHeight || 400;
        const padding = 40;
        graphZoom = Math.min(1.5, (cw - padding * 2) / gw, (ch - padding * 2) / gh);
        graphZoom = Math.max(0.3, graphZoom);
        const gcx = (minX + maxX) / 2;
        const gcy = (minY + maxY) / 2;
        graphPanX = cw / 2 - gcx * graphZoom;
        graphPanY = ch / 2 - gcy * graphZoom;
      }

      selectedNodeId = null;
      hoveredNode = null;
    }

    drawGraph();
  }

  function drawGraph(): void {
    const ctx2d = memoryGraphCanvas.getContext("2d");
    if (!ctx2d || !cachedGraphNodes || !cachedGraphEdges) return;
    renderGraph(ctx2d, cachedGraphNodes, cachedGraphEdges);
  }

  // === Graph Interaction ===

  function getCanvasPos(e: MouseEvent): { x: number; y: number } {
    const rect = memoryGraphCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  memoryGraphCanvas.addEventListener("mousedown", (e) => {
    if (!cachedGraphNodes) return;
    const pos = getCanvasPos(e);
    const gpos = canvasToGraph(pos.x, pos.y);
    const node = findNodeAt(cachedGraphNodes, gpos.x, gpos.y);

    if (node) {
      dragNode = node;
      dragOffsetX = gpos.x - node.x;
      dragOffsetY = gpos.y - node.y;
      selectedNodeId = node.id;
      drawGraph();
    } else {
      // Clicked empty space — deselect
      if (selectedNodeId != null && selectedNodeId !== "") {
        selectedNodeId = null;
        drawGraph();
      }
    }
  });

  memoryGraphCanvas.addEventListener("mousemove", (e) => {
    if (!cachedGraphNodes) return;
    const pos = getCanvasPos(e);
    const gpos = canvasToGraph(pos.x, pos.y);

    if (dragNode) {
      dragNode.x = gpos.x - dragOffsetX;
      dragNode.y = gpos.y - dragOffsetY;
      drawGraph();
      return;
    }

    const node = findNodeAt(cachedGraphNodes, gpos.x, gpos.y);
    if (node !== hoveredNode) {
      hoveredNode = node;
      drawGraph();

      if (node) {
        showTooltip(node, pos.x, pos.y);
      } else {
        hideTooltip();
      }
    } else if (node) {
      // Update tooltip position as mouse moves over the same node
      positionTooltip(pos.x, pos.y);
    }
  });

  memoryGraphCanvas.addEventListener("mouseup", () => {
    dragNode = null;
  });

  memoryGraphCanvas.addEventListener("mouseleave", () => {
    dragNode = null;
    if (hoveredNode) {
      hoveredNode = null;
      hideTooltip();
      drawGraph();
    }
  });

  memoryGraphCanvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const pos = getCanvasPos(e);
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      const newZoom = Math.max(0.15, Math.min(5, graphZoom * zoomFactor));

      // Zoom toward mouse position
      graphPanX = pos.x - (pos.x - graphPanX) * (newZoom / graphZoom);
      graphPanY = pos.y - (pos.y - graphPanY) * (newZoom / graphZoom);
      graphZoom = newZoom;

      drawGraph();
    },
    { passive: false },
  );

  // === Tooltip ===

  function showTooltip(node: GraphNode, canvasX: number, canvasY: number): void {
    const mem = node.mem;
    const decayed = ctx.app.getDecayedConfidence(mem);
    const sensitivityText =
      mem.sensitivity !== SensitivityLevel.None ? ` | ${mem.sensitivity}` : "";

    memoryGraphTooltip.innerHTML =
      `<div class="mem-graph-tooltip-content">${escapeHtml(mem.content)}</div>` +
      `<div class="mem-graph-tooltip-meta">${Math.round(decayed * 100)}% confidence${sensitivityText}</div>` +
      `<div class="mem-graph-tooltip-meta">${formatTimeAgo(mem.created_at)}</div>`;

    memoryGraphTooltip.classList.add("visible");
    positionTooltip(canvasX, canvasY);
  }

  function positionTooltip(canvasX: number, canvasY: number): void {
    const wrapRect = memoryGraphWrap.getBoundingClientRect();
    const tooltipW = memoryGraphTooltip.offsetWidth || 180;
    let left = canvasX + 12;
    let top = canvasY - 10;

    // Keep tooltip within the panel
    if (left + tooltipW > wrapRect.width) {
      left = canvasX - tooltipW - 12;
    }
    if (top < 0) top = 4;
    if (top + memoryGraphTooltip.offsetHeight > wrapRect.height) {
      top = wrapRect.height - memoryGraphTooltip.offsetHeight - 4;
    }

    memoryGraphTooltip.style.left = `${left}px`;
    memoryGraphTooltip.style.top = `${top}px`;
  }

  function hideTooltip(): void {
    memoryGraphTooltip.classList.remove("visible");
  }

  function escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // === View Toggle Listeners ===

  viewListBtn.addEventListener("click", () => setView("list"));
  viewGraphBtn.addEventListener("click", () => setView("graph"));
  viewDeletionsBtn.addEventListener("click", () => setView("deletions"));
  viewConsolidationsBtn.addEventListener("click", () => setView("consolidations"));

  // Debounced search — pushes into the controller, which re-emits so the
  // subscription's renderer re-runs with the new filteredView.
  let memorySearchTimeout: ReturnType<typeof setTimeout> | null = null;
  memorySearch.addEventListener("input", () => {
    if (memorySearchTimeout) clearTimeout(memorySearchTimeout);
    memorySearchTimeout = setTimeout(() => {
      memoryCtrl.setSearch(memorySearch.value.trim());
    }, 200);
  });

  // Event listeners
  document.getElementById("memory-btn")!.addEventListener("click", () => open());
  document.getElementById("memory-close-btn")!.addEventListener("click", close);
  memoryBackdrop.addEventListener("click", close);

  return { open, close };
}
