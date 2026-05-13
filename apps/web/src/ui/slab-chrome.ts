/**
 * Slab chrome dispatcher — the slab's chrome is
 * `render(controlState × embodimentMode)`, not a fixed layout that
 * lives around the screencast. Each cell of the matrix has its own
 * register; the dispatcher's job is to pick whichever cell the slab
 * is currently in and render that register.
 *
 * Doctrine: [`chrome-as-state-render.md`] § "The matrix" + § "PR 1
 * scope." The cobrowser-shaped chrome that ships today (URL bar
 * primary, nav buttons, screencast as a page the user might drive)
 * is the `user × virtual_browser` register universalized as if it
 * were the only register. The pivot inverts the default: motebit-
 * driving with task-step narration becomes the baseline; cobrowse
 * becomes a mode the user explicitly enters.
 *
 * Why a separate module from `cobrowse-chrome.ts`. The matrix is the
 * architectural primitive; `cobrowse-chrome.ts` is one cell of it
 * (the `user × virtual_browser` register, plus the `handoff_pending`
 * and `paused` transition registers that compose the cobrowse flow).
 * Keeping them physically separate names the matrix in code without
 * forcing a single module to grow every register's render. New
 * embodiment columns land as new dispatch arms here; new control-
 * state registers within `virtual_browser` land as new branches of
 * the `virtual_browser` arm.
 *
 * PR 1 scope (this commit): the `* × virtual_browser` column. The
 * dispatcher's signature is the full matrix; the implementation
 * fills only one column. The `motebit × virtual_browser` register
 * renders the task-step narration strip (the new default); the
 * other `virtual_browser` cells delegate to `renderCoBrowseChrome`
 * unchanged so the cobrowse path the surface ships today keeps
 * working. The cobrowse-as-mode reshape and `/wheel` handoff are
 * follow-up commits.
 *
 * Other embodiment columns (`mind`, `tool_result`, `shared_gaze`,
 * `desktop_drive`, `peer_viewport`) return null from the dispatcher
 * — they're named in the matrix but deferred to PR N. The
 * web-app's chrome-applier treats a null return as "no chrome strip
 * for this cell" and clears the slot.
 */

import type {
  ControlState,
  InteriorColor,
  PixelConsentState,
  SensitivityLevel,
} from "@motebit/sdk";
import type { EmbodimentMode } from "@motebit/render-engine/spec";
import type { CoBrowseControlMachine } from "@motebit/runtime";
import { renderCoBrowseChrome, type ForwardEventFn } from "./cobrowse-chrome";

export interface SlabChromeOpts {
  readonly forwardEvent?: ForwardEventFn | null;
  readonly interiorColor?: InteriorColor | null;
  readonly sensitivity?: SensitivityLevel;
  readonly pixelConsent?: PixelConsentState;
  readonly currentUrl?: string | null;
  readonly trustHeld?: boolean;
  /**
   * Task-step narration the loop validated this turn. Consumed by the
   * `motebit × virtual_browser` register as the chrome's content.
   * Null / undefined → the register recedes to its empty state. The
   * runtime's `validateTaskStepNarration` has already corrected any
   * wire-truth contradictions before this reaches the chrome, so the
   * render path doesn't second-guess the text.
   */
  readonly taskStepNarration?: string | null;
}

/**
 * Pick the chrome render for the current `controlState × embodimentMode`
 * cell. Returns null when this cell has no chrome (deferred cells, or
 * embodiment modes that don't render a chrome strip on web at all —
 * `mind` surfaces inside the body, `tool_result` in the slab item,
 * etc.). Returns an `HTMLElement` otherwise; the caller mounts it in
 * the slab's chrome slot.
 *
 * The signature is the matrix on purpose. A renderer that took only
 * `controlState` would carry the polarity error this doctrine
 * corrects (same chrome for every embodiment); a renderer that took
 * only `embodimentMode` would lose the four-register split inside
 * `virtual_browser`. The pair is the architectural primitive.
 */
export function renderSlabChrome(
  state: ControlState,
  embodimentMode: EmbodimentMode,
  machine: CoBrowseControlMachine,
  opts: SlabChromeOpts = {},
): HTMLElement | null {
  switch (embodimentMode) {
    case "virtual_browser":
      return renderVirtualBrowserChrome(state, machine, opts);
    case "mind":
    case "tool_result":
    case "shared_gaze":
    case "desktop_drive":
    case "peer_viewport":
      // PR N — named in the matrix, deferred. The `motebit × *` family
      // cells render task-step narration as voice / ambient indicators
      // / chrome strip depending on the surface; the `user × *` cells
      // collapse for embodiments the user doesn't drive (mind,
      // tool_result, peer_viewport). Each surface's specific render
      // emerges in its own PR — see
      // `chrome-as-state-render.md` § "PR 1 scope (Out of scope)".
      return null;
  }
}

/**
 * Render the `virtual_browser` column of the matrix. Picks the
 * register from `controlState.kind`:
 *
 *   - `motebit` → task-step narration register (the new default).
 *     The slab's chrome reflects motebit's first-person perceptual
 *     field; the URL inline as a read-only chip is context for the
 *     narration, not navigation chrome. `chrome-as-state-render.md`
 *     § "URL bar placement: option (ii) inline-with-narration."
 *
 *   - `user` / `handoff_pending` / `paused` → existing cobrowse
 *     chrome. These are the cells the cobrowser-shaped chrome was
 *     designed for — editable URL input + nav buttons (user),
 *     grant/deny doorbell (handoff_pending), resume affordance
 *     (paused). PR 1 leaves them on the existing render so the
 *     surface stays functional; the cobrowse-as-mode reshape
 *     (explicit entered-mode indicator, reduced register weight) is
 *     a follow-up commit.
 */
function renderVirtualBrowserChrome(
  state: ControlState,
  machine: CoBrowseControlMachine,
  opts: SlabChromeOpts,
): HTMLElement {
  if (state.kind === "motebit") {
    return renderMotebitVirtualBrowserRegister(state, machine, opts);
  }
  return renderCoBrowseChrome(state, machine, {
    forwardEvent: opts.forwardEvent ?? null,
    interiorColor: opts.interiorColor ?? null,
    sensitivity: opts.sensitivity,
    pixelConsent: opts.pixelConsent,
    currentUrl: opts.currentUrl ?? null,
    trustHeld: opts.trustHeld,
  });
}

/**
 * The `motebit × virtual_browser` register — task-step narration as
 * the chrome's primary content. Replaces the URL-bar-primary chrome
 * today renders for this cell.
 *
 * Three slots (same anatomy as `cobrowse-chrome.ts` so the strip
 * reads as one continuous surface across registers):
 *
 *   - Lead: the motebit-mark, inheriting from `renderCoBrowseChrome`'s
 *     mark grammar — same color, sensitivity ring, pixel-consent
 *     eye. Identity coherence: the chrome's tiny glyph mirrors the
 *     main creature regardless of which register fires.
 *   - Middle: the task-step narration text + URL inline as a chip.
 *     When narration is absent, the URL stands alone as a read-only
 *     display (calm-default — the chrome doesn't fabricate narration
 *     from nothing; the empty register is its own register).
 *   - Trail: empty in PR 1. Polish (`/wheel` chip-tap handoff, take-
 *     back affordance) lands in the follow-up cobrowse-as-mode
 *     commit. PR 1 leaves the trail intentionally clean so the
 *     register reads as motebit-acting, not as a control surface.
 *
 * PR 1 strategy: delegate the mark + base strip to `renderCoBrowseChrome`'s
 * `motebit` branch (which already renders the lit-mark + URL display +
 * "Take back" trail), then replace the middle slot with the narration
 * strip when narration is present. This keeps the chrome's visual
 * substrate (slab-coherent backdrop, mark grammar, sensitivity ring)
 * identical across registers and isolates the polarity-correction to
 * the content slot — exactly where the doctrine names the change.
 *
 * Specific visual treatments (typography, animation cadence, the
 * chip's read-only affordance signal) stay calm-default in PR 1
 * and emerge through dogfooding per the doctrine memo's "What this
 * doctrine deliberately does NOT specify."
 */
function renderMotebitVirtualBrowserRegister(
  state: ControlState,
  machine: CoBrowseControlMachine,
  opts: SlabChromeOpts,
): HTMLElement {
  const strip = renderCoBrowseChrome(state, machine, {
    forwardEvent: opts.forwardEvent ?? null,
    interiorColor: opts.interiorColor ?? null,
    sensitivity: opts.sensitivity,
    pixelConsent: opts.pixelConsent,
    currentUrl: opts.currentUrl ?? null,
    trustHeld: opts.trustHeld,
  });

  const narration = opts.taskStepNarration?.trim();
  if (!narration) {
    // Empty register — leave the existing middle slot (URL display)
    // as the chrome's content. The register reads as "motebit is
    // here, page is loaded, no current task-step" — calm-default.
    return strip;
  }

  // Replace the middle slot's URL display with a narration strip that
  // inlines the URL as a read-only chip after the narration text. The
  // mark + trail remain untouched.
  const middle = strip.querySelector(".cobrowse-chrome-middle");
  if (!middle) return strip;
  const narrationStrip = buildNarrationStrip(narration, opts.currentUrl ?? null);
  middle.replaceWith(narrationStrip);
  return strip;
}

/**
 * Narration + URL-chip strip for the `motebit × virtual_browser`
 * register's middle slot. Inline structure: the narration text reads
 * as motebit's first-person voice; the URL chip follows as context
 * ("Reading apple.com" — apple.com is the chip, calling out the
 * page the narration is talking about).
 *
 * The chip is also the spatial-natural handoff target — tapping it
 * is the "take the wheel" gesture, since the chip represents "the
 * page motebit is on" and grabbing it means "I'll drive that page
 * now." Wire-wise the same `motebit:cobrowse-wheel` CustomEvent the
 * `/wheel` slash command dispatches; web-app's handler does
 * `machine.reclaimControl()` + URL-bar focus in one gesture so the
 * flip is operationally complete (editable input is the affordance
 * the mode-flip unlocks). Doctrine: chrome-as-state-render.md §
 * "URL bar placement" + § "Take-the-wheel affordance in PR 1."
 *
 * Calm-default styling — inherits the strip's `font` shorthand and
 * `color` from `cobrowse-chrome.ts`'s `baseStrip`. Specific
 * typography / chip affordance signal / animation cadence stay
 * emergent through dogfooding.
 */
function buildNarrationStrip(narration: string, currentUrl: string | null): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "cobrowse-chrome-middle slab-chrome-narration";
  wrap.style.flex = "1 1 auto";
  wrap.style.minWidth = "0";
  wrap.style.display = "flex";
  wrap.style.alignItems = "baseline";
  wrap.style.gap = "8px";
  wrap.style.overflow = "hidden";
  wrap.style.whiteSpace = "nowrap";
  wrap.style.textOverflow = "ellipsis";

  const text = document.createElement("span");
  text.className = "slab-chrome-narration-text";
  text.textContent = narration;
  text.style.color = "rgba(40, 55, 90, 0.92)";
  text.style.overflow = "hidden";
  text.style.textOverflow = "ellipsis";
  wrap.appendChild(text);

  if (currentUrl) {
    wrap.appendChild(buildUrlChip(currentUrl));
  }

  return wrap;
}

/**
 * URL chip — read-only context for the narration AND the spatial-
 * natural handoff target. Rendered as a `<button type="button">` so
 * the click semantics, focus-ring, and keyboard activation all come
 * for free from the platform. The chip dispatches the same
 * `motebit:cobrowse-wheel` CustomEvent the `/wheel` slash command
 * uses — single mode-flip mechanism, multiple surface affordances
 * (slash, chip, future gesture). Doctrine binding: the chip's
 * tappability is the doctrine memo's "spatially-natural target"
 * (page motebit is on → grabbing it means take the wheel).
 *
 * Surface-determinism: dispatching the typed CustomEvent the runtime
 * already listens to means this affordance routes through the same
 * typed-capability path as the slash command. `check-affordance-
 * routing` approves by construction — no constructed prompt, no
 * AI-loop routing.
 */
function buildUrlChip(currentUrl: string): HTMLButtonElement {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "slab-chrome-narration-url-chip";
  chip.textContent = formatUrlHostForChip(currentUrl);
  chip.setAttribute(
    "aria-label",
    `Take the wheel — switch into cobrowse mode on ${chip.textContent}`,
  );
  chip.style.color = "rgba(40, 55, 90, 0.62)";
  chip.style.flex = "0 0 auto";
  // Calm-default chip register: borderless tinted text, transparent
  // background, hit area via padding. Same family as the chrome's
  // history buttons (←/→/↻) so the chip reads as part of the slab-
  // native surface, not a web-form button. Hover lifts opacity, same
  // ease curve as `buildButton`. Specific affordance signal (subtle
  // underline-on-hover, cursor glyph variant, etc.) stays emergent.
  chip.style.background = "transparent";
  chip.style.border = "none";
  chip.style.padding = "2px 4px";
  chip.style.borderRadius = "0";
  chip.style.font = "inherit";
  chip.style.cursor = "pointer";
  chip.style.userSelect = "none";
  chip.style.pointerEvents = "auto";
  chip.style.transition = "color 120ms ease-out";
  chip.addEventListener("mouseenter", () => {
    chip.style.color = "rgba(40, 55, 90, 0.92)";
  });
  chip.addEventListener("mouseleave", () => {
    chip.style.color = "rgba(40, 55, 90, 0.62)";
  });
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    document.dispatchEvent(new CustomEvent("motebit:cobrowse-wheel"));
  });
  return chip;
}

/**
 * Reduce a URL to its host for chip rendering. The chip's job is to
 * tether the narration to the page motebit is currently working with
 * ("Reading [apple.com]"); the full path would overcrowd the strip
 * and break the calm-default register. Falls back to the raw URL
 * when parsing throws — defensive, never empty.
 */
function formatUrlHostForChip(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return url.replace(/^https?:\/\//i, "");
  }
}
