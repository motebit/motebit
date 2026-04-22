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
  panel: HTMLDivElement;
  list: HTMLDivElement;
  empty: HTMLDivElement;
  closeBtn: HTMLButtonElement;
  headerCount: HTMLSpanElement;
  clearBtn: HTMLButtonElement;
  browserPane: HTMLDivElement;
  browserUrl: HTMLSpanElement;
  browserFrame: HTMLIFrameElement;
} {
  // The panel mounts INSIDE the liquid-glass workstation plane via
  // the renderer's CSS2DObject stage — not as a fixed overlay. Sizing
  // fills the stage element (580×360 by convention); the plane owns
  // the positioning in 3D space, the breathing, and the visibility
  // fade. No backdrop, no fixed-position chrome, no z-index battles
  // with other surfaces.
  const panel = document.createElement("div");
  panel.id = "workstation-panel";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Workstation — motebit tool calls");
  Object.assign(panel.style, {
    width: "100%",
    height: "100%",
    color: "rgba(14, 22, 40, 0.96)",
    // Transparent background — the plane IS the surface. Content sits
    // directly on the glass; no overlay card, no drop shadow, no
    // backdrop-filter duplication.
    background: "transparent",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
    pointerEvents: "auto",
  });

  // Header — tuned for the liquid-glass substrate. Lower contrast
  // than the old dark-panel treatment so text sits on the glass, not
  // against a filled background. No bottom border; a soft separator
  // below is enough on a translucent plane.
  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex",
    alignItems: "center",
    padding: "12px 14px 10px",
    flex: "0 0 auto",
    borderBottom: "1px solid rgba(60, 75, 105, 0.12)",
  });

  const title = document.createElement("span");
  title.textContent = "Workstation";
  Object.assign(title.style, {
    fontSize: "12.5px",
    fontWeight: "600",
    letterSpacing: "0.02em",
    flex: "1 1 auto",
    color: "rgba(20, 30, 50, 0.92)",
  });

  const headerCount = document.createElement("span");
  headerCount.id = "workstation-count";
  Object.assign(headerCount.style, {
    fontSize: "10px",
    color: "rgba(80, 100, 140, 0.72)",
    letterSpacing: "0.04em",
    marginRight: "10px",
    fontFamily: "'SF Mono', Menlo, Consolas, monospace",
  });

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.textContent = "clear";
  clearBtn.title = "Clear history";
  Object.assign(clearBtn.style, {
    background: "transparent",
    border: "none",
    color: "rgba(80, 100, 140, 0.72)",
    cursor: "pointer",
    fontSize: "10.5px",
    padding: "2px 6px",
    marginRight: "6px",
    borderRadius: "3px",
    letterSpacing: "0.04em",
  });
  clearBtn.addEventListener("mouseenter", () => (clearBtn.style.color = "rgba(20, 30, 50, 0.92)"));
  clearBtn.addEventListener(
    "mouseleave",
    () => (clearBtn.style.color = "rgba(80, 100, 140, 0.72)"),
  );

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Close workstation");
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

  // === Browser pane (virtual_browser mode) ===
  // Renders the motebit's currently-read page as a sandboxed iframe
  // sitting directly on the glass. Hidden until the first read_url /
  // virtual_browser / browse_page call arrives.
  const browserPane = document.createElement("div");
  browserPane.id = "workstation-browser";
  Object.assign(browserPane.style, {
    display: "none",
    flexDirection: "column",
    flex: "1 1 auto",
    minHeight: "0",
    borderBottom: "1px solid rgba(60, 75, 105, 0.10)",
    background: "transparent",
  });

  const browserStrip = document.createElement("div");
  Object.assign(browserStrip.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 14px",
    borderBottom: "1px solid rgba(60, 75, 105, 0.08)",
    flex: "0 0 auto",
    fontSize: "10.5px",
    letterSpacing: "0.04em",
    color: "rgba(80, 100, 140, 0.72)",
  });

  const browserLabel = document.createElement("span");
  browserLabel.textContent = "reading";
  Object.assign(browserLabel.style, {
    color: "rgba(100, 120, 155, 0.62)",
    fontSize: "9.5px",
    textTransform: "uppercase",
    letterSpacing: "0.1em",
  });

  const browserUrl = document.createElement("span");
  browserUrl.id = "workstation-browser-url";
  Object.assign(browserUrl.style, {
    fontFamily: "'SF Mono', Menlo, Consolas, monospace",
    fontSize: "10.5px",
    color: "rgba(30, 50, 90, 0.86)",
    flex: "1 1 auto",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  });

  browserStrip.appendChild(browserLabel);
  browserStrip.appendChild(browserUrl);
  browserPane.appendChild(browserStrip);

  const browserFrame = document.createElement("iframe");
  browserFrame.id = "workstation-browser-frame";
  browserFrame.setAttribute("sandbox", "allow-same-origin");
  browserFrame.setAttribute("referrerpolicy", "no-referrer");
  browserFrame.title = "Workstation browser pane";
  Object.assign(browserFrame.style, {
    border: "none",
    width: "100%",
    flex: "1 1 auto",
    minHeight: "180px",
    background: "transparent",
    colorScheme: "light",
  });
  browserPane.appendChild(browserFrame);

  panel.appendChild(browserPane);

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
    padding: "36px 20px",
    textAlign: "center",
    fontSize: "11.5px",
    color: "rgba(90, 110, 150, 0.58)",
    fontStyle: "italic",
  });
  panel.appendChild(empty);

  return {
    panel,
    list,
    empty,
    closeBtn,
    headerCount,
    clearBtn,
    browserPane,
    browserUrl,
    browserFrame,
  };
}

// Reader-mode HTML for rendering the motebit's currently-fetched page
// inside the sandboxed iframe. Same typography + structure treatment
// as the reader view used elsewhere so the two modalities (motebit-
// initiated vs user-initiated page read) look consistent.
function buildReaderSrcdoc(content: string, sourceUrl: string): string {
  const body = parseStructuredText(content);
  const hostAttr = (() => {
    try {
      return escapeHtml(new URL(sourceUrl).href);
    } catch {
      return "";
    }
  })();
  return `<!doctype html><html><head><meta charset="utf-8">${hostAttr ? `<base href="${hostAttr}">` : ""}<style>
    html, body { margin: 0; padding: 0; background: transparent; color-scheme: light; }
    body {
      font-family: ui-serif, "New York", "Iowan Old Style", Charter,
        "Palatino Linotype", Palatino, Georgia, serif;
      font-size: 13.5px;
      line-height: 1.65;
      color: rgba(14, 22, 40, 0.92);
      padding: 16px 22px 22px;
      max-width: 560px;
      word-wrap: break-word;
    }
    h1, h2, h3, h4, h5, h6 {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
      color: rgba(10, 18, 32, 0.98);
      line-height: 1.25;
      margin: 20px 0 8px;
      letter-spacing: -0.02em;
    }
    h1 { font-size: 19px; font-weight: 700; margin-top: 0; }
    h2 { font-size: 16px; font-weight: 600; }
    h3 { font-size: 14px; font-weight: 600; }
    p { margin: 0 0 12px 0; }
    ul { padding-left: 20px; margin: 0 0 12px 0; }
    li { margin-bottom: 4px; }
    a {
      color: rgba(60, 100, 170, 0.92);
      text-decoration: underline;
      text-decoration-thickness: 0.5px;
      text-underline-offset: 3px;
    }
    ::selection { background: rgba(80, 110, 165, 0.25); }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(100, 120, 160, 0.3); border-radius: 3px; }
  </style></head><body><article>${body}</article></body></html>`;
}

function parseStructuredText(source: string): string {
  const lines = source.split(/\n/);
  const out: string[] = [];
  let inList = false;
  let paragraphBuffer: string[] = [];
  const flushParagraph = (): void => {
    if (paragraphBuffer.length === 0) return;
    out.push(`<p>${paragraphBuffer.join("<br>")}</p>`);
    paragraphBuffer = [];
  };
  const closeList = (): void => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") {
      flushParagraph();
      closeList();
      continue;
    }
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      closeList();
      const level = headingMatch[1]!.length;
      out.push(`<h${level}>${inlineMarkdown(headingMatch[2]!)}</h${level}>`);
      continue;
    }
    if (line.startsWith("- ")) {
      flushParagraph();
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inlineMarkdown(line.slice(2))}</li>`);
      continue;
    }
    closeList();
    paragraphBuffer.push(inlineMarkdown(line));
  }
  flushParagraph();
  closeList();
  return out.join("\n");
}

function inlineMarkdown(s: string): string {
  const escaped = escapeHtml(s);
  return escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, href) => {
    if (!/^https?:\/\//i.test(href)) return match;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
}

// --- Receipt row ---

function buildReceiptRow(receipt: ToolInvocationReceiptLike): HTMLDivElement {
  const row = document.createElement("div");
  Object.assign(row.style, {
    padding: "8px 10px",
    borderRadius: "6px",
    marginBottom: "4px",
    // Ultra-subtle background — just enough differentiation to let
    // rows settle into the glass as frosted droplets.
    background: "rgba(255, 255, 255, 0.32)",
    fontSize: "11.5px",
    lineHeight: "1.4",
    border: "1px solid rgba(100, 120, 155, 0.08)",
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

  // Clicking a row copies the full receipt JSON to the clipboard —
  // lets the user paste it into a third-party verifier without the
  // panel needing its own verify flow in the MVP.
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

function render(
  state: WorkstationState,
  refs: {
    list: HTMLDivElement;
    empty: HTMLDivElement;
    headerCount: HTMLSpanElement;
    browserPane: HTMLDivElement;
    browserUrl: HTMLSpanElement;
    browserFrame: HTMLIFrameElement;
  },
  cache: { lastPageInvocationId: string | null },
): void {
  refs.headerCount.textContent =
    state.receiptCount > 0
      ? `${state.receiptCount} call${state.receiptCount === 1 ? "" : "s"}`
      : "";

  // Browser pane — live. Only rebuild the iframe srcdoc when the
  // page actually changes (by invocation_id); re-rendering on every
  // receipt would reset scroll position on every row arrival.
  if (state.currentPage) {
    refs.browserPane.style.display = "flex";
    refs.browserUrl.textContent = state.currentPage.url;
    if (cache.lastPageInvocationId !== state.currentPage.invocation_id) {
      refs.browserFrame.srcdoc = buildReaderSrcdoc(
        state.currentPage.content,
        state.currentPage.url,
      );
      cache.lastPageInvocationId = state.currentPage.invocation_id;
    }
  } else {
    refs.browserPane.style.display = "none";
  }

  if (state.history.length === 0) {
    refs.list.style.display = "none";
    // Hide the empty card when the browser pane is showing a page —
    // "No tool calls yet" under a live page would be misleading.
    refs.empty.style.display = state.currentPage ? "none" : "block";
    return;
  }
  refs.list.style.display = "block";
  refs.empty.style.display = "none";
  refs.list.innerHTML = "";
  // Newest on top reads better for a live stream — UI inverts order.
  for (let i = state.history.length - 1; i >= 0; i--) {
    refs.list.appendChild(buildReceiptRow(state.history[i]!));
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

export function initWorkstationPanel(ctx: WebContext): WorkstationPanelAPI {
  let scaffold: ReturnType<typeof buildScaffold> | null = null;
  let controller: WorkstationController | null = null;
  let open_ = false;

  // The renderer exposes the liquid-glass plane's stage mount. When
  // present, we render ONTO the plane (primary path). When absent
  // (headless tests, WebGL unavailable) we fall back to a fixed
  // overlay so the surface still functions without 3D.
  const renderer = ctx.app.getRenderer?.() ?? null;

  function ensureBuilt(): ReturnType<typeof buildScaffold> {
    if (scaffold) return scaffold;

    scaffold = buildScaffold();
    const { list, empty, closeBtn, headerCount, clearBtn, browserPane, browserUrl, browserFrame } =
      scaffold;

    const adapter: WorkstationFetchAdapter = {
      subscribeToolInvocations: (listener) => ctx.app.subscribeToolInvocations(listener),
      subscribeToolActivity: (listener) => ctx.app.subscribeToolActivity(listener),
    };
    controller = createWorkstationController(adapter);

    const renderRefs = { list, empty, headerCount, browserPane, browserUrl, browserFrame };
    // Scroll-preservation cache for the iframe — see render() comment.
    const renderCache = { lastPageInvocationId: null as string | null };

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
      // Primary path: mount the panel on the liquid-glass plane. The
      // plane owns positioning (next to the creature), breathing, and
      // the visibility fade. No fixed-position overlay, no backdrop.
      renderer.setWorkstationStageChild(panel);
      renderer.setWorkstationVisible(true);
    } else {
      // Fallback path (WebGL unavailable / NullAdapter / tests):
      // float as a fixed overlay so the surface still functions.
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

  // Floating launcher button — bottom-right, beside the sovereign
  // button. Tuned for the liquid-glass aesthetic (semi-transparent
  // white with blur) instead of the previous dark chip.
  const launcher = buildLauncher(() => toggle());
  document.body.appendChild(launcher);

  return { open, close, toggle, isOpen };
}
