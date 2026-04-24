/**
 * Per-kind slab-item renderers for the web surface.
 *
 * Sibling-boundary note: this file mirrors `apps/desktop/src/ui/slab-items.ts`.
 * Both surfaces render HTML cards onto the Three.js slab plane via
 * CSS2DObject and produce identical output. Changes here MUST be
 * mirrored to the desktop sibling (and any future HTML-surface
 * sibling) until three consumers exist — at that point, extract to
 * a shared `@motebit/panels`-style render package per the panels-
 * pattern doctrine. Two copies is the pre-extraction threshold.
 *
 * The runtime's `SlabController` emits typed `SlabItem` events, the
 * runtime's bridge diffs them, and here — the web-specific rendering
 * layer — is where each kind becomes a real HTMLElement mounted on
 * the slab's liquid-glass plane.
 *
 * See docs/doctrine/motebit-computer.md for what each kind means in
 * the slab's lifecycle. Styling conventions:
 *
 *   - The slab's plane is the substrate — cards are what's *on* it,
 *     not a separate product. They read as frosted droplets frozen
 *     to a glass sheet: high-contrast ink, rim-lit top edge, soft
 *     cast shadow below. The slab-ness shows through the glass
 *     between and beneath them.
 *   - Inline styles only — no stylesheet coupling. Values match
 *     across web and desktop so the siblings stay byte-aligned until
 *     a third HTML surface justifies extraction.
 *   - Per-kind identity lives in typography and a hairline glyph,
 *     not color-noise. Stream is monospace (live typing). Tool call
 *     is a chip. Plan step is a numbered badge. The others share a
 *     glyph-and-label head.
 */

import { stripInternalTags } from "@motebit/ai-core";
import type { SlabItem, SlabItemActions, ArtifactKindForDetach } from "@motebit/runtime";

// ── Hover-close affordance ────────────────────────────────────────────
//
// Under the workstation frame (motebit-computer.md §"Affordances that
// emerge from the surface, not conventional window chrome"): desktop
// pointers need a close affordance, but it must read as a droplet
// meniscus-dip, not a gray OS button. The × only materializes on
// pointerenter, dissolves on leave, and routes through the typed
// `actions.dismiss` capability — never a constructed prompt.
//
// The card stays operational (tap-to-expand, pointerdown tracking)
// while the close is present; the × stops pointer events from reaching
// the card so a click on × is unambiguously "dismiss," not "expand."

function attachHoverClose(card: HTMLDivElement, actions: SlabItemActions): void {
  // Use a span with role=button rather than an HTMLButtonElement. Inside
  // a CSS2DRenderer overlay (which applies 3D transforms + positions its
  // root with `pointer-events: none`), <button>s can swallow the
  // synthesized `click` event inconsistently — the user sees a styled
  // button that doesn't fire. A role=button span with an explicit
  // `pointerup` activation is the defensive path and routes through
  // `actions.dismiss` per surface-determinism.
  const close = document.createElement("span");
  close.setAttribute("role", "button");
  close.setAttribute("aria-label", "Dismiss");
  close.setAttribute("tabindex", "0");
  close.textContent = "×";
  close.style.position = "absolute";
  close.style.top = "4px";
  close.style.right = "4px";
  close.style.width = "18px";
  close.style.height = "18px";
  close.style.display = "inline-flex";
  close.style.alignItems = "center";
  close.style.justifyContent = "center";
  close.style.fontSize = "13px";
  close.style.lineHeight = "1";
  close.style.color = "rgba(40, 55, 90, 0.82)";
  // Meniscus dip — soft circular dimple, not a gray OS button. Reads
  // as part of the droplet's surface.
  close.style.background = "rgba(255, 255, 255, 0.62)";
  close.style.border = "1px solid rgba(120, 140, 180, 0.35)";
  close.style.borderRadius = "999px";
  close.style.cursor = "pointer";
  close.style.userSelect = "none";
  close.style.opacity = "0";
  close.style.transform = "scale(0.85)";
  close.style.transition = "opacity 120ms ease-out, transform 120ms ease-out";
  // `visibility` (rather than `pointer-events: none`) gates
  // interactability — avoids a pointer-events race in CSS2DRenderer
  // where a freshly-revealed button could miss the first click.
  close.style.visibility = "hidden";
  // Always pointer-events: auto so when visible, the span is a
  // reliable click target; visibility handles the rest.
  close.style.pointerEvents = "auto";
  // Z-layer the close above any other absolutely-positioned siblings
  // so it's never occluded by card content that happens to stack.
  close.style.zIndex = "10";

  let concealTimer: ReturnType<typeof setTimeout> | null = null;
  const reveal = (): void => {
    if (concealTimer != null) {
      clearTimeout(concealTimer);
      concealTimer = null;
    }
    close.style.visibility = "visible";
    close.style.opacity = "1";
    close.style.transform = "scale(1)";
  };
  const conceal = (): void => {
    close.style.opacity = "0";
    close.style.transform = "scale(0.85)";
    // Let the fade play, then pull visibility so the element stops
    // being a hit target. ~150ms > the 120ms transition.
    if (concealTimer != null) clearTimeout(concealTimer);
    concealTimer = setTimeout(() => {
      concealTimer = null;
      close.style.visibility = "hidden";
    }, 150);
  };
  card.addEventListener("pointerenter", reveal);
  card.addEventListener("pointerleave", conceal);

  const dismiss = (ev: Event): void => {
    ev.stopPropagation();
    ev.preventDefault();
    // Soft exit animation; dissolve physics handled by the controller.
    card.style.transition = "transform 140ms ease-out, opacity 140ms ease-out";
    card.style.opacity = "0";
    card.style.transform = "scale(0.94)";
    actions.dismiss();
  };
  // Use pointerup (not click). Click synthesis inside CSS2DRenderer is
  // unreliable in some browsers; pointerup fires directly from the
  // input pipeline and is robust.
  close.addEventListener("pointerup", dismiss);
  close.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  // Keyboard path — when the × has focus, Enter/Space activate.
  close.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") dismiss(ev);
  });

  // Card must be positioned for absolute child to anchor correctly.
  if (card.style.position === "" || card.style.position === "static") {
    card.style.position = "relative";
  }
  card.appendChild(close);
}

// ── Common card chrome ────────────────────────────────────────────────

function baseCard(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "slab-item";
  el.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif";
  el.style.fontSize = "12.5px";
  el.style.lineHeight = "1.5";
  el.style.letterSpacing = "-0.005em";
  // Near-black ink. The slab below is glass, so the text has to be
  // dark enough to read against any environment behind the plane.
  el.style.color = "rgba(14, 22, 40, 0.96)";
  el.style.padding = "0";
  // Frosted-glass body with a gradient top→bottom so the card
  // appears to catch light from above, like a droplet frozen on a
  // sheet. Values are tuned for the light environment; the backdrop
  // blur carries refraction from whatever's behind the plane.
  el.style.background =
    "linear-gradient(180deg, rgba(255,255,255,0.78) 0%, rgba(246,250,255,0.64) 100%)";
  el.style.border = "1px solid rgba(255, 255, 255, 0.55)";
  el.style.borderRadius = "10px";
  el.style.backdropFilter = "blur(14px) saturate(1.25)";
  el.style.setProperty("-webkit-backdrop-filter", "blur(14px) saturate(1.25)");
  el.style.boxShadow = [
    // Top rim — the surface-tension highlight where the card meets light.
    "0 1px 0 rgba(255,255,255,0.72) inset",
    // Bottom inset — a thin darker line reading as the droplet's base.
    "0 -1px 0 rgba(25,35,60,0.06) inset",
    // Subtle cast — the primary embodiment sits ON the plane, not
    // levitating off it. Lighter shadow than when cards stacked.
    "0 1px 4px rgba(20,30,60,0.08)",
  ].join(", ");
  // Primary embodiment fills the stage entirely — it IS the screen's
  // current view. Width/height 100% inherits from the stage's fixed
  // 480×300 footprint; cards aren't stacked anymore so there's no
  // flex child sizing to accommodate.
  el.style.width = "100%";
  el.style.height = "100%";
  el.style.boxSizing = "border-box";
  el.style.overflow = "hidden";
  el.style.wordBreak = "break-word";
  el.style.display = "flex";
  el.style.flexDirection = "column";
  return el;
}

/**
 * Window chrome — a subtle header strip at the top of a card that names
 * what kind of activity this window is, the way a browser tab strip
 * or a terminal's prompt line tells you what you're looking at.
 * Droplet-physics-native, not OS chrome: it's a hairline band, not a
 * titlebar with stoplights.
 */
function windowChrome(glyph: string, label: string, context?: string): HTMLDivElement {
  const bar = document.createElement("div");
  bar.className = "slab-item-chrome";
  bar.style.display = "flex";
  bar.style.alignItems = "center";
  bar.style.gap = "8px";
  bar.style.padding = "8px 12px";
  bar.style.borderBottom = "1px solid rgba(120, 140, 180, 0.18)";
  bar.style.background = "linear-gradient(180deg, rgba(255,255,255,0.4) 0%, transparent 100%)";
  bar.style.fontSize = "10px";
  bar.style.letterSpacing = "0.08em";
  bar.style.textTransform = "uppercase";
  bar.style.color = "rgba(55, 72, 110, 0.82)";
  bar.style.fontWeight = "600";
  if (glyph) {
    const g = document.createElement("span");
    g.textContent = glyph;
    g.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
    g.style.fontSize = "11px";
    g.style.color = "rgba(80, 110, 165, 0.92)";
    g.style.textTransform = "none";
    g.style.letterSpacing = "0";
    bar.appendChild(g);
  }
  const l = document.createElement("span");
  l.textContent = label;
  l.style.flex = "0 0 auto";
  bar.appendChild(l);
  if (context) {
    const c = document.createElement("span");
    c.dataset.slot = "chrome-context";
    c.textContent = context;
    c.style.flex = "1 1 auto";
    c.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
    c.style.fontSize = "11px";
    c.style.fontWeight = "400";
    c.style.letterSpacing = "0";
    c.style.textTransform = "none";
    c.style.color = "rgba(80, 110, 165, 0.85)";
    c.style.whiteSpace = "nowrap";
    c.style.overflow = "hidden";
    c.style.textOverflow = "ellipsis";
    c.style.marginLeft = "4px";
    bar.appendChild(c);
  }
  return bar;
}

/** Card body — the content area below the window chrome. */
function cardBody(): HTMLDivElement {
  const body = document.createElement("div");
  body.className = "slab-item-body";
  body.style.padding = "12px 14px";
  return body;
}

function textRow(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "slab-item-text";
  el.style.whiteSpace = "pre-wrap";
  return el;
}

/** Kind-specific glyph shown before the label row. Empty string for stream. */
function kindGlyph(kind: SlabItem["kind"]): string {
  switch (kind) {
    case "tool_call":
      return "◇";
    case "shell":
      return "$";
    case "fetch":
      return "↗";
    case "embedding":
      return "∿";
    case "delegation":
      return "⇝";
    case "memory":
      return "◉";
    case "stream":
    case "plan_step":
    default:
      return "";
  }
}

function headRow(glyph: string, label: string): HTMLDivElement {
  const head = document.createElement("div");
  head.className = "slab-item-head";
  head.style.display = "flex";
  head.style.alignItems = "center";
  head.style.gap = "6px";
  head.style.marginBottom = "4px";
  if (glyph) {
    const g = document.createElement("span");
    g.textContent = glyph;
    g.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
    g.style.fontSize = "11px";
    g.style.color = "rgba(80, 110, 165, 0.9)";
    head.appendChild(g);
  }
  const l = document.createElement("span");
  l.className = "slab-item-label";
  l.textContent = label;
  l.style.fontSize = "9.5px";
  l.style.fontWeight = "600";
  l.style.letterSpacing = "0.08em";
  l.style.textTransform = "uppercase";
  l.style.color = "rgba(55, 72, 110, 0.82)";
  head.appendChild(l);
  return head;
}

// ── Per-kind renderers ───────────────────────────────────────────────

function renderStream(item: SlabItem): HTMLElement {
  const card = baseCard();
  card.classList.add("slab-item-stream");
  // Stream is the motebit's response — a document view, not a status
  // chip. No URL bar or prompt chrome; clean rendered prose fills
  // the window like a reader view.
  const body = cardBody();
  body.style.padding = "14px 16px";
  const text = document.createElement("div");
  text.className = "slab-item-text";
  text.style.fontSize = "12.5px";
  text.style.lineHeight = "1.55";
  text.style.color = "rgba(18, 28, 50, 0.94)";
  text.style.maxHeight = "260px";
  text.style.overflow = "auto";
  text.style.wordBreak = "break-word";
  const payload = item.payload as { text?: string } | null;
  text.innerHTML = renderStreamMarkdown(payload?.text ?? "");
  body.appendChild(text);
  card.appendChild(body);
  return card;
}

function updateStream(item: SlabItem, element: HTMLElement): void {
  const text = element.querySelector(".slab-item-text");
  const payload = item.payload as { text?: string } | null;
  if (text instanceof HTMLElement) {
    // Preserve scroll position if the user has scrolled up to read;
    // stick to the bottom when they're already at the bottom. This
    // matches standard chat-log behavior — follow-the-tail by default,
    // but don't yank the user away from their reading position.
    const atBottom = text.scrollTop + text.clientHeight >= text.scrollHeight - 8;
    text.innerHTML = renderStreamMarkdown(payload?.text ?? "");
    if (atBottom) text.scrollTop = text.scrollHeight;
  }
}

// Local markdown renderer — intentionally inlined so the web + desktop
// siblings stay byte-aligned. If a third HTML surface justifies
// extraction, lift this and chat's copy into a shared package per the
// panels-pattern doctrine. Tag-stripping itself routes through the
// canonical `stripInternalTags` primitive in @motebit/ai-core
// (drift-defense #41) — one regex set across every chat-surface.

function renderStreamMarkdown(raw: string): string {
  const cleaned = stripInternalTags(raw).trim();
  const escaped = cleaned.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .replace(/```(\w*)\n([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
    .replace(
      /`([^`]+)`/g,
      '<code style="background:rgba(0,0,0,0.06);padding:1px 4px;border-radius:3px;font-size:0.9em;">$1</code>',
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/^#{3,6}\s+(.+)$/gm, '<div style="font-weight:600;margin:8px 0 4px;">$1</div>')
    .replace(
      /^#{1,2}\s+(.+)$/gm,
      '<div style="font-weight:600;font-size:1.05em;margin:8px 0 4px;">$1</div>',
    )
    .replace(/^[*-]\s+(.+)$/gm, '<div style="padding-left:12px;">• $1</div>')
    .replace(/^(\d+)\.\s+(.+)$/gm, '<div style="padding-left:12px;">$1. $2</div>')
    .replace(/\n\n/g, '<div style="height:8px;"></div>')
    .replace(/\n/g, "<br>");
}

// Tool-name → kind-of-experience routing. The runtime emits
// `tool_call` slab items uniformly with `payload.name`; the renderer
// specializes per-kind so the slab shows perception/action instead of
// a status label. Doctrine (motebit-computer.md): the slab renders
// what the motebit sees, does, and thinks — the tool name tells us
// which organ's rendering to reach for.
const FETCH_TOOLS: ReadonlySet<string> = new Set(["read_url", "fetch_url"]);
const SHELL_TOOLS: ReadonlySet<string> = new Set([
  "shell_exec",
  "bash",
  "shell",
  "exec",
  "run_command",
]);

function renderToolCall(item: SlabItem, actions: SlabItemActions): HTMLElement {
  const payload = item.payload as {
    name?: string;
    status?: string;
    context?: string;
    result?: unknown;
  } | null;
  if (payload?.name != null && FETCH_TOOLS.has(payload.name)) {
    return renderFetch(item, actions);
  }
  if (payload?.name != null && SHELL_TOOLS.has(payload.name)) {
    return renderShell(item, actions);
  }
  const card = baseCard();
  card.classList.add("slab-item-tool-call");
  card.appendChild(windowChrome("◇", payload?.name ?? "tool"));
  const body = cardBody();
  const status = textRow();
  status.style.fontSize = "12.5px";
  status.style.color = "rgba(50, 66, 98, 0.82)";
  status.textContent = formatToolStatus(payload);
  status.dataset.slot = "status";
  body.appendChild(status);
  card.appendChild(body);
  return card;
}

function updateToolCall(item: SlabItem, element: HTMLElement): void {
  const payload = item.payload as {
    name?: string;
    status?: string;
    context?: string;
    result?: unknown;
  } | null;
  if (payload?.name != null && FETCH_TOOLS.has(payload.name)) {
    updateFetch(item, element);
    return;
  }
  if (payload?.name != null && SHELL_TOOLS.has(payload.name)) {
    updateShell(item, element);
    return;
  }
  const status = element.querySelector('[data-slot="status"]');
  if (status instanceof HTMLElement) {
    status.textContent = formatToolStatus(payload);
  }
}

function formatToolStatus(
  payload: { status?: string; context?: string; result?: unknown } | null,
): string {
  if (payload == null) return "calling…";
  if (payload.status === "calling") {
    return payload.context ? `calling: ${payload.context}` : "calling…";
  }
  if (payload.result != null) {
    const resultText =
      typeof payload.result === "string" ? payload.result : JSON.stringify(payload.result);
    // Keep the slab card compact; the detached artifact carries the
    // full result if the caller chose to detach.
    return resultText.length > 100 ? resultText.slice(0, 97) + "…" : resultText;
  }
  return "done";
}

// ── Fetch — the motebit's eye on a page ───────────────────────────────
//
// The first kind rendered as perception rather than status. The card
// shows the host/path the motebit is looking at, and the page text
// fades in as the motebit reads it. No "calling…" string; the empty
// body IS the "not yet seen" state. When the fetch completes, the
// first ~240 characters of the cleaned page appear — that's what the
// motebit perceived at the moment of reading.

function renderFetch(item: SlabItem, actions: SlabItemActions): HTMLElement {
  const card = baseCard();
  card.classList.add("slab-item-fetch");
  card.style.cursor = "pointer";
  card.style.touchAction = "pan-y"; // keep vertical page scroll; horizontal becomes swipe
  attachFetchGestures(card, actions);

  // Browser-like window chrome. Favicon + host (left), path (middle),
  // reading time (right). The entire bar is clickable — opens the
  // source URL in a new tab for users who want to see the live page.
  const chrome = document.createElement("div");
  chrome.className = "slab-item-chrome";
  chrome.dataset.slot = "chrome";
  chrome.style.display = "flex";
  chrome.style.alignItems = "center";
  chrome.style.gap = "10px";
  chrome.style.padding = "8px 12px";
  chrome.style.borderBottom = "1px solid rgba(120, 140, 180, 0.18)";
  chrome.style.background = "linear-gradient(180deg, rgba(255,255,255,0.4) 0%, transparent 100%)";
  chrome.style.cursor = "pointer";
  chrome.title = "Open source page";

  const favicon = document.createElement("img");
  favicon.dataset.slot = "favicon";
  favicon.width = 14;
  favicon.height = 14;
  favicon.style.width = "14px";
  favicon.style.height = "14px";
  favicon.style.borderRadius = "2px";
  favicon.style.flex = "0 0 auto";
  favicon.style.visibility = "hidden"; // becomes visible on load
  favicon.alt = "";
  favicon.onerror = () => {
    favicon.style.visibility = "hidden";
  };
  favicon.onload = () => {
    favicon.style.visibility = "visible";
  };
  chrome.appendChild(favicon);

  const hostEl = document.createElement("span");
  hostEl.dataset.slot = "host";
  hostEl.style.fontSize = "10px";
  hostEl.style.fontWeight = "600";
  hostEl.style.letterSpacing = "0.08em";
  hostEl.style.textTransform = "uppercase";
  hostEl.style.color = "rgba(55, 72, 110, 0.82)";
  hostEl.style.flex = "0 0 auto";
  chrome.appendChild(hostEl);

  const pathEl = document.createElement("span");
  pathEl.dataset.slot = "path";
  pathEl.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
  pathEl.style.fontSize = "11px";
  pathEl.style.color = "rgba(80, 110, 165, 0.78)";
  pathEl.style.whiteSpace = "nowrap";
  pathEl.style.overflow = "hidden";
  pathEl.style.textOverflow = "ellipsis";
  pathEl.style.flex = "1 1 auto";
  chrome.appendChild(pathEl);

  const metaEl = document.createElement("span");
  metaEl.dataset.slot = "meta";
  metaEl.style.fontSize = "10px";
  metaEl.style.color = "rgba(95, 115, 155, 0.72)";
  metaEl.style.flex = "0 0 auto";
  metaEl.style.letterSpacing = "0.02em";
  chrome.appendChild(metaEl);

  card.appendChild(chrome);

  // Reader view — the fetched page rendered inside a sandboxed
  // iframe. `srcdoc` with our own reader-mode HTML wraps the
  // motebit's cleaned text content in legible article typography.
  // The iframe is a real browser rendering surface, not a text
  // block — scroll, copy, selection all behave natively. Sandbox
  // locks scripts/forms/popups so untrusted page content can't
  // escape. No external resources fetched (self-contained srcdoc).
  const frame = document.createElement("iframe");
  frame.dataset.slot = "frame";
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.style.border = "none";
  frame.style.width = "100%";
  // Fill whatever vertical space the card has after the chrome.
  frame.style.flex = "1 1 auto";
  frame.style.minHeight = "0";
  frame.style.display = "block";
  frame.style.background = "transparent";
  frame.style.colorScheme = "light";
  card.appendChild(frame);

  applyFetchPayload(item.payload, { chrome, favicon, hostEl, pathEl, metaEl, frame });
  return card;
}

function updateFetch(item: SlabItem, element: HTMLElement): void {
  const chrome = element.querySelector('[data-slot="chrome"]');
  const favicon = element.querySelector('[data-slot="favicon"]');
  const hostEl = element.querySelector('[data-slot="host"]');
  const pathEl = element.querySelector('[data-slot="path"]');
  const metaEl = element.querySelector('[data-slot="meta"]');
  const frame = element.querySelector('[data-slot="frame"]');
  if (
    chrome instanceof HTMLElement &&
    favicon instanceof HTMLImageElement &&
    hostEl instanceof HTMLElement &&
    pathEl instanceof HTMLElement &&
    metaEl instanceof HTMLElement &&
    frame instanceof HTMLIFrameElement
  ) {
    applyFetchPayload(item.payload, { chrome, favicon, hostEl, pathEl, metaEl, frame });
  }
}

interface FetchCardParts {
  chrome: HTMLElement;
  favicon: HTMLImageElement;
  hostEl: HTMLElement;
  pathEl: HTMLElement;
  metaEl: HTMLElement;
  frame: HTMLIFrameElement;
}

function applyFetchPayload(payload: unknown, parts: FetchCardParts): void {
  const p = payload as { context?: string; status?: string; result?: unknown } | null;
  const raw = p?.context ?? "";
  const parsed = parseUrl(raw);
  parts.hostEl.textContent = parsed.host || (p?.status === "calling" ? "reading" : "");
  parts.pathEl.textContent = parsed.path || (parsed.host ? "/" : raw);

  // Favicon via Google's favicon service — no CORS, small, reliable.
  // Doesn't leak referer (Google's service is the origin that hits
  // the target site, not the user). Updates when the host changes.
  if (parsed.host && parts.favicon.dataset.host !== parsed.host) {
    parts.favicon.dataset.host = parsed.host;
    parts.favicon.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(
      parsed.host,
    )}&sz=32`;
  }

  // Source-URL click — the chrome bar opens the original page in a
  // new tab. Noopener/noreferrer prevents the opened page from
  // reaching back into the app.
  if (raw && parts.chrome.dataset.sourceUrl !== raw) {
    parts.chrome.dataset.sourceUrl = raw;
    parts.chrome.onclick = (ev) => {
      // Don't trigger if the user is swiping — gestures handled
      // at the card level. Chrome click is a deliberate tap.
      ev.stopPropagation();
      window.open(raw, "_blank", "noopener,noreferrer");
    };
  }

  const preview = extractFetchPreview(p);
  parts.metaEl.textContent = estimateReadingTime(preview);
  const srcdoc = buildReaderSrcdoc(preview, parsed.host, raw);
  // Only re-assign srcdoc when content actually changes — avoids
  // reloading the iframe on every tick during streaming state
  // transitions.
  if (parts.frame.dataset.content !== preview) {
    parts.frame.dataset.content = preview;
    parts.frame.srcdoc = srcdoc;
  }
}

/**
 * Human-readable reading-time estimate from the page's word count.
 * 220 wpm is the commonly-cited average adult reading speed (slightly
 * faster than Medium's 200; slightly slower than speed-readers'
 * 250+). Ceiling at 30 min — longer than that we just show "30m+".
 * Empty content → empty string (no label while the page is loading).
 */
function estimateReadingTime(text: string): string {
  if (!text) return "";
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return "";
  const minutes = Math.max(1, Math.round(words / 220));
  return minutes >= 30 ? "30m+" : `${minutes} min read`;
}

/**
 * Build a self-contained HTML document to hand to the iframe's
 * `srcdoc`. Parses the motebit's structured-text output (from the
 * upgraded read_url tool) back into proper HTML — headings, lists,
 * links — and wraps in reader-mode article typography.
 *
 * Under the `virtual_browser` embodiment mode, this is the page the
 * motebit is looking at, rendered as a real article in the plane —
 * not "text about the page."
 *
 * Marker conventions (produced by read_url):
 *   `# Title`        → <h1>Title</h1>
 *   `## Subhead`     → <h2>…</h2>, up to ###### h6
 *   `- bullet item`  → <ul><li>…</li></ul> (consecutive grouped)
 *   `[text](href)`   → <a href="href">text</a>
 *   double newline   → paragraph break
 *   single newline   → <br>
 *
 * No scripts, no external resources in the rendered fragment; sandbox
 * on the iframe enforces it at the browser level too. Relative links
 * in the source `<a href>` resolve against a `<base>` pointed at the
 * source host.
 */
function buildReaderSrcdoc(text: string, host: string, baseUrl?: string): string {
  const body = text.trim().length > 0 ? parseStructuredText(text) : emptyPlaceholder(host);
  const base = baseUrl ? `<base href="${escapeHtml(baseUrl)}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8">${base}<style>
    html, body { margin: 0; padding: 0; background: transparent; }
    body {
      /* ui-serif is the CSS4 keyword for "the system's serif body
         font" — on macOS this resolves to New York (Apple's system
         serif), on Windows to Cambria, with Iowan Old Style / Charter
         / Georgia as graceful fallbacks. A real article-quality
         reading typeface across every platform. */
      font-family: ui-serif, "New York", "Iowan Old Style", Charter,
        "Palatino Linotype", Palatino, Georgia, serif;
      font-size: 15px;
      line-height: 1.7;
      color: rgba(14, 22, 40, 0.94);
      padding: 22px 28px 28px;
      max-width: 640px;
      word-wrap: break-word;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: optimizeLegibility;
      font-feature-settings: "kern", "liga", "calt";
    }
    article { letter-spacing: -0.003em; }
    h1, h2, h3, h4, h5, h6 {
      /* Headings lift into the system sans — tighter, more display-
         oriented. Mirrors the aesthetic split in Apple's own reader
         views (New York body, SF display headers). */
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display",
        system-ui, sans-serif;
      color: rgba(10, 18, 32, 0.98);
      line-height: 1.25;
      margin: 26px 0 12px;
      letter-spacing: -0.02em;
      font-feature-settings: "kern", "liga", "ss01";
    }
    h1 { font-size: 24px; font-weight: 700; margin-top: 0; letter-spacing: -0.025em; }
    h2 { font-size: 19px; font-weight: 600; }
    h3 { font-size: 16px; font-weight: 600; }
    h4, h5, h6 { font-size: 14px; font-weight: 600; text-transform: none; }
    /* Magazine-style first-paragraph opener after H1 — subtle drop-cap-
       adjacent treatment via a raised first-letter size. Gives the
       article a "beginning," not just a top line. */
    h1 + p::first-letter {
      font-size: 1.3em;
      font-weight: 500;
    }
    p { margin: 0 0 14px 0; }
    p:last-child, li:last-child { margin-bottom: 0; }
    ul { padding-left: 22px; margin: 0 0 14px 0; }
    li { margin-bottom: 6px; }
    a {
      color: rgba(80, 110, 165, 0.95);
      text-decoration: underline;
      text-underline-offset: 3px;
      text-decoration-thickness: 0.5px;
      text-decoration-color: rgba(120, 140, 180, 0.55);
    }
    a:hover {
      color: rgba(55, 85, 140, 1);
      text-decoration-color: rgba(80, 110, 165, 0.8);
    }
    p.empty {
      color: rgba(80, 110, 165, 0.6);
      font-style: italic;
    }
    ::selection { background: rgba(80, 110, 165, 0.25); }
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(120, 140, 180, 0.3); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(120, 140, 180, 0.5); }
  </style></head><body><article>${body}</article></body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function emptyPlaceholder(host: string): string {
  return `<p class="empty">${host ? "reading " + escapeHtml(host) + "…" : ""}</p>`;
}

/**
 * Parse the structured-text markers produced by read_url back into
 * HTML. Consumes the source line-by-line, grouping consecutive list
 * items into a single <ul>, wrapping non-marker paragraphs in <p>,
 * and converting inline `[text](href)` patterns to anchor tags.
 *
 * All text is HTML-escaped before marker interpretation so the
 * source content can't inject tags. Link hrefs are validated to
 * http(s) schemes so javascript: URLs can't slip in.
 */
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
    // Heading (# .. ######)
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      closeList();
      const level = headingMatch[1]!.length;
      const content = inlineMarkdown(headingMatch[2]!);
      out.push(`<h${level}>${content}</h${level}>`);
      continue;
    }
    // List item
    if (line.startsWith("- ")) {
      flushParagraph();
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inlineMarkdown(line.slice(2))}</li>`);
      continue;
    }
    // Regular paragraph line
    closeList();
    paragraphBuffer.push(inlineMarkdown(line));
  }
  flushParagraph();
  closeList();
  return out.join("\n");
}

/** Convert inline `[text](href)` markers to anchor tags. Escapes text. */
function inlineMarkdown(s: string): string {
  const escaped = escapeHtml(s);
  // Inline link pattern. After escaping, brackets and parens are still
  // `[` `]` `(` `)` — they weren't entity-encoded above — so the regex
  // still matches. href is validated to http(s) only; anything else
  // renders as plain text to avoid javascript: URLs.
  return escaped.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (match: string, text: string, href: string) => {
      if (!/^https?:\/\//i.test(href)) return match;
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  );
}

function parseUrl(raw: string): { host: string; path: string } {
  if (!raw) return { host: "", path: "" };
  try {
    const u = new URL(raw);
    const host = u.host.replace(/^www\./, "");
    const path = u.pathname + u.search;
    return { host, path: path === "" ? "/" : path };
  } catch {
    return { host: "", path: raw };
  }
}

function extractFetchPreview(payload: { status?: string; result?: unknown } | null): string {
  // While the fetch is in flight, the body is honestly empty — no
  // "calling…" string. The motebit has not perceived anything yet.
  if (payload == null || payload.status === "calling") return "";
  const r = payload.result;
  if (r == null) return "";
  let text: string;
  if (typeof r === "string") {
    text = r;
  } else if (typeof r === "object") {
    const data = (r as { data?: unknown; error?: unknown }).data;
    const error = (r as { data?: unknown; error?: unknown }).error;
    if (typeof data === "string") text = data;
    else if (typeof error === "string") text = error;
    else text = JSON.stringify(r);
  } else if (typeof r === "number" || typeof r === "boolean" || typeof r === "bigint") {
    text = String(r);
  } else {
    // symbol / function — not reachable from tool results in practice.
    text = "";
  }
  // Preserve paragraph breaks and Markdown-ish structure markers from
  // the tool; the renderer parses them back into HTML headings, lists,
  // and links. Only collapse intra-line whitespace.
  const cleaned = text
    .replace(/\n\s*\n/g, "\n\n")
    .replace(/[^\S\n]+/g, " ")
    .trim();
  // Reader view caps at 16KB (matches read_url tool's new cap). The
  // iframe scrolls for longer pages.
  return cleaned.length > 16000 ? cleaned.slice(0, 16000) + "\n\n…" : cleaned;
}

// ── Gestures: tap to expand, swipe to dismiss ─────────────────────────
//
// Doctrine (motebit-computer.md §"The user's touch — supervised agency"):
// gestures are physical forces on the droplets, not chrome. Tap pauses
// the dissolve timer and reveals detail in place — here, it toggles
// the fetch preview's truncation vignette so the user can read the
// whole thing. Swipe is force-dissolve: the card ripples back into
// the slab surface immediately, via the typed `actions.dismiss`
// capability.
//
// Only the fetch kind wires these on this pass. Subsequent rich
// kinds (shell, delegation, memory) attach the same scaffolding;
// extracting to a helper when that happens is the three-consumer
// threshold from the panels-pattern doctrine.

const SWIPE_PX = 60; // horizontal threshold before swipe fires
const SWIPE_MAX_ANGLE = 0.8; // radians — ignore vertical-heavy motion

function attachFetchGestures(card: HTMLDivElement, actions: SlabItemActions): void {
  // Body scrolls natively now — no expand/collapse toggle needed. The
  // window-sized reader view gives enough room that users can read
  // long pages inline by scrolling within the body element.

  // Swipe — pointer down, track horizontal delta, release past
  // threshold triggers dismiss. Routes through `actions.dismiss`
  // which the bridge mapped to `controller.dismissItem(id)`. No
  // prompt construction; typed capability per surface-determinism.
  let startX = 0;
  let startY = 0;
  let tracking = false;
  card.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    startX = ev.clientX;
    startY = ev.clientY;
    tracking = true;
  });
  card.addEventListener("pointerup", (ev) => {
    if (!tracking) return;
    tracking = false;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dx) < SWIPE_PX) return;
    if (Math.abs(dy) > Math.abs(dx) * Math.tan(SWIPE_MAX_ANGLE)) return;
    // Brief visual feedback — slide in swipe direction, then dismiss.
    card.style.transition = "transform 160ms ease-out, opacity 160ms ease-out";
    card.style.transform = `translateX(${dx > 0 ? 180 : -180}px)`;
    card.style.opacity = "0";
    actions.dismiss();
  });
  card.addEventListener("pointercancel", () => {
    tracking = false;
  });
}

// ── Shell — the Hand organ, terminal scrolling on the slab ─────────────
//
// Doctrine (motebit-computer.md §Hand): "Shell / terminal output
// scrolls on the slab as commands run." The motebit doesn't narrate
// its shell command; the terminal *scrolls*. Rendered as a frosted-
// glass card with a dark terminal block inside — looking at a shell
// session through the slab's surface tension.
//
// While calling: the command line shows with a `$` prompt; the
// output block is honestly empty. No "running…" string.
// When done: stdout fills the output block. Non-zero exit → stderr
// shown in the same block with a muted warning tint.
//
// Gestures: tap expands the output area (removes the max-height
// cap so long logs can be read); swipe dismisses.

function renderShell(item: SlabItem, actions: SlabItemActions): HTMLElement {
  const card = baseCard();
  card.classList.add("slab-item-shell");
  card.style.cursor = "pointer";
  card.style.touchAction = "pan-y";

  // Terminal-style window chrome — $ glyph + command inline in the
  // chrome bar, exactly like a shell's prompt at the top of a terminal
  // window. No separate command line below; the chrome IS the prompt.
  const chrome = document.createElement("div");
  chrome.className = "slab-item-chrome";
  chrome.style.display = "flex";
  chrome.style.alignItems = "center";
  chrome.style.gap = "10px";
  chrome.style.padding = "8px 12px";
  chrome.style.borderBottom = "1px solid rgba(120, 140, 180, 0.18)";
  chrome.style.background = "linear-gradient(180deg, rgba(255,255,255,0.4) 0%, transparent 100%)";
  chrome.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";

  const prompt = document.createElement("span");
  prompt.textContent = "$";
  prompt.style.fontSize = "12px";
  prompt.style.color = "rgba(80, 110, 165, 0.92)";
  chrome.appendChild(prompt);

  const cmd = document.createElement("span");
  cmd.dataset.slot = "cmd";
  cmd.style.fontSize = "11.5px";
  cmd.style.color = "rgba(55, 72, 110, 0.92)";
  cmd.style.whiteSpace = "nowrap";
  cmd.style.overflow = "hidden";
  cmd.style.textOverflow = "ellipsis";
  cmd.style.flex = "1 1 auto";
  chrome.appendChild(cmd);

  card.appendChild(chrome);

  // Terminal output — dark panel filling the window body, scrollable.
  // Looking at a shell session through the slab's surface tension.
  const out = document.createElement("div");
  out.dataset.slot = "out";
  out.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
  out.style.fontSize = "11.5px";
  out.style.lineHeight = "1.55";
  out.style.color = "rgba(220, 232, 250, 0.96)";
  out.style.background = "rgba(18, 26, 46, 0.85)";
  out.style.padding = "12px 14px";
  out.style.whiteSpace = "pre-wrap";
  out.style.wordBreak = "break-word";
  out.style.maxHeight = "240px";
  out.style.minHeight = "80px";
  out.style.overflowY = "auto";
  out.style.overflowX = "hidden";
  card.appendChild(out);

  applyShellPayload(item.payload, cmd, out);
  attachShellGestures(card, actions);
  return card;
}

function updateShell(item: SlabItem, element: HTMLElement): void {
  const cmd = element.querySelector('[data-slot="cmd"]');
  const out = element.querySelector('[data-slot="out"]');
  if (cmd instanceof HTMLElement && out instanceof HTMLElement) {
    const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 8;
    applyShellPayload(item.payload, cmd, out);
    if (atBottom) out.scrollTop = out.scrollHeight;
  }
}

function applyShellPayload(payload: unknown, cmd: HTMLElement, out: HTMLElement): void {
  const p = payload as {
    context?: string;
    status?: string;
    result?: unknown;
  } | null;
  const command = p?.context ?? "";
  cmd.textContent = command ? `$ ${command}` : "$";

  // While calling: out is honestly empty — no "running…" string.
  if (p == null || p.status === "calling") {
    out.textContent = "";
    return;
  }

  const r = p.result;
  if (r == null) {
    out.textContent = "";
    return;
  }

  // Shell result shapes we handle:
  //   - { ok, data: { stdout, stderr, exitCode } } — tauriShellExec
  //   - string — generic shell tool
  //   - { error: "..." } — failure
  let text = "";
  let isError = false;
  if (typeof r === "string") {
    text = r;
  } else if (typeof r === "object") {
    const obj = r as {
      data?: { stdout?: string; stderr?: string; exitCode?: number };
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      error?: string;
    };
    const stdout = obj.data?.stdout ?? obj.stdout ?? "";
    const stderr = obj.data?.stderr ?? obj.stderr ?? "";
    const exitCode = obj.data?.exitCode ?? obj.exitCode;
    if (typeof obj.error === "string" && obj.error) {
      text = obj.error;
      isError = true;
    } else {
      text = stdout;
      if (stderr) {
        text = text ? `${text}\n${stderr}` : stderr;
      }
      if (typeof exitCode === "number" && exitCode !== 0) {
        isError = true;
      }
    }
  } else if (typeof r === "number" || typeof r === "boolean" || typeof r === "bigint") {
    text = String(r);
  } else {
    text = "";
  }

  out.textContent = text.trimEnd();
  // Tint for non-zero exit / error — stays legible, just warms the
  // block toward a terracotta so the reader's eye catches it.
  out.style.color = isError ? "rgba(255, 200, 180, 0.95)" : "rgba(220, 232, 250, 0.94)";
}

function attachShellGestures(card: HTMLDivElement, actions: SlabItemActions): void {
  // Output block scrolls natively now — no expand toggle needed.
  // Terminal fills the window; long output stays readable in place.

  // Swipe — dismiss via typed capability.
  let startX = 0;
  let startY = 0;
  let tracking = false;
  card.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    startX = ev.clientX;
    startY = ev.clientY;
    tracking = true;
  });
  card.addEventListener("pointerup", (ev) => {
    if (!tracking) return;
    tracking = false;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dx) < SWIPE_PX) return;
    if (Math.abs(dy) > Math.abs(dx) * Math.tan(SWIPE_MAX_ANGLE)) return;
    card.style.transition = "transform 160ms ease-out, opacity 160ms ease-out";
    card.style.transform = `translateX(${dx > 0 ? 180 : -180}px)`;
    card.style.opacity = "0";
    actions.dismiss();
  });
  card.addEventListener("pointercancel", () => {
    tracking = false;
  });
}

function renderPlanStep(item: SlabItem): HTMLElement {
  const card = baseCard();
  card.classList.add("slab-item-plan-step");
  const payload = item.payload as {
    ordinal?: number;
    description?: string;
    status?: "running" | "delegated";
    task_id?: string;
  } | null;
  const chrome = document.createElement("div");
  chrome.className = "slab-item-chrome";
  chrome.style.display = "flex";
  chrome.style.alignItems = "center";
  chrome.style.gap = "10px";
  chrome.style.padding = "8px 12px";
  chrome.style.borderBottom = "1px solid rgba(120, 140, 180, 0.18)";
  chrome.style.background = "linear-gradient(180deg, rgba(255,255,255,0.4) 0%, transparent 100%)";

  const badge = document.createElement("span");
  badge.textContent = String(payload?.ordinal ?? "?");
  badge.style.flex = "0 0 auto";
  badge.style.minWidth = "20px";
  badge.style.height = "20px";
  badge.style.display = "inline-flex";
  badge.style.alignItems = "center";
  badge.style.justifyContent = "center";
  badge.style.fontSize = "11px";
  badge.style.fontWeight = "600";
  badge.style.color = "rgba(45, 62, 100, 0.9)";
  badge.style.background = "rgba(255, 255, 255, 0.6)";
  badge.style.border = "1px solid rgba(120, 140, 180, 0.38)";
  badge.style.borderRadius = "999px";
  badge.style.lineHeight = "1";
  chrome.appendChild(badge);

  const label = document.createElement("span");
  label.textContent = "step";
  label.style.fontSize = "10px";
  label.style.fontWeight = "600";
  label.style.letterSpacing = "0.08em";
  label.style.textTransform = "uppercase";
  label.style.color = "rgba(55, 72, 110, 0.82)";
  label.style.flex = "0 0 auto";
  chrome.appendChild(label);

  const status = document.createElement("span");
  status.dataset.slot = "status";
  status.style.fontStyle = "italic";
  status.style.fontSize = "11px";
  status.style.color = "rgba(55, 72, 108, 0.78)";
  status.style.flex = "1 1 auto";
  status.style.textAlign = "right";
  status.textContent = formatStepStatus(payload);
  chrome.appendChild(status);

  card.appendChild(chrome);

  const body = cardBody();
  const desc = document.createElement("div");
  desc.textContent = payload?.description ?? "";
  desc.dataset.slot = "description";
  desc.style.fontSize = "12.5px";
  desc.style.lineHeight = "1.55";
  desc.style.color = "rgba(18, 28, 50, 0.94)";
  body.appendChild(desc);
  card.appendChild(body);
  return card;
}

function updatePlanStep(item: SlabItem, element: HTMLElement): void {
  const status = element.querySelector('[data-slot="status"]');
  if (status instanceof HTMLElement) {
    const payload = item.payload as { status?: "running" | "delegated"; task_id?: string } | null;
    status.textContent = formatStepStatus(payload);
  }
}

function formatStepStatus(
  payload: { status?: "running" | "delegated"; task_id?: string } | null,
): string {
  if (payload == null) return "running…";
  if (payload.status === "delegated") {
    return payload.task_id ? `delegated → ${payload.task_id.slice(0, 8)}…` : "delegated";
  }
  return "running…";
}

// ── Delegation — the Hand organ's most load-bearing entry ─────────────
//
// The motebit reaches across the network to a peer agent on the relay.
// Doctrine (motebit-computer.md §Hand): "a packet leaves the slab when
// the motebit delegates to a peer; returns as a bead with a signed
// receipt, the peer's identity visible on arrival."
//
// What the card shows:
//   - Outbound: peer's short motebit id (or "peer" if unknown) and
//     the tool being invoked. The body is honestly empty — the peer
//     hasn't replied yet. Nothing to perceive.
//   - Returned: a compact receipt summary — short task id, peer's
//     tool count, status. If the receipt is signed, the end-of-life
//     policy will pinch this card to a `receipt` artifact in the
//     scene (detachAs: "receipt" is set upstream in motebit-runtime).
//
// Gestures: tap to expand and see the full receipt chain; swipe to
// dismiss (the network request still completes; the UI just stops
// showing it — the returned artifact, if any, still graduates).

function renderDelegation(item: SlabItem, actions: SlabItemActions): HTMLElement {
  const card = baseCard();
  card.classList.add("slab-item-delegation");
  card.style.cursor = "pointer";
  card.style.touchAction = "pan-y";

  // Delegation chrome — ⇝ glyph, peer identity, tool name. One-line
  // window header that reads as "packet outbound to peer X, tool Y."
  const chrome = document.createElement("div");
  chrome.className = "slab-item-chrome";
  chrome.style.display = "flex";
  chrome.style.alignItems = "center";
  chrome.style.gap = "10px";
  chrome.style.padding = "8px 12px";
  chrome.style.borderBottom = "1px solid rgba(120, 140, 180, 0.18)";
  chrome.style.background = "linear-gradient(180deg, rgba(255,255,255,0.4) 0%, transparent 100%)";

  const glyph = document.createElement("span");
  glyph.textContent = "⇝";
  glyph.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
  glyph.style.fontSize = "12px";
  glyph.style.color = "rgba(90, 120, 175, 0.92)";
  chrome.appendChild(glyph);

  const peer = document.createElement("span");
  peer.dataset.slot = "peer";
  peer.style.fontSize = "10px";
  peer.style.fontWeight = "600";
  peer.style.letterSpacing = "0.08em";
  peer.style.textTransform = "uppercase";
  peer.style.color = "rgba(55, 72, 110, 0.82)";
  peer.style.flex = "0 0 auto";
  chrome.appendChild(peer);

  const toolEl = document.createElement("span");
  toolEl.dataset.slot = "tool";
  toolEl.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
  toolEl.style.fontSize = "11px";
  toolEl.style.color = "rgba(80, 110, 165, 0.78)";
  toolEl.style.whiteSpace = "nowrap";
  toolEl.style.overflow = "hidden";
  toolEl.style.textOverflow = "ellipsis";
  toolEl.style.flex = "1 1 auto";
  chrome.appendChild(toolEl);

  card.appendChild(chrome);

  // Body: receipt summary when returned. Empty while outbound —
  // nothing to perceive yet.
  const body = cardBody();
  const bodyText = document.createElement("div");
  bodyText.className = "slab-item-text";
  bodyText.dataset.slot = "body";
  bodyText.style.fontSize = "12.5px";
  bodyText.style.lineHeight = "1.55";
  bodyText.style.color = "rgba(18, 28, 50, 0.94)";
  bodyText.style.whiteSpace = "pre-wrap";
  bodyText.style.wordBreak = "break-word";
  body.appendChild(bodyText);

  // Expanded detail (receipt chain). Hidden until tap.
  const detail = document.createElement("div");
  detail.dataset.slot = "detail";
  detail.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
  detail.style.fontSize = "10.5px";
  detail.style.lineHeight = "1.6";
  detail.style.color = "rgba(45, 60, 95, 0.85)";
  detail.style.whiteSpace = "pre-wrap";
  detail.style.wordBreak = "break-all";
  detail.style.marginTop = "10px";
  detail.style.paddingTop = "10px";
  detail.style.borderTop = "1px solid rgba(120, 140, 180, 0.22)";
  detail.style.display = "none";
  body.appendChild(detail);

  card.appendChild(body);

  applyDelegationPayload(item.payload, peer, toolEl, bodyText, detail);
  attachDelegationGestures(card, actions);
  return card;
}

function updateDelegation(item: SlabItem, element: HTMLElement): void {
  const peer = element.querySelector('[data-slot="peer"]');
  const toolEl = element.querySelector('[data-slot="tool"]');
  const body = element.querySelector('[data-slot="body"]');
  const detail = element.querySelector('[data-slot="detail"]');
  if (
    peer instanceof HTMLElement &&
    toolEl instanceof HTMLElement &&
    body instanceof HTMLElement &&
    detail instanceof HTMLElement
  ) {
    applyDelegationPayload(item.payload, peer, toolEl, body, detail);
  }
}

function applyDelegationPayload(
  payload: unknown,
  peerEl: HTMLElement,
  toolEl: HTMLElement,
  body: HTMLElement,
  detail: HTMLElement,
): void {
  const p = payload as {
    server?: string;
    tool?: string;
    motebit_id?: string;
    status?: string;
    receipt?: { task_id?: string; status?: string; tools_used?: string[] };
    full_receipt?: {
      task_id?: string;
      status?: string;
      motebit_id?: string;
      signature?: string;
      tools_used?: string[];
      duration_ms?: number;
    };
  } | null;
  const peerId = p?.motebit_id ?? p?.full_receipt?.motebit_id ?? "";
  peerEl.textContent = peerId ? `→ ${peerId.slice(0, 10)}…` : `→ ${p?.server ?? "peer"}`;
  toolEl.textContent = p?.tool ?? "";

  const r = p?.full_receipt ?? p?.receipt;
  if (!r) {
    body.textContent = ""; // Outbound — nothing perceived yet.
    detail.textContent = "";
    return;
  }
  const toolsCount = Array.isArray(r.tools_used) ? r.tools_used.length : 0;
  const durationMs = p?.full_receipt?.duration_ms;
  const parts = [
    r.status ?? "returned",
    toolsCount > 0 ? `${toolsCount} tool${toolsCount === 1 ? "" : "s"}` : "",
    typeof durationMs === "number" ? formatDuration(durationMs) : "",
  ].filter(Boolean);
  body.textContent = parts.join(" · ");

  // Detail: signed receipt fields (task id, signature prefix, tools list).
  const detailLines: string[] = [];
  if (r.task_id) detailLines.push(`task  ${r.task_id}`);
  if (p?.full_receipt?.signature) {
    detailLines.push(`sig   ${p.full_receipt.signature.slice(0, 18)}…`);
  }
  if (Array.isArray(r.tools_used) && r.tools_used.length > 0) {
    detailLines.push(`tools ${r.tools_used.join(", ")}`);
  }
  detail.textContent = detailLines.join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

function attachDelegationGestures(card: HTMLDivElement, actions: SlabItemActions): void {
  // Tap — toggle the expanded detail block. Pure client-side.
  card.addEventListener("click", () => {
    const detail = card.querySelector('[data-slot="detail"]');
    if (!(detail instanceof HTMLElement)) return;
    const expanded = card.dataset.expanded === "true";
    if (expanded) {
      card.dataset.expanded = "false";
      detail.style.display = "none";
    } else {
      card.dataset.expanded = "true";
      detail.style.display = "block";
    }
  });

  // Swipe — dismiss via typed capability. Network request still
  // completes; UI stops rendering it.
  let startX = 0;
  let startY = 0;
  let tracking = false;
  card.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    startX = ev.clientX;
    startY = ev.clientY;
    tracking = true;
  });
  card.addEventListener("pointerup", (ev) => {
    if (!tracking) return;
    tracking = false;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dx) < SWIPE_PX) return;
    if (Math.abs(dy) > Math.abs(dx) * Math.tan(SWIPE_MAX_ANGLE)) return;
    card.style.transition = "transform 160ms ease-out, opacity 160ms ease-out";
    card.style.transform = `translateX(${dx > 0 ? 180 : -180}px)`;
    card.style.opacity = "0";
    actions.dismiss();
  });
  card.addEventListener("pointercancel", () => {
    tracking = false;
  });
}

// ── Memory — the Mind organ's visible breath ──────────────────────────
//
// Doctrine (motebit-computer.md §Mind): "memory surfaces on the slab
// as it becomes relevant; drifts back down as it falls away." A
// node rising into attention is not a tool-call result — it is the
// motebit remembering, and the slab shows the remembering as it
// happens. Ephemeral by default; dissolves when attention moves on.
//
// Visual: a softer card than the action kinds — no hard borders on
// the content, a short-id pill showing the node's short identity,
// and the content in readable prose. The glyph is a small filled
// circle ("◉"), matching the "mote" vocabulary ("memory_mote") that
// already lives in the scene-primitive catalog.

function renderMemory(item: SlabItem, actions: SlabItemActions): HTMLElement {
  const card = baseCard();
  card.classList.add("slab-item-memory");
  card.style.cursor = "pointer";
  card.style.touchAction = "pan-y";

  // Memory chrome: ◉ glyph + "memory" label + short-id pill all in
  // the window header. Memory surfacings are ephemeral (short dwell,
  // dissolve) so the body stays compact — one or two lines of the
  // node's content is enough to read before it fades.
  const chrome = document.createElement("div");
  chrome.className = "slab-item-chrome";
  chrome.style.display = "flex";
  chrome.style.alignItems = "center";
  chrome.style.gap = "8px";
  chrome.style.padding = "8px 12px";
  chrome.style.borderBottom = "1px solid rgba(120, 140, 180, 0.18)";
  chrome.style.background = "linear-gradient(180deg, rgba(255,255,255,0.4) 0%, transparent 100%)";

  const glyph = document.createElement("span");
  glyph.textContent = "◉";
  glyph.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
  glyph.style.fontSize = "11px";
  glyph.style.color = "rgba(95, 125, 180, 0.92)";
  chrome.appendChild(glyph);

  const label = document.createElement("span");
  label.textContent = "memory";
  label.style.fontSize = "10px";
  label.style.fontWeight = "600";
  label.style.letterSpacing = "0.08em";
  label.style.textTransform = "uppercase";
  label.style.color = "rgba(55, 72, 110, 0.82)";
  label.style.flex = "1 1 auto";
  chrome.appendChild(label);

  const shortId = document.createElement("span");
  shortId.dataset.slot = "short_id";
  shortId.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
  shortId.style.fontSize = "9.5px";
  shortId.style.color = "rgba(95, 115, 155, 0.85)";
  shortId.style.padding = "2px 8px";
  shortId.style.borderRadius = "999px";
  shortId.style.background = "rgba(255, 255, 255, 0.55)";
  shortId.style.border = "1px solid rgba(120, 140, 180, 0.3)";
  shortId.style.letterSpacing = "0.04em";
  chrome.appendChild(shortId);

  card.appendChild(chrome);

  // Body — the memory's content, readable prose.
  const body = cardBody();
  const text = document.createElement("div");
  text.className = "slab-item-text";
  text.dataset.slot = "body";
  text.style.fontSize = "12.5px";
  text.style.lineHeight = "1.55";
  text.style.color = "rgba(18, 28, 50, 0.94)";
  text.style.whiteSpace = "pre-wrap";
  text.style.wordBreak = "break-word";
  text.style.maxHeight = "140px";
  text.style.overflowY = "auto";
  body.appendChild(text);
  card.appendChild(body);

  applyMemoryPayload(item.payload, shortId, text);
  attachMemoryGestures(card, actions);
  return card;
}

function updateMemory(item: SlabItem, element: HTMLElement): void {
  const shortId = element.querySelector('[data-slot="short_id"]');
  const body = element.querySelector('[data-slot="body"]');
  if (shortId instanceof HTMLElement && body instanceof HTMLElement) {
    applyMemoryPayload(item.payload, shortId, body);
  }
}

function applyMemoryPayload(payload: unknown, shortId: HTMLElement, body: HTMLElement): void {
  const p = payload as {
    node_id?: string;
    content?: string;
    short_id?: string;
  } | null;
  shortId.textContent = p?.short_id ?? (p?.node_id ? p.node_id.slice(0, 8) : "");
  const content = (p?.content ?? "").trim();
  body.textContent = content;
}

function attachMemoryGestures(card: HTMLDivElement, actions: SlabItemActions): void {
  // Body scrolls natively; no expand toggle needed.

  let startX = 0;
  let startY = 0;
  let tracking = false;
  card.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    startX = ev.clientX;
    startY = ev.clientY;
    tracking = true;
  });
  card.addEventListener("pointerup", (ev) => {
    if (!tracking) return;
    tracking = false;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dx) < SWIPE_PX) return;
    if (Math.abs(dy) > Math.abs(dx) * Math.tan(SWIPE_MAX_ANGLE)) return;
    card.style.transition = "transform 160ms ease-out, opacity 160ms ease-out";
    card.style.transform = `translateX(${dx > 0 ? 180 : -180}px)`;
    card.style.opacity = "0";
    actions.dismiss();
  });
  card.addEventListener("pointercancel", () => {
    tracking = false;
  });
}

function renderGeneric(item: SlabItem): HTMLElement {
  const card = baseCard();
  card.classList.add(`slab-item-${item.kind}`);
  card.appendChild(windowChrome(kindGlyph(item.kind), item.kind));
  const body = cardBody();
  body.style.color = "rgba(55, 72, 108, 0.72)";
  body.style.fontStyle = "italic";
  body.style.fontSize = "12px";
  body.textContent = "…";
  card.appendChild(body);
  return card;
}

// ── Public factory + updater ────────────────────────────────────────

/**
 * Element factory — routed by `SlabItem.kind`. The second argument
 * is the bridge-supplied action set (see `SlabItemActions`) carrying
 * typed per-item capabilities: `dismiss`, future `pin` / `feed`.
 * Kind-specific renderers wire pointer/touch handlers to these
 * closures per the surface-determinism doctrine.
 *
 * Caller (slab-bridge) mounts the returned element on the slab.
 */
export function renderSlabItem(item: SlabItem, actions: SlabItemActions): HTMLElement {
  // Mind-mode items (stream tokens, memory surfacing, plan steps,
  // embeddings) don't render on the plane — they live in chat and
  // in the creature's own animations. The plane is for external
  // embodiments (virtual_browser, desktop_drive, shared_gaze,
  // peer_viewport) and their returned tool_results. Doctrine:
  // motebit-computer.md §"Embodiment modes."
  if (item.mode === "mind") {
    const hidden = document.createElement("div");
    hidden.className = "slab-item-mind-hidden";
    hidden.dataset.slabHidden = "true";
    hidden.style.display = "none";
    return hidden;
  }
  const card = buildCardForKind(item, actions);
  if (card instanceof HTMLDivElement) {
    attachHoverClose(card, actions);
  }
  return card;
}

function buildCardForKind(item: SlabItem, actions: SlabItemActions): HTMLElement {
  switch (item.kind) {
    case "stream":
      return renderStream(item);
    case "tool_call":
      return renderToolCall(item, actions);
    case "fetch":
      return renderFetch(item, actions);
    case "plan_step":
      return renderPlanStep(item);
    case "delegation":
      return renderDelegation(item, actions);
    case "memory":
      return renderMemory(item, actions);
    case "shell":
    case "embedding":
    default:
      return renderGeneric(item);
  }
}

/** In-place updater for payload-only changes. */
export function updateSlabItem(item: SlabItem, element: HTMLElement): void {
  switch (item.kind) {
    case "stream":
      updateStream(item, element);
      break;
    case "tool_call":
      updateToolCall(item, element);
      break;
    case "fetch":
      updateFetch(item, element);
      break;
    case "plan_step":
      updatePlanStep(item, element);
      break;
    case "delegation":
      updateDelegation(item, element);
      break;
    case "memory":
      updateMemory(item, element);
      break;
    case "shell":
    case "embedding":
    default:
      // No-op for generic kinds — their initial render is sufficient
      // for Pass 2.5; iteration can add per-kind update logic later
      // without touching the bridge wiring.
      break;
  }
}

/**
 * Factory for a detached-artifact's element. The slab item's bead
 * separates via the pinch animation; this element settles into the
 * wider scene as a normal artifact (see `@motebit/render-engine`'s
 * `ArtifactSpec`).
 *
 * Pass 2.5 renders the artifact as a larger copy of the slab card —
 * the detached state carries the full result (tool output, completed
 * text, final plan summary). Richer artifact shapes (code panes,
 * plan scrolls) land as each item kind's detach path sees real usage.
 */
export function renderDetachArtifact(
  item: SlabItem,
  artifactKind: ArtifactKindForDetach,
): { id: string; kind: ArtifactKindForDetach; element: HTMLElement } {
  const card = baseCard();
  card.classList.add("slab-detach-artifact", `slab-detach-${artifactKind}`);
  card.style.maxWidth = "320px";
  card.style.padding = "10px 12px";
  card.appendChild(headRow("◆", `${artifactKind} · from ${item.kind}`));
  const body = textRow();
  body.style.fontSize = "12px";
  body.style.color = "rgba(14, 22, 40, 0.95)";
  const payload = item.payload as Record<string, unknown> | null;
  if (payload) {
    const detach = payload.__slabDetach as { outcome?: { result?: unknown } } | undefined;
    const result = detach?.outcome?.result;
    if (result != null) {
      body.textContent = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    } else if (typeof payload.text === "string") {
      body.textContent = payload.text;
    }
  }
  card.appendChild(body);
  return {
    id: `slab-artifact-${item.id}`,
    kind: artifactKind,
    element: card,
  };
}
