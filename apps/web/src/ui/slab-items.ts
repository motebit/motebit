/**
 * Per-kind slab-item renderers for the web surface.
 *
 * The runtime's `SlabController` emits typed `SlabItem` events, the
 * runtime's bridge diffs them, and here — the web-specific rendering
 * layer — is where each kind becomes a real HTMLElement mounted on
 * the slab's liquid-glass plane.
 *
 * See docs/doctrine/motebit-computer.md for what each kind means in
 * the slab's lifecycle. Styling conventions:
 *
 *   - One card per slab item; the slab's plane IS the substrate, so
 *     items stay low-chrome and let the material speak (no heavy
 *     backgrounds, no borders louder than a hairline).
 *   - Inline styles keep the items self-contained — no new CSS class
 *     lookups that could drift out of sync with the rest of the
 *     stylesheet. Future work may migrate to class-based styling
 *     once the slab's visual language is settled.
 *   - Typography matches the chat surface (system-ui, ~12-13px) so
 *     items on the slab read as part of the same conversation, not
 *     as a different product.
 */

import type { SlabItem, ArtifactKindForDetach } from "@motebit/runtime";

// ── Common card chrome ────────────────────────────────────────────────

function baseCard(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "slab-item";
  // Inline fallbacks so items remain legible even if the slab CSS
  // block hasn't loaded (fresh install, cache miss). Values mirror
  // index.html's `.slab-item` rule so there's no style flash.
  el.style.fontFamily = "-apple-system, BlinkMacSystemFont, system-ui, sans-serif";
  el.style.fontSize = "12px";
  el.style.lineHeight = "1.45";
  el.style.color = "rgba(20, 30, 50, 0.82)";
  el.style.padding = "8px 10px";
  el.style.background = "rgba(255, 255, 255, 0.22)";
  el.style.border = "1px solid rgba(255, 255, 255, 0.35)";
  el.style.borderRadius = "6px";
  el.style.backdropFilter = "blur(4px)";
  // @ts-expect-error — vendor-prefixed compatibility
  el.style.webkitBackdropFilter = "blur(4px)";
  el.style.boxShadow = "0 1px 3px rgba(0, 0, 0, 0.06)";
  el.style.minWidth = "140px";
  el.style.maxWidth = "240px";
  el.style.overflow = "hidden";
  el.style.wordBreak = "break-word";
  return el;
}

function labelRow(text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "slab-item-label";
  el.style.display = "block";
  el.style.fontSize = "10px";
  el.style.fontWeight = "600";
  el.style.letterSpacing = "0.04em";
  el.style.textTransform = "uppercase";
  el.style.color = "rgba(60, 70, 100, 0.55)";
  el.style.marginBottom = "4px";
  el.textContent = text;
  return el;
}

function textRow(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "slab-item-text";
  el.style.whiteSpace = "pre-wrap";
  return el;
}

// ── Per-kind renderers ───────────────────────────────────────────────

function renderStream(item: SlabItem): HTMLElement {
  const card = baseCard();
  card.classList.add("slab-item-stream");
  const text = textRow();
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

function renderToolCall(item: SlabItem): HTMLElement {
  const card = baseCard();
  card.classList.add("slab-item-tool-call");
  const payload = item.payload as {
    name?: string;
    status?: string;
    context?: string;
    result?: unknown;
  } | null;
  card.appendChild(labelRow(payload?.name ?? "tool"));
  const status = textRow();
  status.style.fontStyle = "italic";
  status.style.color = "rgba(60, 70, 100, 0.6)";
  status.textContent = formatToolStatus(payload);
  status.dataset.slot = "status";
  card.appendChild(status);
  return card;
}

function updateToolCall(item: SlabItem, element: HTMLElement): void {
  const status = element.querySelector('[data-slot="status"]');
  if (status instanceof HTMLElement) {
    const payload = item.payload as {
      name?: string;
      status?: string;
      context?: string;
      result?: unknown;
    } | null;
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

function renderPlanStep(item: SlabItem): HTMLElement {
  const card = baseCard();
  card.classList.add("slab-item-plan-step");
  const payload = item.payload as {
    ordinal?: number;
    description?: string;
    status?: "running" | "delegated";
    task_id?: string;
  } | null;
  card.appendChild(labelRow(`step ${payload?.ordinal ?? "?"}`));
  const desc = textRow();
  desc.textContent = payload?.description ?? "";
  desc.dataset.slot = "description";
  card.appendChild(desc);
  const status = textRow();
  status.style.fontStyle = "italic";
  status.style.color = "rgba(60, 70, 100, 0.6)";
  status.style.fontSize = "11px";
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
  card.appendChild(labelRow(item.kind));
  return card;
}

// ── Public factory + updater ────────────────────────────────────────

/** Element factory — routed by `SlabItem.kind`. Caller mounts result on the slab. */
export function renderSlabItem(item: SlabItem): HTMLElement {
  switch (item.kind) {
    case "stream":
      return renderStream(item);
    case "tool_call":
      return renderToolCall(item);
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
  card.appendChild(labelRow(`${artifactKind} · from ${item.kind}`));
  const body = textRow();
  body.style.fontSize = "12px";
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
