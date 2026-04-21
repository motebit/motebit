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
  } else if (typeof r === "number" || typeof r === "boolean" || typeof r === "bigint") {
    text = String(r);
  } else {
    // symbol / function — not reachable from tool results in practice.
    text = "";
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
  card.style.maxWidth = "260px";
  card.style.cursor = "pointer";
  card.style.touchAction = "pan-y";

  // Head: `$` glyph + "shell" label.
  card.appendChild(headRow("$", "shell"));

  // Command line — the prompt the motebit typed.
  const cmd = document.createElement("div");
  cmd.dataset.slot = "cmd";
  cmd.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
  cmd.style.fontSize = "11px";
  cmd.style.color = "rgba(70, 95, 150, 0.96)";
  cmd.style.marginBottom = "6px";
  cmd.style.whiteSpace = "nowrap";
  cmd.style.overflow = "hidden";
  cmd.style.textOverflow = "ellipsis";
  card.appendChild(cmd);

  // Output block — terminal-style dark panel inside the frosted card.
  // Not a pure black box; a softened "terminal through glass" tone
  // that still reads as a console but doesn't break the slab's calm.
  const out = document.createElement("div");
  out.dataset.slot = "out";
  out.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
  out.style.fontSize = "10.5px";
  out.style.lineHeight = "1.5";
  out.style.color = "rgba(220, 232, 250, 0.94)";
  out.style.background = "rgba(18, 26, 46, 0.82)";
  out.style.padding = "7px 9px";
  out.style.borderRadius = "6px";
  out.style.whiteSpace = "pre-wrap";
  out.style.wordBreak = "break-word";
  out.style.maxHeight = "96px";
  out.style.overflow = "hidden";
  out.style.minHeight = "18px";
  // Soft fade at bottom for truncation — vignette, not cut.
  out.style.maskImage = "linear-gradient(180deg, black 78%, transparent 100%)";
  out.style.setProperty(
    "-webkit-mask-image",
    "linear-gradient(180deg, black 78%, transparent 100%)",
  );
  card.appendChild(out);

  applyShellPayload(item.payload, cmd, out);
  attachShellGestures(card, actions);
  return card;
}

function updateShell(item: SlabItem, element: HTMLElement): void {
  const cmd = element.querySelector('[data-slot="cmd"]');
  const out = element.querySelector('[data-slot="out"]');
  if (cmd instanceof HTMLElement && out instanceof HTMLElement) {
    applyShellPayload(item.payload, cmd, out);
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
  // Tap — toggle expanded state on the output block. Lets the user
  // read the whole log without a modal. Pure client-side.
  card.addEventListener("click", () => {
    const out = card.querySelector('[data-slot="out"]');
    if (!(out instanceof HTMLElement)) return;
    const expanded = card.dataset.expanded === "true";
    if (expanded) {
      card.dataset.expanded = "false";
      out.style.maxHeight = "96px";
      out.style.maskImage = "linear-gradient(180deg, black 78%, transparent 100%)";
      out.style.setProperty(
        "-webkit-mask-image",
        "linear-gradient(180deg, black 78%, transparent 100%)",
      );
    } else {
      card.dataset.expanded = "true";
      out.style.maxHeight = "none";
      out.style.maskImage = "none";
      out.style.setProperty("-webkit-mask-image", "none");
    }
  });

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
  card.style.maxWidth = "240px";
  card.style.cursor = "pointer";
  card.style.touchAction = "pan-y";

  // Head: ⇝ glyph + peer identity.
  const head = document.createElement("div");
  head.style.display = "flex";
  head.style.alignItems = "center";
  head.style.gap = "6px";
  head.style.marginBottom = "4px";
  head.style.minWidth = "0";

  const glyph = document.createElement("span");
  glyph.textContent = "⇝";
  glyph.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
  glyph.style.fontSize = "12px";
  glyph.style.color = "rgba(90, 120, 175, 0.92)";
  head.appendChild(glyph);

  const peer = document.createElement("span");
  peer.dataset.slot = "peer";
  peer.style.fontSize = "9.5px";
  peer.style.fontWeight = "600";
  peer.style.letterSpacing = "0.08em";
  peer.style.textTransform = "uppercase";
  peer.style.color = "rgba(55, 72, 110, 0.82)";
  peer.style.whiteSpace = "nowrap";
  peer.style.overflow = "hidden";
  peer.style.textOverflow = "ellipsis";
  head.appendChild(peer);

  card.appendChild(head);

  // Secondary: the tool being invoked, monospace and subtle.
  const toolEl = document.createElement("div");
  toolEl.dataset.slot = "tool";
  toolEl.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
  toolEl.style.fontSize = "10.5px";
  toolEl.style.color = "rgba(80, 110, 165, 0.88)";
  toolEl.style.whiteSpace = "nowrap";
  toolEl.style.overflow = "hidden";
  toolEl.style.textOverflow = "ellipsis";
  toolEl.style.marginBottom = "6px";
  card.appendChild(toolEl);

  // Body: receipt summary when returned. Empty while outbound —
  // nothing to perceive yet.
  const body = document.createElement("div");
  body.className = "slab-item-text";
  body.dataset.slot = "body";
  body.style.fontSize = "11.5px";
  body.style.lineHeight = "1.5";
  body.style.color = "rgba(18, 28, 50, 0.92)";
  body.style.whiteSpace = "pre-wrap";
  body.style.wordBreak = "break-word";
  card.appendChild(body);

  // Expanded detail (receipt chain). Hidden until tap.
  const detail = document.createElement("div");
  detail.dataset.slot = "detail";
  detail.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
  detail.style.fontSize = "10px";
  detail.style.lineHeight = "1.55";
  detail.style.color = "rgba(45, 60, 95, 0.82)";
  detail.style.whiteSpace = "pre-wrap";
  detail.style.wordBreak = "break-all";
  detail.style.marginTop = "6px";
  detail.style.paddingTop = "6px";
  detail.style.borderTop = "1px solid rgba(120, 140, 180, 0.22)";
  detail.style.display = "none";
  card.appendChild(detail);

  applyDelegationPayload(item.payload, peer, toolEl, body, detail);
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
  card.style.maxWidth = "236px";
  card.style.cursor = "pointer";
  card.style.touchAction = "pan-y";

  // Head: ◉ glyph + "memory" + short-id pill.
  const head = document.createElement("div");
  head.style.display = "flex";
  head.style.alignItems = "center";
  head.style.gap = "6px";
  head.style.marginBottom = "6px";
  head.style.minWidth = "0";

  const glyph = document.createElement("span");
  glyph.textContent = "◉";
  glyph.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
  glyph.style.fontSize = "10.5px";
  glyph.style.color = "rgba(95, 125, 180, 0.88)";
  head.appendChild(glyph);

  const label = document.createElement("span");
  label.textContent = "memory";
  label.style.fontSize = "9.5px";
  label.style.fontWeight = "600";
  label.style.letterSpacing = "0.08em";
  label.style.textTransform = "uppercase";
  label.style.color = "rgba(55, 72, 110, 0.82)";
  label.style.flex = "1 1 auto";
  head.appendChild(label);

  const shortId = document.createElement("span");
  shortId.dataset.slot = "short_id";
  shortId.style.fontFamily = "'SF Mono', Menlo, Consolas, monospace";
  shortId.style.fontSize = "9.5px";
  shortId.style.color = "rgba(95, 115, 155, 0.72)";
  shortId.style.padding = "1px 6px";
  shortId.style.borderRadius = "999px";
  shortId.style.background = "rgba(255, 255, 255, 0.45)";
  shortId.style.border = "1px solid rgba(120, 140, 180, 0.3)";
  shortId.style.letterSpacing = "0.04em";
  head.appendChild(shortId);

  card.appendChild(head);

  // Body — the memory's content, readable prose.
  const body = document.createElement("div");
  body.className = "slab-item-text";
  body.dataset.slot = "body";
  body.style.fontSize = "11.5px";
  body.style.lineHeight = "1.5";
  body.style.color = "rgba(18, 28, 50, 0.92)";
  body.style.whiteSpace = "pre-wrap";
  body.style.wordBreak = "break-word";
  body.style.maxHeight = "72px";
  body.style.overflow = "hidden";
  body.style.maskImage = "linear-gradient(180deg, black 72%, transparent 100%)";
  body.style.setProperty(
    "-webkit-mask-image",
    "linear-gradient(180deg, black 72%, transparent 100%)",
  );
  card.appendChild(body);

  applyMemoryPayload(item.payload, shortId, body);
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
  card.addEventListener("click", () => {
    const body = card.querySelector('[data-slot="body"]');
    if (!(body instanceof HTMLElement)) return;
    const expanded = card.dataset.expanded === "true";
    if (expanded) {
      card.dataset.expanded = "false";
      body.style.maxHeight = "72px";
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
    case "delegation":
      return renderDelegation(item, actions);
    case "memory":
      return renderMemory(item, actions);
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
    case "delegation":
      updateDelegation(item, element);
      break;
    case "memory":
      updateMemory(item, element);
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
