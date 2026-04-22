// === Workstation Panel (web surface) ===
//
// Live view into the motebit's tool calls. Each call the runtime makes
// emits a signed `ToolInvocationReceipt`; this panel renders them in
// arrival order, with tool name, relative time, args/result hashes,
// and the signature truncated to a fingerprint. The receipts are
// independently self-verifiable — a verifier with only the motebit's
// public key can prove any row here is authentic.
//
// The state layer lives in @motebit/panels/workstation/controller;
// this file renders DOM from controller state and wires the web app's
// tool-invocation bus into the controller's adapter. No relay fetch,
// no network calls — the panel is a pure projection of the in-process
// receipt stream.
//
// MVP scope: receipt log only. Follow-up passes add the browser pane
// (virtual_browser mode), the plan-approval affordance, and the
// delegation view.

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

// No entry in index.html for this panel — it's built dynamically and
// appended to the body on first open. Keeps the MVP contained to one
// file; a future pass can extract the markup to index.html when the
// panel stabilizes and needs the stylesheet of a first-class surface.

function buildScaffold(): {
  backdrop: HTMLDivElement;
  panel: HTMLDivElement;
  list: HTMLDivElement;
  empty: HTMLDivElement;
  closeBtn: HTMLButtonElement;
  headerCount: HTMLSpanElement;
  clearBtn: HTMLButtonElement;
} {
  const backdrop = document.createElement("div");
  backdrop.id = "workstation-backdrop";
  backdrop.setAttribute("aria-hidden", "true");
  Object.assign(backdrop.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(6, 10, 18, 0.42)",
    opacity: "0",
    pointerEvents: "none",
    transition: "opacity 0.2s ease",
    zIndex: "99",
  });

  const panel = document.createElement("div");
  panel.id = "workstation-panel";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Workstation — motebit tool calls");
  Object.assign(panel.style, {
    position: "fixed",
    top: "50%",
    right: "24px",
    transform: "translate(calc(100% + 40px), -50%)",
    width: "min(440px, calc(100vw - 48px))",
    maxHeight: "min(720px, calc(100vh - 48px))",
    background: "rgba(18, 22, 34, 0.92)",
    color: "rgba(230, 235, 245, 0.94)",
    borderRadius: "14px",
    boxShadow: "0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(120, 140, 180, 0.18)",
    backdropFilter: "blur(22px) saturate(1.3)",
    transition: "transform 0.24s ease",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
    zIndex: "100",
  });

  // Header
  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex",
    alignItems: "center",
    padding: "14px 16px",
    borderBottom: "1px solid rgba(120, 140, 180, 0.14)",
    flex: "0 0 auto",
  });

  const title = document.createElement("span");
  title.textContent = "Workstation";
  Object.assign(title.style, {
    fontSize: "13px",
    fontWeight: "600",
    letterSpacing: "0.01em",
    flex: "1 1 auto",
  });

  const headerCount = document.createElement("span");
  headerCount.id = "workstation-count";
  Object.assign(headerCount.style, {
    fontSize: "10.5px",
    color: "rgba(170, 180, 200, 0.72)",
    letterSpacing: "0.02em",
    marginRight: "12px",
  });

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.textContent = "Clear";
  clearBtn.title = "Clear history";
  Object.assign(clearBtn.style, {
    background: "transparent",
    border: "none",
    color: "rgba(170, 180, 200, 0.72)",
    cursor: "pointer",
    fontSize: "11px",
    padding: "2px 6px",
    marginRight: "8px",
    borderRadius: "4px",
  });
  clearBtn.addEventListener(
    "mouseenter",
    () => (clearBtn.style.color = "rgba(230, 235, 245, 0.94)"),
  );
  clearBtn.addEventListener(
    "mouseleave",
    () => (clearBtn.style.color = "rgba(170, 180, 200, 0.72)"),
  );

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Close workstation");
  Object.assign(closeBtn.style, {
    background: "transparent",
    border: "none",
    color: "rgba(230, 235, 245, 0.78)",
    cursor: "pointer",
    fontSize: "20px",
    lineHeight: "1",
    padding: "0 4px",
  });

  header.appendChild(title);
  header.appendChild(headerCount);
  header.appendChild(clearBtn);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // List container
  const list = document.createElement("div");
  list.id = "workstation-list";
  Object.assign(list.style, {
    overflowY: "auto",
    padding: "8px 8px 14px",
    flex: "1 1 auto",
    minHeight: "0",
  });
  panel.appendChild(list);

  // Empty state (shown when history is empty)
  const empty = document.createElement("div");
  empty.id = "workstation-empty";
  empty.textContent = "No tool calls yet.";
  Object.assign(empty.style, {
    padding: "48px 24px",
    textAlign: "center",
    fontSize: "12px",
    color: "rgba(150, 160, 180, 0.62)",
    fontStyle: "italic",
  });
  panel.appendChild(empty);

  return { backdrop, panel, list, empty, closeBtn, headerCount, clearBtn };
}

// --- Receipt row ---

function buildReceiptRow(receipt: ToolInvocationReceiptLike): HTMLDivElement {
  const row = document.createElement("div");
  Object.assign(row.style, {
    padding: "10px 12px",
    borderRadius: "8px",
    marginBottom: "6px",
    background: "rgba(35, 42, 56, 0.48)",
    fontSize: "12px",
    lineHeight: "1.45",
    border: "1px solid rgba(120, 140, 180, 0.08)",
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
    fontSize: "12.5px",
    color: "rgba(230, 235, 245, 0.98)",
    fontFamily: "'SF Mono', Menlo, Consolas, monospace",
  });

  const relTime = document.createElement("span");
  relTime.textContent = formatRelativeTime(receipt.completed_at);
  Object.assign(relTime.style, {
    fontSize: "10.5px",
    color: "rgba(150, 160, 180, 0.72)",
    letterSpacing: "0.02em",
    marginLeft: "auto",
  });

  const durationEl = document.createElement("span");
  durationEl.textContent = duration;
  Object.assign(durationEl.style, {
    fontSize: "10.5px",
    color: "rgba(150, 160, 180, 0.72)",
    fontFamily: "'SF Mono', Menlo, Consolas, monospace",
  });

  topLine.appendChild(toolName);
  topLine.appendChild(durationEl);
  topLine.appendChild(relTime);
  row.appendChild(topLine);

  const meta = document.createElement("div");
  meta.innerHTML = [
    `<span style="color: rgba(150,160,180,0.72)">args</span> <span style="font-family:'SF Mono',Menlo,Consolas,monospace;color:rgba(200,210,225,0.82)">${escapeHtml(shortHash(receipt.args_hash))}…</span>`,
    `<span style="color: rgba(150,160,180,0.72)">result</span> <span style="font-family:'SF Mono',Menlo,Consolas,monospace;color:rgba(200,210,225,0.82)">${escapeHtml(shortHash(receipt.result_hash))}…</span>`,
    `<span style="color: rgba(150,160,180,0.72)">sig</span> <span style="font-family:'SF Mono',Menlo,Consolas,monospace;color:rgba(200,210,225,0.82)">${escapeHtml(shortHash(receipt.signature))}…</span>`,
  ].join(" &nbsp; ");
  Object.assign(meta.style, {
    fontSize: "10.5px",
    letterSpacing: "0.01em",
  });
  row.appendChild(meta);

  // Clicking a row copies the full receipt JSON to the clipboard —
  // lets the user paste it into a third-party verifier without the
  // panel needing its own verify flow in the MVP.
  row.style.cursor = "copy";
  row.title = "Click to copy full signed receipt JSON";
  row.addEventListener("click", () => {
    void navigator.clipboard.writeText(JSON.stringify(receipt, null, 2));
  });
  row.addEventListener("mouseenter", () => {
    row.style.background = "rgba(45, 54, 72, 0.62)";
  });
  row.addEventListener("mouseleave", () => {
    row.style.background = "rgba(35, 42, 56, 0.48)";
  });

  return row;
}

// --- Rendering ---

function render(
  state: WorkstationState,
  list: HTMLDivElement,
  empty: HTMLDivElement,
  headerCount: HTMLSpanElement,
): void {
  headerCount.textContent =
    state.receiptCount > 0
      ? `${state.receiptCount} call${state.receiptCount === 1 ? "" : "s"}`
      : "";
  if (state.history.length === 0) {
    list.style.display = "none";
    empty.style.display = "block";
    return;
  }
  list.style.display = "block";
  empty.style.display = "none";
  list.innerHTML = "";
  // Newest on top reads better for a live stream — UI inverts order.
  for (let i = state.history.length - 1; i >= 0; i--) {
    list.appendChild(buildReceiptRow(state.history[i]!));
  }
}

// --- Init ---

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
    background: "rgba(18, 22, 34, 0.82)",
    color: "rgba(200, 210, 225, 0.82)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 6px 18px rgba(0,0,0,0.28)",
    backdropFilter: "blur(12px) saturate(1.2)",
    zIndex: "98",
    transition: "transform 0.12s ease, background 0.16s ease",
  });
  btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.5"/><line x1="3" y1="20" x2="21" y2="20"/><line x1="9" y1="16" x2="9" y2="20"/><line x1="15" y1="16" x2="15" y2="20"/></svg>`;
  btn.addEventListener("mouseenter", () => (btn.style.background = "rgba(30, 38, 52, 0.94)"));
  btn.addEventListener("mouseleave", () => (btn.style.background = "rgba(18, 22, 34, 0.82)"));
  btn.addEventListener("click", onClick);
  return btn;
}

export function initWorkstationPanel(ctx: WebContext): WorkstationPanelAPI {
  let scaffold: ReturnType<typeof buildScaffold> | null = null;
  let controller: WorkstationController | null = null;
  let open_ = false;

  function ensureBuilt(): ReturnType<typeof buildScaffold> {
    if (scaffold) return scaffold;

    scaffold = buildScaffold();
    const { backdrop, panel, list, empty, closeBtn, headerCount, clearBtn } = scaffold;
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);

    const adapter: WorkstationFetchAdapter = {
      subscribeToolInvocations: (listener) => ctx.app.subscribeToolInvocations(listener),
    };
    controller = createWorkstationController(adapter);

    controller.subscribe((state) => {
      render(state, list, empty, headerCount);
    });
    render(controller.getState(), list, empty, headerCount);

    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", close);
    clearBtn.addEventListener("click", () => controller?.clearHistory());

    return scaffold;
  }

  function open(): void {
    if (open_) return;
    const { backdrop, panel } = ensureBuilt();
    open_ = true;
    // Animate in the next frame so the transition fires.
    requestAnimationFrame(() => {
      backdrop.style.opacity = "1";
      backdrop.style.pointerEvents = "auto";
      panel.style.transform = "translate(0, -50%)";
    });
  }

  function close(): void {
    if (!open_ || !scaffold) return;
    open_ = false;
    scaffold.backdrop.style.opacity = "0";
    scaffold.backdrop.style.pointerEvents = "none";
    scaffold.panel.style.transform = "translate(calc(100% + 40px), -50%)";
  }

  function toggle(): void {
    if (open_) close();
    else open();
  }

  function isOpen(): boolean {
    return open_;
  }

  // Mount a floating launcher button in the bottom-right corner so the
  // panel is reachable without a keyboard shortcut. The button itself
  // is tiny and intentionally low-contrast — it's a utility affordance,
  // not a primary surface.
  const launcher = buildLauncher(() => toggle());
  document.body.appendChild(launcher);

  return { open, close, toggle, isOpen };
}
