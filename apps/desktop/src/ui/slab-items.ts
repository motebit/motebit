/**
 * Per-kind slab-item renderers for the desktop surface.
 *
 * Sibling-boundary note: this file mirrors `apps/web/src/ui/slab-items.ts`.
 * Both surfaces render HTML cards onto the Three.js slab plane via
 * CSS2DObject and produce identical output. Changes here MUST be
 * mirrored to the web sibling (and any future HTML-surface
 * sibling) until three consumers exist — at that point, extract to
 * a shared `@motebit/panels`-style render package per the panels-
 * pattern doctrine. Two copies is the pre-extraction threshold.
 *
 * The runtime's `SlabController` emits typed `SlabItem` events, the
 * runtime's bridge diffs them, and here — the desktop-specific rendering
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

import type { SlabItem, SlabItemActions, ArtifactKindForDetach } from "@motebit/runtime";

// ── Common card chrome ────────────────────────────────────────────────

function baseCard(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "slab-item";
  el.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif";
  el.style.fontSize = "12px";
  el.style.lineHeight = "1.45";
  el.style.letterSpacing = "-0.005em";
  // Near-black ink. The slab below is glass, so the text has to be
  // dark enough to read against any environment behind the plane.
  el.style.color = "rgba(14, 22, 40, 0.96)";
  el.style.padding = "9px 11px";
  // Frosted-glass body with a gradient top→bottom so the card
  // appears to catch light from above, like a droplet frozen on a
  // sheet. Values are tuned for the light environment; the backdrop
  // blur carries refraction from whatever's behind the plane.
  el.style.background =
    "linear-gradient(180deg, rgba(255,255,255,0.74) 0%, rgba(246,250,255,0.58) 100%)";
  el.style.border = "1px solid rgba(255, 255, 255, 0.55)";
  el.style.borderRadius = "10px";
  el.style.backdropFilter = "blur(14px) saturate(1.25)";
  el.style.setProperty("-webkit-backdrop-filter", "blur(14px) saturate(1.25)");
  el.style.boxShadow = [
    // Top rim — the surface-tension highlight where the card meets light.
    "0 1px 0 rgba(255,255,255,0.72) inset",
    // Bottom inset — a thin darker line reading as the droplet's base.
    "0 -1px 0 rgba(25,35,60,0.06) inset",
    // External cast — lifts the card off the slab's glass surface
    // (doctrine: "cards feel lifted, not painted").
    "0 2px 10px rgba(20,30,60,0.14)",
  ].join(", ");
  el.style.minWidth = "148px";
  el.style.maxWidth = "228px";
  el.style.overflow = "hidden";
  el.style.wordBreak = "break-word";
  return el;
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
  const text = textRow();
  // Stream is live LLM tokens arriving character-by-character — the
  // monospace typeface reads as "something is being typed right now."
  // No label row; let the text fill the card.
  text.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
  text.style.fontSize = "11.5px";
  text.style.lineHeight = "1.55";
  text.style.color = "rgba(18, 28, 50, 0.94)";
  const payload = item.payload as { text?: string } | null;
  text.textContent = payload?.text ?? "";
  card.appendChild(text);
  return card;
}

function updateStream(item: SlabItem, element: HTMLElement): void {
  const text = element.querySelector(".slab-item-text");
  const payload = item.payload as { text?: string } | null;
  if (text instanceof HTMLElement) {
    text.textContent = payload?.text ?? "";
  }
}

// Tool names whose cards render as a `fetch` — the motebit is reading
// a page, and the slab shows the page being read. Doctrine: the slab
// renders perception, not a label describing the act.
const FETCH_TOOLS: ReadonlySet<string> = new Set(["read_url", "fetch_url"]);

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
  const card = baseCard();
  card.classList.add("slab-item-tool-call");
  card.appendChild(headRow("◇", payload?.name ?? "tool"));
  const status = textRow();
  status.style.fontSize = "11.5px";
  status.style.color = "rgba(50, 66, 98, 0.82)";
  status.textContent = formatToolStatus(payload);
  status.dataset.slot = "status";
  card.appendChild(status);
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
  card.style.maxWidth = "240px";
  card.style.cursor = "pointer";
  card.style.touchAction = "pan-y"; // keep vertical page scroll; horizontal becomes swipe
  attachFetchGestures(card, actions);

  const head = document.createElement("div");
  head.style.marginBottom = "6px";
  head.style.minWidth = "0";

  const hostEl = document.createElement("div");
  hostEl.dataset.slot = "host";
  hostEl.style.fontSize = "9.5px";
  hostEl.style.fontWeight = "600";
  hostEl.style.letterSpacing = "0.08em";
  hostEl.style.textTransform = "uppercase";
  hostEl.style.color = "rgba(55, 72, 110, 0.82)";
  head.appendChild(hostEl);

  const pathEl = document.createElement("div");
  pathEl.dataset.slot = "path";
  pathEl.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
  pathEl.style.fontSize = "10.5px";
  pathEl.style.color = "rgba(80, 110, 165, 0.92)";
  pathEl.style.whiteSpace = "nowrap";
  pathEl.style.overflow = "hidden";
  pathEl.style.textOverflow = "ellipsis";
  head.appendChild(pathEl);

  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "slab-item-text";
  body.dataset.slot = "body";
  body.style.fontSize = "11.5px";
  body.style.lineHeight = "1.5";
  body.style.color = "rgba(18, 28, 50, 0.9)";
  body.style.whiteSpace = "pre-wrap";
  body.style.wordBreak = "break-word";
  body.style.maxHeight = "84px";
  body.style.overflow = "hidden";
  // Soft fade at bottom so truncation reads as a vignette, not a cut.
  body.style.maskImage = "linear-gradient(180deg, black 72%, transparent 100%)";
  body.style.setProperty(
    "-webkit-mask-image",
    "linear-gradient(180deg, black 72%, transparent 100%)",
  );
  card.appendChild(body);

  applyFetchPayload(item.payload, hostEl, pathEl, body);
  return card;
}

function updateFetch(item: SlabItem, element: HTMLElement): void {
  const hostEl = element.querySelector('[data-slot="host"]');
  const pathEl = element.querySelector('[data-slot="path"]');
  const body = element.querySelector('[data-slot="body"]');
  if (
    hostEl instanceof HTMLElement &&
    pathEl instanceof HTMLElement &&
    body instanceof HTMLElement
  ) {
    applyFetchPayload(item.payload, hostEl, pathEl, body);
  }
}

function applyFetchPayload(
  payload: unknown,
  hostEl: HTMLElement,
  pathEl: HTMLElement,
  body: HTMLElement,
): void {
  const p = payload as { context?: string; status?: string; result?: unknown } | null;
  const raw = p?.context ?? "";
  const parsed = parseUrl(raw);
  hostEl.textContent = parsed.host || (p?.status === "calling" ? "reading" : "");
  pathEl.textContent = parsed.path || (parsed.host ? "/" : raw);
  body.textContent = extractFetchPreview(p);
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
  } else {
    text = String(r);
  }
  // Collapse runs of whitespace so the preview reads as flowing prose
  // rather than reflowed HTML whitespace.
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > 240 ? cleaned.slice(0, 237) + "…" : cleaned;
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
  // Tap — toggle expanded state. Clears the max-height + bottom
  // vignette so the full preview shows. Pure client-side; no
  // controller call. Re-tap collapses.
  card.addEventListener("click", () => {
    const body = card.querySelector('[data-slot="body"]');
    if (!(body instanceof HTMLElement)) return;
    const expanded = card.dataset.expanded === "true";
    if (expanded) {
      card.dataset.expanded = "false";
      body.style.maxHeight = "84px";
      body.style.maskImage = "linear-gradient(180deg, black 72%, transparent 100%)";
      body.style.setProperty(
        "-webkit-mask-image",
        "linear-gradient(180deg, black 72%, transparent 100%)",
      );
    } else {
      card.dataset.expanded = "true";
      body.style.maxHeight = "none";
      body.style.maskImage = "none";
      body.style.setProperty("-webkit-mask-image", "none");
    }
  });

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

function renderPlanStep(item: SlabItem): HTMLElement {
  const card = baseCard();
  card.classList.add("slab-item-plan-step");
  const payload = item.payload as {
    ordinal?: number;
    description?: string;
    status?: "running" | "delegated";
    task_id?: string;
  } | null;
  const head = document.createElement("div");
  head.style.display = "flex";
  head.style.alignItems = "flex-start";
  head.style.gap = "8px";
  const badge = document.createElement("span");
  badge.textContent = String(payload?.ordinal ?? "?");
  badge.style.flex = "0 0 auto";
  badge.style.minWidth = "18px";
  badge.style.height = "18px";
  badge.style.display = "inline-flex";
  badge.style.alignItems = "center";
  badge.style.justifyContent = "center";
  badge.style.fontSize = "10.5px";
  badge.style.fontWeight = "600";
  badge.style.color = "rgba(45, 62, 100, 0.9)";
  badge.style.background = "rgba(255, 255, 255, 0.55)";
  badge.style.border = "1px solid rgba(120, 140, 180, 0.38)";
  badge.style.borderRadius = "999px";
  badge.style.lineHeight = "1";
  head.appendChild(badge);
  const desc = document.createElement("span");
  desc.textContent = payload?.description ?? "";
  desc.dataset.slot = "description";
  desc.style.fontSize = "12px";
  desc.style.color = "rgba(18, 28, 50, 0.94)";
  desc.style.flex = "1 1 auto";
  desc.style.paddingTop = "1px";
  head.appendChild(desc);
  card.appendChild(head);
  const status = textRow();
  status.style.fontStyle = "italic";
  status.style.fontSize = "10.5px";
  status.style.color = "rgba(55, 72, 108, 0.72)";
  status.style.marginLeft = "26px";
  status.style.marginTop = "3px";
  status.textContent = formatStepStatus(payload);
  status.dataset.slot = "status";
  card.appendChild(status);
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

function renderGeneric(item: SlabItem): HTMLElement {
  const card = baseCard();
  card.classList.add(`slab-item-${item.kind}`);
  card.appendChild(headRow(kindGlyph(item.kind), item.kind));
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
  switch (item.kind) {
    case "stream":
      return renderStream(item);
    case "tool_call":
      return renderToolCall(item, actions);
    case "plan_step":
      return renderPlanStep(item);
    case "shell":
    case "fetch":
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
    case "plan_step":
      updatePlanStep(item, element);
      break;
    case "shell":
    case "fetch":
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
