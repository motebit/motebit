// === Workstation Panel (web surface) — transitional ===
//
// This DOM panel is the SIGNED-RECEIPT LOG only. It is NOT the slab.
// Per `docs/doctrine/motebit-computer.md`, the motebit's active work
// renders on the slab — a liquid-glass plane in the 3D scene beside
// the creature. On web (sandboxed, no OS access) the slab renders
// `virtual_browser` / `shared_gaze` modes once their cloud-browser
// infrastructure ships; `desktop_drive` is desktop-only. Until the
// slab ships, this panel serves as the audit-log projection of the
// motebit's tool-call receipts.
//
// Phase 1 (2026-04-24) removed the Phase-0 URL bar + Reader iframe
// because it conflated `read_url` (an AI tool returning text for the
// reasoning loop) with a shared browsing surface — a category error
// the slab doctrine explicitly forbids.
//
// Structural sibling: `apps/desktop/src/ui/workstation-panel.ts`
// (same controller, same DOM, typed against DesktopContext).

import type { WebContext } from "../types";
import {
  createWorkstationController,
  type ToolInvocationReceiptLike,
  type WorkstationController,
  type WorkstationFetchAdapter,
  type WorkstationState,
} from "@motebit/panels";

export interface WorkstationPanelAPI {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

// --- Web-native time formatting ---

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 1_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function shortHash(hex: string, chars: number = 8): string {
  if (hex.length <= chars) return hex;
  return hex.slice(0, chars);
}

// --- DOM scaffold ---

interface Scaffold {
  panel: HTMLDivElement;
  list: HTMLDivElement;
  empty: HTMLDivElement;
  headerCount: HTMLSpanElement;
  clearBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
}

function buildScaffold(): Scaffold {
  const panel = document.createElement("div");
  panel.id = "workstation-panel";
  Object.assign(panel.style, {
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    width: "100%",
    height: "100%",
    boxSizing: "border-box",
  });

  // === Header ===
  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "12px 14px",
    borderBottom: "1px solid rgba(60, 75, 105, 0.10)",
    flex: "0 0 auto",
  });

  const title = document.createElement("div");
  title.textContent = "Workstation";
  Object.assign(title.style, {
    fontWeight: "600",
    fontSize: "12px",
    color: "rgba(20, 30, 50, 0.96)",
    letterSpacing: "0.02em",
  });

  const headerCount = document.createElement("span");
  Object.assign(headerCount.style, {
    fontSize: "10px",
    color: "rgba(90, 110, 150, 0.72)",
    fontFamily: "'SF Mono', Menlo, Consolas, monospace",
    marginLeft: "8px",
    letterSpacing: "0.03em",
  });

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.textContent = "clear";
  Object.assign(clearBtn.style, {
    marginLeft: "auto",
    background: "transparent",
    border: "none",
    color: "rgba(60, 80, 120, 0.68)",
    cursor: "pointer",
    fontSize: "11px",
    letterSpacing: "0.02em",
    padding: "0 4px",
  });

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close workstation panel");
  closeBtn.textContent = "×";
  Object.assign(closeBtn.style, {
    background: "transparent",
    border: "none",
    color: "rgba(60, 80, 120, 0.78)",
    cursor: "pointer",
    fontSize: "18px",
    lineHeight: "1",
    padding: "0 4px",
  });

  header.appendChild(title);
  header.appendChild(headerCount);
  header.appendChild(clearBtn);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // === Receipt list ===
  // The log of signed tool-call receipts, newest on top. Each row is
  // independently self-verifiable — clicking copies the full JSON to
  // the clipboard so the user can paste into a third-party verifier.
  const list = document.createElement("div");
  list.id = "workstation-receipt-list";
  Object.assign(list.style, {
    display: "none",
    flex: "1 1 auto",
    minHeight: "0",
    overflowY: "auto",
    overflowX: "hidden",
    padding: "10px 12px",
  });
  panel.appendChild(list);

  // === Empty state ===
  const empty = document.createElement("div");
  empty.textContent = "No tool calls yet.";
  Object.assign(empty.style, {
    display: "block",
    flex: "1 1 auto",
    padding: "40px 16px",
    textAlign: "center",
    color: "rgba(90, 110, 150, 0.62)",
    fontSize: "11.5px",
    fontStyle: "italic",
    letterSpacing: "0.02em",
  });
  panel.appendChild(empty);

  return { panel, list, empty, headerCount, clearBtn, closeBtn };
}

function buildReceiptRow(receipt: ToolInvocationReceiptLike): HTMLDivElement {
  const row = document.createElement("div");
  Object.assign(row.style, {
    padding: "8px 10px",
    borderRadius: "6px",
    marginBottom: "4px",
    background: "rgba(255, 255, 255, 0.32)",
    fontSize: "11.5px",
    lineHeight: "1.4",
    border: "1px solid rgba(100, 120, 155, 0.08)",
    opacity: "0",
    transform: "translateY(-6px)",
    transition: "opacity 0.28s ease, transform 0.28s ease, background 0.16s ease",
  });
  requestAnimationFrame(() => {
    row.style.opacity = "1";
    row.style.transform = "translateY(0)";
  });

  const durationMs = Math.max(0, receipt.completed_at - receipt.started_at);
  const duration =
    durationMs < 1_000
      ? `${durationMs}ms`
      : durationMs < 60_000
        ? `${(durationMs / 1_000).toFixed(2)}s`
        : `${Math.floor(durationMs / 60_000)}m ${Math.floor((durationMs % 60_000) / 1_000)}s`;

  const topLine = document.createElement("div");
  Object.assign(topLine.style, {
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
    marginBottom: "4px",
  });

  const toolName = document.createElement("span");
  toolName.textContent = receipt.tool_name;
  Object.assign(toolName.style, {
    fontWeight: "600",
    fontSize: "11.5px",
    color: "rgba(20, 30, 50, 0.96)",
    fontFamily: "'SF Mono', Menlo, Consolas, monospace",
  });

  const relTime = document.createElement("span");
  relTime.textContent = formatRelativeTime(receipt.completed_at);
  Object.assign(relTime.style, {
    fontSize: "10px",
    color: "rgba(90, 110, 150, 0.72)",
    letterSpacing: "0.03em",
    marginLeft: "auto",
  });

  const durationEl = document.createElement("span");
  durationEl.textContent = duration;
  Object.assign(durationEl.style, {
    fontSize: "10px",
    color: "rgba(90, 110, 150, 0.72)",
    fontFamily: "'SF Mono', Menlo, Consolas, monospace",
  });

  topLine.appendChild(toolName);
  topLine.appendChild(durationEl);
  topLine.appendChild(relTime);
  row.appendChild(topLine);

  const meta = document.createElement("div");
  const labelColor = "rgba(90, 110, 150, 0.72)";
  const valColor = "rgba(40, 60, 100, 0.82)";
  meta.innerHTML = [
    `<span style="color: ${labelColor}">args</span> <span style="font-family:'SF Mono',Menlo,Consolas,monospace;color:${valColor}">${escapeHtml(shortHash(receipt.args_hash))}…</span>`,
    `<span style="color: ${labelColor}">result</span> <span style="font-family:'SF Mono',Menlo,Consolas,monospace;color:${valColor}">${escapeHtml(shortHash(receipt.result_hash))}…</span>`,
    `<span style="color: ${labelColor}">sig</span> <span style="font-family:'SF Mono',Menlo,Consolas,monospace;color:${valColor}">${escapeHtml(shortHash(receipt.signature))}…</span>`,
  ].join(" &nbsp; ");
  Object.assign(meta.style, {
    fontSize: "10px",
    letterSpacing: "0.02em",
  });
  row.appendChild(meta);

  row.style.cursor = "copy";
  row.title = "Click to copy full signed receipt JSON";
  row.addEventListener("click", () => {
    void navigator.clipboard.writeText(JSON.stringify(receipt, null, 2));
  });
  row.addEventListener("mouseenter", () => {
    row.style.background = "rgba(255, 255, 255, 0.56)";
  });
  row.addEventListener("mouseleave", () => {
    row.style.background = "rgba(255, 255, 255, 0.32)";
  });

  return row;
}

// --- Rendering ---

interface RenderRefs {
  list: HTMLDivElement;
  empty: HTMLDivElement;
  headerCount: HTMLSpanElement;
}

interface RenderCache {
  renderedIds: Set<string>;
}

function render(state: WorkstationState, refs: RenderRefs, cache: RenderCache): void {
  refs.headerCount.textContent =
    state.receiptCount > 0
      ? `${state.receiptCount} call${state.receiptCount === 1 ? "" : "s"}`
      : "";

  if (state.history.length === 0) {
    refs.list.style.display = "none";
    refs.empty.style.display = "block";
    cache.renderedIds.clear();
    while (refs.list.firstChild) refs.list.removeChild(refs.list.firstChild);
    return;
  }
  refs.list.style.display = "block";
  refs.empty.style.display = "none";

  const currentIds = new Set(state.history.map((r) => r.invocation_id));
  for (const id of cache.renderedIds) {
    if (!currentIds.has(id)) {
      const stale = refs.list.querySelector<HTMLDivElement>(`[data-invocation-id="${id}"]`);
      stale?.remove();
      cache.renderedIds.delete(id);
    }
  }
  for (const receipt of state.history) {
    if (cache.renderedIds.has(receipt.invocation_id)) continue;
    const row = buildReceiptRow(receipt);
    row.dataset.invocationId = receipt.invocation_id;
    refs.list.insertBefore(row, refs.list.firstChild);
    cache.renderedIds.add(receipt.invocation_id);
  }
}

// --- Launcher ---

function buildLauncher(onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.id = "workstation-launcher";
  btn.type = "button";
  btn.title = "Workstation (⌥W) — motebit tool calls";
  btn.setAttribute("aria-label", "Open workstation panel");
  Object.assign(btn.style, {
    position: "fixed",
    bottom: "18px",
    right: "84px",
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    border: "none",
    background: "rgba(255, 255, 255, 0.62)",
    color: "rgba(40, 60, 100, 0.78)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 4px 14px rgba(80, 100, 140, 0.2)",
    backdropFilter: "blur(10px) saturate(1.2)",
    zIndex: "98",
    transition: "background 0.16s ease, color 0.16s ease",
  });
  btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.5"/><line x1="3" y1="20" x2="21" y2="20"/><line x1="9" y1="16" x2="9" y2="20"/><line x1="15" y1="16" x2="15" y2="20"/></svg>`;
  btn.addEventListener("mouseenter", () => {
    btn.style.background = "rgba(255, 255, 255, 0.82)";
    btn.style.color = "rgba(20, 40, 80, 0.92)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.background = "rgba(255, 255, 255, 0.62)";
    btn.style.color = "rgba(40, 60, 100, 0.78)";
  });
  btn.addEventListener("click", onClick);
  return btn;
}

// --- Init ---

export function initWorkstationPanel(ctx: WebContext): WorkstationPanelAPI {
  let scaffold: Scaffold | null = null;
  let controller: WorkstationController | null = null;
  let open_ = false;

  const renderer = ctx.app.getRenderer?.() ?? null;

  function ensureBuilt(): Scaffold {
    if (scaffold) return scaffold;

    scaffold = buildScaffold();
    const { list, empty, closeBtn, headerCount, clearBtn } = scaffold;

    const adapter: WorkstationFetchAdapter = {
      subscribeToolInvocations: (listener) => ctx.app.subscribeToolInvocations(listener),
    };
    controller = createWorkstationController(adapter);

    const renderRefs: RenderRefs = { list, empty, headerCount };
    const renderCache: RenderCache = { renderedIds: new Set<string>() };

    controller.subscribe((state) => {
      render(state, renderRefs, renderCache);
    });
    render(controller.getState(), renderRefs, renderCache);

    closeBtn.addEventListener("click", close);
    clearBtn.addEventListener("click", () => controller?.clearHistory());

    return scaffold;
  }

  function open(): void {
    if (open_) return;
    const { panel } = ensureBuilt();
    open_ = true;

    if (renderer?.setWorkstationStageChild && renderer?.setWorkstationVisible) {
      renderer.setWorkstationStageChild(panel);
      renderer.setWorkstationVisible(true);
    } else {
      Object.assign(panel.style, {
        position: "fixed",
        top: "50%",
        right: "24px",
        transform: "translate(0, -50%)",
        width: "min(680px, calc(100vw - 48px))",
        maxHeight: "min(820px, calc(100vh - 48px))",
        background: "rgba(245, 248, 252, 0.9)",
        color: "rgba(14, 22, 40, 0.96)",
        borderRadius: "14px",
        boxShadow: "0 20px 60px rgba(80, 100, 140, 0.28)",
        backdropFilter: "blur(22px) saturate(1.3)",
        zIndex: "100",
      });
      document.body.appendChild(panel);
    }
  }

  function close(): void {
    if (!open_ || !scaffold) return;
    open_ = false;
    if (renderer?.setWorkstationVisible) {
      renderer.setWorkstationVisible(false);
    } else if (scaffold.panel.parentElement) {
      scaffold.panel.parentElement.removeChild(scaffold.panel);
    }
  }

  function toggle(): void {
    if (open_) close();
    else open();
  }

  function isOpen(): boolean {
    return open_;
  }

  const launcher = buildLauncher(() => toggle());
  document.body.appendChild(launcher);

  return { open, close, toggle, isOpen };
}
