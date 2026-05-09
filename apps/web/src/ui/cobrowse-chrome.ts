/**
 * Co-browse Chrome-1 — unified browser-chrome strip for the cloud
 * Chromium slab.
 *
 * Replaces the prior split between Slice 2b's control band ("Motebit
 * is driving" doorbell) and Slice 2c's address bar (← → ⟳ + URL
 * input). Both lived as separate floating elements above the live
 * screencast; chrome-1 collapses them into a single strip that
 * speaks motebit's voice about the browser.
 *
 * **Three slots, no widgets.** Lead = motebit-mark (the living
 * glyph, a tiny mirror of the creature). Middle = destination
 * (URL input when user-driving, caption when motebit-driving).
 * Trail = contextual affordance (take back / grant + deny / nav
 * arrows / resume).
 *
 * **Always present.** Unlike the old band (null on `user` state),
 * the chrome strip is always mounted. The user is browsing → the
 * URL input is editable. Motebit is driving → the trail is "take
 * back". Handoff pending → the trail is grant/deny. State changes
 * shift content within the strip; the strip itself doesn't
 * appear/disappear.
 *
 * **Identity coherence.** The mark in the lead slot reads the
 * runtime's `InteriorColor` so the strip's tiny glyph mirrors
 * the main creature's substrate — same color, same droplet feel.
 * Phase 1a is static (no breathing/animation); chrome-1c will
 * fold in the Liquescentia substrate's breathing primitive so
 * the mark and the creature inhale/exhale together.
 *
 * **Doctrine bindings:**
 *
 *   - `surface-determinism.md` (Principle 90). Every button click
 *     invokes a typed capability on the machine directly
 *     (`machine.grantControl("user")`, etc.) or dispatches a typed
 *     `UserInputEvent` via `forwardEvent`. No prompts constructed;
 *     no AI-loop routing. The `check-affordance-routing` gate
 *     scans this directory and would fail any drift.
 *   - `motebit-computer.md` §"Slab content vs slab chrome." The
 *     strip is chrome (state about the view). The page below is
 *     content (the view itself). One does not narrate the other.
 *   - Calm software (`CLAUDE.md` §UI). Default state is empty
 *     trail. Captions only appear when state has something to say
 *     ("paused", "asks to drive {host}"). The strip is restraint
 *     made visible.
 *
 * **What this replaces:**
 *
 *   - `renderCoBrowseBand` (Slice 2b — handoff doorbell, motebit
 *     reclaim, paused resume). Folded into the trail slot.
 *   - `renderCoBrowseAddressBar` (Slice 2c — URL input + ← → ⟳).
 *     Folded into the middle + trail slots, present only on
 *     `user` state.
 *   - `normalizeUrl` (Slice 2d). Preserved as an export from this
 *     module — call sites move from `cobrowse-address-bar` to
 *     `cobrowse-chrome` in a single search-and-replace.
 *
 * **What chrome-1a does NOT yet do** (deferred to chrome-1b/c):
 *
 *   - Sensitivity ring around the mark (chrome-1b: colored
 *     outline keyed off `runtime.getSessionSensitivity()` when
 *     tier > none).
 *   - Pixel-consent eye-shape on the mark (chrome-1b: keyed off
 *     `runtime.getPixelConsent()`).
 *   - Transient act animations — read_page ripple, screenshot
 *     shutter, click pulse (chrome-1c: hooks into the existing
 *     tool_status chunk stream).
 *   - URL display when motebit drives (chrome-1b: needs surface-
 *     side URL tracking via navigate-result events).
 */

import type { ControlState, InteriorColor, UserInputEvent } from "@motebit/sdk";
import type { CoBrowseControlMachine, UserInputForwardResult } from "@motebit/runtime";

/** Direct typed-capability dispatch — same shape as cobrowse-input-capture's forwardEvent. */
export type ForwardEventFn = (event: UserInputEvent) => Promise<UserInputForwardResult>;

export interface RenderCoBrowseChromeOpts {
  /**
   * User-input forwarder. Required when `state.kind === "user"`
   * (the URL input + ← → ⟳ buttons need it). Omitted (or null) is
   * NOT a hard error during user state — the chrome silently drops
   * the affordances rather than ship a non-functional input. In
   * practice the surface always wires this; this guard is
   * defense-in-depth for early-init races where the live-browser
   * handle hasn't published its `forwardUserInput` yet.
   */
  readonly forwardEvent?: ForwardEventFn | null;
  /**
   * The motebit's interior color. The mark in the lead slot
   * reads from this so the strip mirrors the user-chosen creature
   * color. `null` (no preset chosen yet) falls back to a neutral
   * cool tone — the mark is still rendered, just without identity
   * coherence with the main creature.
   */
  readonly interiorColor?: InteriorColor | null;
}

/**
 * Build the unified chrome strip for the given control state.
 * Always returns an element — the strip is always present. The
 * machine reference is captured by handlers; buttons drive
 * transitions through typed capabilities.
 */
export function renderCoBrowseChrome(
  state: ControlState,
  machine: CoBrowseControlMachine,
  opts: RenderCoBrowseChromeOpts = {},
): HTMLElement {
  const strip = baseStrip(state.kind);
  strip.appendChild(buildMark(state, opts.interiorColor ?? null));
  // Normalize `null` → `undefined` for the slot builders so their
  // signatures don't have to accept both shapes.
  const forwardEvent = opts.forwardEvent ?? undefined;
  strip.appendChild(buildMiddle(state, forwardEvent));
  strip.appendChild(buildTrail(state, machine, forwardEvent));
  return strip;
}

// ── Layout ─────────────────────────────────────────────────────────────

function baseStrip(stateKind: ControlState["kind"]): HTMLDivElement {
  const strip = document.createElement("div");
  strip.className = `cobrowse-chrome cobrowse-chrome-${stateKind}`;
  strip.style.display = "flex";
  strip.style.alignItems = "center";
  strip.style.gap = "12px";
  strip.style.padding = "8px 14px";
  strip.style.margin = "8px";
  strip.style.borderRadius = "10px";
  strip.style.background = "rgba(255, 255, 255, 0.72)";
  strip.style.backdropFilter = "blur(12px)";
  // Vendor-prefixed sibling for Safari < 18.
  (strip.style as unknown as Record<string, string>)["webkitBackdropFilter"] = "blur(12px)";
  strip.style.border = "1px solid rgba(120, 140, 180, 0.32)";
  strip.style.boxShadow = "0 2px 8px rgba(40, 55, 90, 0.08)";
  strip.style.font =
    "13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
  strip.style.color = "rgba(40, 55, 90, 0.92)";
  strip.style.pointerEvents = "auto";
  // The handoff_pending case is the one the chrome owes attention
  // to — a subtle accent on the left edge keeps the strip calm but
  // readable as "this needs you." Same shape as the prior band's
  // doorbell register.
  if (stateKind === "handoff_pending") {
    strip.style.borderLeft = "3px solid rgba(80, 130, 200, 0.85)";
  }
  return strip;
}

// ── Lead — the living mark ─────────────────────────────────────────────

function buildMark(state: ControlState, color: InteriorColor | null): HTMLElement {
  const mark = document.createElement("div");
  mark.className = `cobrowse-chrome-mark cobrowse-chrome-mark-${state.kind}`;
  mark.setAttribute("aria-hidden", "true");
  mark.style.flex = "0 0 auto";
  mark.style.width = "14px";
  mark.style.height = "14px";
  mark.style.borderRadius = "50%";
  mark.style.position = "relative";
  // Identity coherence — mark color reads from the user's chosen
  // interior preset so the tiny glyph mirrors the main creature.
  // Phase 1a uses a static gradient; phase 1c will share the
  // creature's breathing primitive.
  const tint = color?.tint ?? [0.78, 0.78, 0.92];
  const glow = color?.glow ?? [0.55, 0.55, 0.85];
  const tintCss = rgb(tint);
  const glowCss = rgb(glow);
  // State-coupled visual treatment. The mark IS the state machine
  // made visible — no labels, no captions in the lead. Different
  // postures express different states.
  switch (state.kind) {
    case "motebit": {
      // Focused, leaning forward. Bright, full opacity. Drop-shadow
      // glow signals "active and looking."
      mark.style.background = `radial-gradient(circle at 30% 30%, ${rgba(glow, 0.95)} 0%, ${rgba(tint, 0.92)} 70%)`;
      mark.style.boxShadow = `0 0 8px ${rgba(glow, 0.55)}`;
      mark.style.opacity = "1";
      break;
    }
    case "user": {
      // Calm, dimmed — sleeping. The user is driving; motebit
      // watches from the side.
      mark.style.background = `radial-gradient(circle at 30% 30%, ${rgba(glow, 0.55)} 0%, ${rgba(tint, 0.55)} 70%)`;
      mark.style.boxShadow = "none";
      mark.style.opacity = "0.62";
      break;
    }
    case "handoff_pending": {
      // Asking. Bright, with a softened pulse intent — phase 1a is
      // a static "alert" coloring; phase 1c will animate.
      mark.style.background = `radial-gradient(circle at 30% 30%, ${rgba(glow, 1)} 0%, ${rgba(tint, 0.96)} 70%)`;
      mark.style.boxShadow = `0 0 10px ${rgba(glow, 0.7)}`;
      mark.style.opacity = "1";
      break;
    }
    case "paused": {
      // Held — desaturated outline. Neither party drives.
      mark.style.background = `radial-gradient(circle at 30% 30%, ${rgba(tint, 0.4)} 0%, ${rgba(tint, 0.3)} 70%)`;
      mark.style.boxShadow = "none";
      mark.style.opacity = "0.5";
      mark.style.border = `1px solid ${rgba(tint, 0.45)}`;
      break;
    }
  }
  // Cast for the unused-locals lint — these variables are used
  // implicitly via `rgba(...)` calls above; the explicit string
  // bindings exist for readability and would-be-future use.
  void tintCss;
  void glowCss;
  return mark;
}

// ── Middle — the destination ───────────────────────────────────────────

function buildMiddle(state: ControlState, forwardEvent: ForwardEventFn | undefined): HTMLElement {
  switch (state.kind) {
    case "user":
      // The URL input — editable, only visible to the user when
      // they're driving. Empty input is the resting state; typing
      // a URL and pressing Enter dispatches navigate via the wire
      // event. Address-bar typing belongs to the bar, not Chromium
      // below — keydown events stop propagation so the input-
      // capture module's document-level handler doesn't ALSO see
      // them.
      return forwardEvent ? buildUrlInput(forwardEvent) : buildEmptyMiddle();
    case "motebit":
      // Motebit drives — empty middle. The mark says state, the
      // page below shows the destination. Restraint: don't repeat.
      return buildEmptyMiddle();
    case "handoff_pending":
      return buildCaption("asks to drive");
    case "paused":
      return buildCaption("paused");
  }
}

function buildEmptyMiddle(): HTMLDivElement {
  // Spacer that fills the middle slot when no caption / input is
  // appropriate. Keeps the trail right-aligned.
  const spacer = document.createElement("div");
  spacer.className = "cobrowse-chrome-middle cobrowse-chrome-middle-empty";
  spacer.style.flex = "1 1 auto";
  spacer.style.minWidth = "0";
  return spacer;
}

function buildCaption(text: string): HTMLDivElement {
  const caption = document.createElement("div");
  caption.className = "cobrowse-chrome-middle cobrowse-chrome-caption";
  caption.textContent = text;
  caption.style.flex = "1 1 auto";
  caption.style.minWidth = "0";
  caption.style.overflow = "hidden";
  caption.style.textOverflow = "ellipsis";
  caption.style.whiteSpace = "nowrap";
  caption.style.color = "rgba(40, 55, 90, 0.86)";
  return caption;
}

function buildUrlInput(forwardEvent: ForwardEventFn): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "cobrowse-chrome-middle cobrowse-chrome-url-input";
  input.type = "url";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.placeholder = "type a URL";
  input.style.flex = "1 1 auto";
  input.style.minWidth = "0";
  input.style.background = "transparent";
  input.style.border = "none";
  input.style.outline = "none";
  input.style.font = "inherit";
  input.style.color = "inherit";
  input.style.pointerEvents = "auto";
  input.addEventListener("keydown", (e) => {
    // Stop propagation — address-bar typing must NOT reach the
    // input-capture module's document-level keydown handler that
    // forwards keystrokes into Chromium.
    e.stopPropagation();
    if (e.key !== "Enter") return;
    e.preventDefault();
    const raw = input.value.trim();
    if (raw.length === 0) return;
    const url = normalizeUrl(raw);
    void forwardEvent({ kind: "navigate", url }).catch((err: unknown) => {
      // eslint-disable-next-line no-console -- fail-soft default; surface logger wiring follows the same shape as cobrowse-input-capture
      console.warn("co-browse navigate forward threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    input.value = "";
  });
  // Same propagation discipline for the other typing events.
  input.addEventListener("keypress", (e) => e.stopPropagation());
  input.addEventListener("keyup", (e) => e.stopPropagation());
  input.addEventListener("paste", (e) => e.stopPropagation());
  return input;
}

// ── Trail — contextual affordance ──────────────────────────────────────

function buildTrail(
  state: ControlState,
  machine: CoBrowseControlMachine,
  forwardEvent: ForwardEventFn | undefined,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "cobrowse-chrome-trail";
  row.style.display = "flex";
  row.style.gap = "6px";
  row.style.flex = "0 0 auto";

  switch (state.kind) {
    case "motebit":
      row.appendChild(
        buildButton("Take back", "secondary", () => {
          machine.reclaimControl();
        }),
      );
      break;
    case "handoff_pending":
      // Doorbell affordance — Grant / Deny. The state machine
      // rejects user-issued requests with `wrong_party`; this only
      // appears on `current === "user"`, so the buttons are always
      // legal-from-here. Defensive: peer-side requests in a future
      // protocol revision would land at `current !== "user"` and
      // we'd want different affordances — guard preserved.
      if (state.current !== "user") break;
      row.appendChild(
        buildButton("Grant", "primary", () => {
          machine.grantControl("user");
        }),
      );
      row.appendChild(
        buildButton("Deny", "secondary", () => {
          machine.denyControl("user");
        }),
      );
      break;
    case "paused":
      row.appendChild(
        buildButton("Resume", "primary", () => {
          machine.resume("user");
        }),
      );
      break;
    case "user":
      // Nav arrows — only meaningful when the user is driving.
      // The icons vanish when motebit takes over; motebit has its
      // own navigate/back/forward tools.
      if (forwardEvent) {
        row.appendChild(buildHistoryButton("←", "back", forwardEvent, "Go back"));
        row.appendChild(buildHistoryButton("→", "forward", forwardEvent, "Go forward"));
        row.appendChild(buildHistoryButton("↻", "reload", forwardEvent, "Reload"));
      }
      break;
  }
  return row;
}

// ── Shared — buttons ───────────────────────────────────────────────────

function buildButton(
  label: string,
  register: "primary" | "secondary",
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `cobrowse-chrome-btn cobrowse-chrome-btn-${register}`;
  btn.textContent = label;
  btn.style.font = "inherit";
  btn.style.padding = "5px 12px";
  btn.style.borderRadius = "6px";
  btn.style.cursor = "pointer";
  btn.style.userSelect = "none";
  btn.style.pointerEvents = "auto";
  btn.style.transition = "background 120ms ease-out, border-color 120ms ease-out";
  if (register === "primary") {
    btn.style.background = "rgba(80, 130, 200, 0.92)";
    btn.style.color = "rgba(255, 255, 255, 0.96)";
    btn.style.border = "1px solid rgba(60, 110, 180, 0.85)";
  } else {
    btn.style.background = "rgba(255, 255, 255, 0.62)";
    btn.style.color = "rgba(40, 55, 90, 0.86)";
    btn.style.border = "1px solid rgba(120, 140, 180, 0.45)";
  }
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function buildHistoryButton(
  glyph: string,
  kind: "back" | "forward" | "reload",
  forwardEvent: ForwardEventFn,
  label: string,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `cobrowse-chrome-btn cobrowse-chrome-btn-history cobrowse-chrome-btn-${kind}`;
  btn.textContent = glyph;
  btn.setAttribute("aria-label", label);
  btn.style.flex = "0 0 auto";
  btn.style.width = "26px";
  btn.style.height = "26px";
  btn.style.padding = "0";
  btn.style.font = "16px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
  btn.style.color = "rgba(40, 55, 90, 0.78)";
  btn.style.background = "rgba(255, 255, 255, 0.62)";
  btn.style.border = "1px solid rgba(120, 140, 180, 0.32)";
  btn.style.borderRadius = "6px";
  btn.style.cursor = "pointer";
  btn.style.userSelect = "none";
  btn.style.pointerEvents = "auto";
  btn.style.transition = "background 120ms ease-out";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    void forwardEvent({ kind }).catch((err: unknown) => {
      // eslint-disable-next-line no-console -- fail-soft default
      console.warn(`co-browse ${kind} forward threw`, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
  return btn;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Normalize an address-bar input into a wire-format URL. Mirror of
 * the server-side regex in `services/browser-sandbox/src/action-
 * executor.ts`: a leading scheme passes through; anything else
 * gets `https://` prepended.
 *
 * Exported for unit testing AND for migration callers — preserves
 * the export from the deleted `cobrowse-address-bar` module.
 */
export function normalizeUrl(input: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;
  return `https://${input}`;
}

/** Convert a 0-1 RGB triplet to a CSS `rgb(...)` string. */
function rgb(c: readonly [number, number, number]): string {
  return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
}

/** Convert a 0-1 RGB triplet plus alpha to a CSS `rgba(...)` string. */
function rgba(c: readonly [number, number, number], a: number): string {
  return `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${a})`;
}
