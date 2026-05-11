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
 * **chrome-1b additions** (shipped alongside chrome-1a in the
 * cobrowse-chrome arc):
 *
 *   - Sensitivity ring around the mark — faint colored outer
 *     border when `runtime.getSessionSensitivity()` returns a tier
 *     above `personal`. Three intentional hues: warm coral
 *     (medical), muted green (financial), cool gray (secret).
 *     Calm baseline (`none` / `personal`) renders no ring — the
 *     gate doesn't fire on those tiers.
 *   - Pixel-consent eye glyph inside the mark when
 *     `runtime.getPixelConsent()` is `"session"` (consent granted).
 *     Default `"denied"` renders nothing — calm default.
 *   - URL display (via the chrome-1a-fix surface tracking)
 *     already feeds prompt-1's `[Now]` block; the chrome strip's
 *     middle slot stays bare on motebit-driving by design (the
 *     live screencast is the destination view).
 *
 * **What's still deferred to chrome-1c:**
 *
 *   - Transient act animations — read_page ripple, screenshot
 *     shutter, click pulse (hooks into the existing tool_status
 *     chunk stream + receipts-1 bus).
 *   - Receipt-shimmer on the mark when each act signs (composes
 *     with chrome-1c — same primitive, different trigger).
 */

import type {
  ControlState,
  InteriorColor,
  PixelConsentState,
  SensitivityLevel,
  UserInputEvent,
} from "@motebit/sdk";
import type { CoBrowseControlMachine, UserInputForwardResult } from "@motebit/runtime";

/** Direct typed-capability dispatch — same shape as cobrowse-input-capture's forwardEvent. */
export type ForwardEventFn = (event: UserInputEvent) => Promise<UserInputForwardResult>;

/**
 * Per-input animation registry. Tracks the breathing `Animation`
 * handle so focus/blur/input listeners can start/stop without
 * stacking duplicate animations on the same element. `WeakMap` so
 * the entry GCs naturally when the input is removed from the DOM.
 */
const urlInputBreathing = new WeakMap<HTMLInputElement, Animation>();

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
  /**
   * chrome-1b — effective session sensitivity tier. When `> none`,
   * the mark gets a faint colored outer ring (warm for medical,
   * green for financial, gray for secret). Calm-software register:
   * the ring only appears when there's something to say. Default
   * `none` means no ring is rendered.
   *
   * Closes the visible-state side of "nothing sensitive crosses
   * boundaries silently" — vision-1's gates and prompt-1's `[Now]`
   * block already make the AI aware; this makes the USER aware
   * without parsing chat or running `/sensitivity status`.
   */
  readonly sensitivity?: SensitivityLevel;
  /**
   * chrome-1b — per-session pixel-passthrough consent. When granted
   * (`session`), an eye-shape glyph appears inside the mark. Calm
   * default: no glyph when denied. The glyph maps directly to the
   * vision-1 gate state — the user reads the mark and knows whether
   * motebit can currently see images.
   */
  readonly pixelConsent?: PixelConsentState;
  /**
   * Current URL of the cloud-browser session. When set AND the
   * state is `user`, the URL input renders this as its `value` so
   * the user sees what page they're on (browser convention — Chrome,
   * Safari, Firefox always show the current URL in the address bar).
   * Null/undefined → input renders empty with the
   * "type a URL · or ask motebit" placeholder. Wired by the surface from
   * `runtime.setBrowserSessionProvider` / `_currentBrowserUrl`.
   */
  readonly currentUrl?: string | null;
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
  strip.appendChild(
    buildMark(state, opts.interiorColor ?? null, {
      sensitivity: opts.sensitivity,
      pixelConsent: opts.pixelConsent,
    }),
  );
  // Normalize `null` → `undefined` for the slot builders so their
  // signatures don't have to accept both shapes.
  const forwardEvent = opts.forwardEvent ?? undefined;
  strip.appendChild(buildMiddle(state, forwardEvent, opts.currentUrl ?? null));
  strip.appendChild(buildTrail(state, machine, forwardEvent));
  return strip;
}

// ── Layout ─────────────────────────────────────────────────────────────

/**
 * Always-present URL-bar register. Browser convention is a
 * persistent address bar — it's the user's primary navigation
 * affordance; making it fade in dominant states (the prior
 * "calm-chrome simplification") meant the URL bar overlapped
 * page content because it had no visual frame to occlude
 * underlying pixels with. Real browsers (Chrome, Safari,
 * Firefox) all have an OPAQUE URL-bar row at the top of the
 * window; content flows beneath it.
 *
 * Single register: glass-blur surround on every state, plus a
 * `handoff_pending`-specific left-accent for the doorbell. The
 * differentiator across states is now CONTENT (URL input vs
 * caption vs Grant/Deny) + the mark's visual register (lit /
 * dimmed / asking / held), not chrome surround.
 *
 * Architectural correction (2026-05-09): the prior calm/present
 * split inverted the right relationship. The calm state isn't
 * the *visual* register — it's the *content* register. URL bar
 * stays fully present visually because it's a navigation
 * affordance the user always wants to see; the chrome's content
 * is what changes (URL input vs caption) to reflect state.
 */
function baseStrip(stateKind: ControlState["kind"]): HTMLDivElement {
  const strip = document.createElement("div");
  strip.className = `cobrowse-chrome cobrowse-chrome-${stateKind}`;
  strip.style.display = "flex";
  strip.style.alignItems = "center";
  strip.style.gap = "10px";
  // Horizontal padding accommodates the slab's top-corner curve. The
  // stage's borderRadius is ~83px (matching the slab's meniscus); the
  // chrome strip occupies a ~54px-tall band entirely inside that
  // curve, so at the strip's vertical center the silhouette is
  // ~22px inset from each rectangular edge. With 36px horizontal
  // padding, the rightmost affordance (reload icon) sits well inside
  // the silhouette at y_center, not at the silhouette boundary.
  // Vertical padding holds at 12px to give the strip a comfortable
  // height without competing with the URL field's natural metrics.
  strip.style.padding = "12px 36px";
  // Push the strip down by ~8px so its top edge is below the most-
  // curved region of the slab's top corner (which curves to a point
  // at y=0). Above the strip, ~8px of glass shows the meniscus —
  // chrome reads as inside the slab, not flush to its highest curve.
  strip.style.margin = "8px 0 0 0";
  strip.style.borderRadius = "0";
  // Slab-coherent material (motebit-computer.md §"Visual properties").
  // Very subtle tint inherits the slab's substrate. The strong
  // backdrop blur is the vibrancy register Apple-grade chrome uses
  // when sitting on a content surface — content visible through is
  // blurred to unreadable, the chrome material reads as ONE with
  // the slab beneath it. Heavy saturate boosts the underlying soul
  // tint so the chrome's chromatic character matches the slab body.
  strip.style.background = "rgba(255, 255, 255, 0.06)";
  strip.style.backdropFilter = "blur(40px) saturate(1.8)";
  (strip.style as unknown as Record<string, string>)["webkitBackdropFilter"] =
    "blur(40px) saturate(1.8)";
  // No full border. A hairline bottom separates chrome from the
  // content register below — the only edge that signals "chrome
  // stops here, content begins." Same shape as Apple's vibrancy
  // chrome (Finder window title bar, Safari title bar).
  strip.style.border = "none";
  strip.style.borderBottom = "1px solid rgba(120, 140, 180, 0.12)";
  // No drop shadow. Chrome is part of the slab's silhouette, not a
  // separate object casting a shadow on the slab body.
  strip.style.boxShadow = "none";
  strip.style.font =
    "13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
  strip.style.color = "rgba(40, 55, 90, 0.92)";
  strip.style.pointerEvents = "auto";

  // Doorbell accent on the one state that truly asks. Other
  // states keep the chrome neutral — the accent only fires when
  // the user needs to make a decision.
  if (stateKind === "handoff_pending") {
    strip.style.borderLeft = "3px solid rgba(80, 130, 200, 0.85)";
  }
  return strip;
}

// ── Lead — the living mark ─────────────────────────────────────────────

function buildMark(
  state: ControlState,
  color: InteriorColor | null,
  decorations: {
    readonly sensitivity?: SensitivityLevel;
    readonly pixelConsent?: PixelConsentState;
  } = {},
): HTMLElement {
  // chrome-1b — wrap the mark in a positioned container so the
  // sensitivity ring (outer absolute pseudo-glyph) and pixel eye
  // (inner pseudo-glyph) layer cleanly without leaking into the
  // strip's flex layout. The wrapper takes the lead slot's
  // dimensions; the inner mark is the gradient circle as before.
  const wrap = document.createElement("div");
  wrap.className = "cobrowse-chrome-mark-wrap";
  wrap.setAttribute("aria-hidden", "true");
  wrap.style.flex = "0 0 auto";
  wrap.style.position = "relative";
  wrap.style.width = "14px";
  wrap.style.height = "14px";

  const mark = document.createElement("div");
  mark.className = `cobrowse-chrome-mark cobrowse-chrome-mark-${state.kind}`;
  mark.style.position = "absolute";
  mark.style.inset = "0";
  mark.style.borderRadius = "50%";
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

  wrap.appendChild(mark);

  // chrome-1b — sensitivity ring: a faint colored outer halo
  // around the mark when the session tier is elevated above
  // `none`. Three tiers, three intentional hues:
  //   - medical     → warm coral (medical context, calm but
  //                    distinct from "warning")
  //   - financial   → muted green (the universal money signifier
  //                    without being garish)
  //   - secret      → cool gray (most restrained — when sensitive
  //                    enough to need full sovereign isolation,
  //                    the chrome whispers, doesn't shout)
  // The ring is a positioned ::after-shaped div outside the mark.
  // Stays subtle — calm-software register, not a notification dot.
  const sensitivity = decorations.sensitivity;
  const ringColor = sensitivity ? sensitivityRingColor(sensitivity) : null;
  if (ringColor) {
    const ring = document.createElement("div");
    ring.className = `cobrowse-chrome-mark-ring cobrowse-chrome-mark-ring-${sensitivity}`;
    ring.style.position = "absolute";
    ring.style.inset = "-3px";
    ring.style.borderRadius = "50%";
    ring.style.border = `1.5px solid ${ringColor}`;
    ring.style.pointerEvents = "none";
    wrap.appendChild(ring);
  }

  // chrome-1b — pixel-consent eye: a small inner glyph on the
  // mark when pixel passthrough is granted. Eye-open shape is the
  // signal "motebit can currently see images." Default `denied`
  // renders nothing — calm default, no glyph clutter when the
  // common case (no pixel sharing) is in effect.
  if (decorations.pixelConsent === "session") {
    const eye = document.createElement("div");
    eye.className = "cobrowse-chrome-mark-eye";
    // Small darker inner dot — reads as "pupil," signals "eye is
    // open / can see." Position at center using absolute inset.
    eye.style.position = "absolute";
    eye.style.top = "50%";
    eye.style.left = "50%";
    eye.style.transform = "translate(-50%, -50%)";
    eye.style.width = "5px";
    eye.style.height = "5px";
    eye.style.borderRadius = "50%";
    // Use the creature's tint at high alpha for the pupil — same
    // identity-coherence rule as the mark's gradient. Looks like
    // the creature's eye, scaled down.
    eye.style.background = rgba(tint, 0.9);
    eye.style.boxShadow = `0 0 3px ${rgba(glow, 0.6)}`;
    eye.style.pointerEvents = "none";
    wrap.appendChild(eye);
  }

  return wrap;
}

/**
 * Map sensitivity tier → ring color. Returns null for `none` and
 * `personal` (calm baseline; `personal` is common enough that a
 * permanent ring would be visual noise). Elevated tiers
 * (`medical` / `financial` / `secret`) get distinct hues so the
 * user can read the mark at a glance.
 *
 * Hues are restrained — soft, not warning-grade. Calm software:
 * the ring is a presence indicator, not an alarm.
 */
function sensitivityRingColor(level: SensitivityLevel): string | null {
  switch (level) {
    case "medical" as SensitivityLevel:
      return "rgba(220, 130, 110, 0.62)"; // warm coral
    case "financial" as SensitivityLevel:
      return "rgba(110, 165, 130, 0.62)"; // muted green
    case "secret" as SensitivityLevel:
      return "rgba(140, 145, 165, 0.62)"; // cool gray
    default:
      // `none` and `personal` — no ring. Personal is too common to
      // mark permanently; the gate doesn't fire on personal alone.
      return null;
  }
}

// ── Middle — the destination ───────────────────────────────────────────

function buildMiddle(
  state: ControlState,
  forwardEvent: ForwardEventFn | undefined,
  currentUrl: string | null,
): HTMLElement {
  switch (state.kind) {
    case "user":
      // The URL input — editable, only visible to the user when
      // they're driving. Pre-populated with the current URL so
      // the user sees what page they're on (browser convention).
      // Typing a URL and pressing Enter dispatches navigate via
      // the wire event. Address-bar typing belongs to the bar,
      // not Chromium below — keydown events stop propagation so
      // the input-capture module's document-level handler doesn't
      // ALSO see them.
      return forwardEvent ? buildUrlInput(forwardEvent, currentUrl) : buildEmptyMiddle();
    case "motebit":
      // Motebit drives — show current URL as a read-only display
      // so the user sees where motebit has navigated to. Same
      // shape as Safari's URL bar when a tab is loading.
      return currentUrl ? buildUrlDisplay(currentUrl) : buildEmptyMiddle();
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

/**
 * Read-only URL display for `motebit`-driving state. Embedded into
 * the chrome's substrate — same register as the user-driving input,
 * only the editability changes. Browser convention is the URL bar
 * always shows the current URL regardless of who's driving.
 */
function buildUrlDisplay(url: string): HTMLDivElement {
  const display = document.createElement("div");
  display.className = "cobrowse-chrome-middle cobrowse-chrome-url-display";
  display.textContent = formatUrlForDisplay(url);
  display.style.flex = "1 1 auto";
  display.style.minWidth = "0";
  display.style.padding = "4px 8px";
  display.style.borderRadius = "0";
  display.style.background = "transparent";
  display.style.border = "none";
  display.style.color = "rgba(40, 55, 90, 0.86)";
  display.style.font = "inherit";
  display.style.overflow = "hidden";
  display.style.textOverflow = "ellipsis";
  display.style.whiteSpace = "nowrap";
  return display;
}

/**
 * Strip the `https://` / `http://` scheme for display when present,
 * since the URL bar's primary register is "what site am I on" not
 * "what's the literal URL." Same convention as Safari's URL bar.
 */
function formatUrlForDisplay(url: string): string {
  return url.replace(/^https?:\/\//i, "");
}

function buildUrlInput(forwardEvent: ForwardEventFn, currentUrl: string | null): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "cobrowse-chrome-middle cobrowse-chrome-url-input";
  input.type = "url";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.autocapitalize = "off";
  // Two-modality hint per motebit-computer.md §"Empty register":
  // the URL input is the slab's empty affordance. Two paths: type
  // a URL into the chrome, or ask motebit in chat. Same surface,
  // two grammars, one calm prompt.
  input.placeholder = "type a URL · or ask motebit";
  // Pre-populate with the current URL — Chrome / Safari / Firefox
  // all show the current URL in the address bar by default; users
  // expect to see where they are. Edit-to-navigate replaces the
  // value as they type.
  if (currentUrl) {
    input.value = formatUrlForDisplay(currentUrl);
  }
  input.style.flex = "1 1 auto";
  input.style.minWidth = "0";
  // Embedded into the slab's chrome — no pill background, no
  // visible border, no rounded corner. The URL input IS the
  // chrome's content register; it doesn't need its own surround.
  // The strip's own backdrop-blur provides the substrate.
  input.style.padding = "4px 8px";
  input.style.borderRadius = "0";
  input.style.background = "transparent";
  input.style.border = "none";
  input.style.outline = "none";
  input.style.font = "inherit";
  input.style.color = "rgba(40, 55, 90, 0.92)";
  input.style.pointerEvents = "auto";

  // Empty-register breathing per motebit-computer.md §"Visual
  // properties" — the URL input IS the slab's empty state, and the
  // doctrine pins it to breathe at the slab's 30% creature
  // amplitude when empty + unfocused. The body breathes at 0.3 Hz
  // (Rayleigh eigenmode, see DROPLET.md); the slab inherits at 30%
  // amplitude; this register inherits the same rhythm so the empty
  // slab pulses sympathetically with the body that owns it.
  //
  // 0.3 Hz = 3333ms period. Opacity range 0.7 → 0.85 → 0.7 — a calm
  // pulse, not a flash. Web Animations API lets us start/stop
  // cleanly on focus/value changes without injecting a stylesheet.
  // Animates the whole input, but since the input is empty +
  // unfocused, only the placeholder is visible — the placeholder
  // is what breathes.
  const startBreathing = () => {
    if (urlInputBreathing.has(input)) return;
    // jsdom: Element.animate may not exist in the test environment.
    // Calm fallback: no breathing in environments without the API.
    if (typeof input.animate !== "function") return;
    const anim = input.animate([{ opacity: "0.7" }, { opacity: "0.85" }, { opacity: "0.7" }], {
      duration: 3333,
      iterations: Infinity,
      easing: "ease-in-out",
    });
    urlInputBreathing.set(input, anim);
  };
  const stopBreathing = () => {
    const anim = urlInputBreathing.get(input);
    if (!anim) return;
    anim.cancel();
    urlInputBreathing.delete(input);
    input.style.opacity = "";
  };

  // Start breathing iff the input is currently empty. When the
  // surface pre-populates with a current URL (currentUrl != null),
  // the value is the visible register and breathing would oscillate
  // the user's URL — wrong. Stay solid in that case.
  if (input.value === "") startBreathing();

  // Focus styling — barely-there tint at the seam, no border ring.
  // Calm-software register: focus is a hint, not an alarm.
  input.addEventListener("focus", () => {
    input.style.background = "rgba(255, 255, 255, 0.12)";
    // Stop breathing on focus — the user's about to type; the
    // placeholder shouldn't pulse while a caret is sitting in it.
    stopBreathing();
  });
  input.addEventListener("blur", () => {
    input.style.background = "transparent";
    // Resume breathing on blur if still empty. If the user typed
    // and submitted, the value is set and breathing stays off
    // (handled in the `input` listener below).
    if (input.value === "") startBreathing();
  });
  input.addEventListener("input", () => {
    // Any keystroke that makes the value non-empty stops the
    // breathing — the placeholder is gone, the user's content is
    // the visible register, breathing would oscillate it. Resume
    // if the user backspaces back to empty AND the input has lost
    // focus (handled in `blur`).
    if (input.value !== "" && urlInputBreathing.has(input)) {
      stopBreathing();
    }
  });
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
    // Apple-grade: keep the typed value visible through submission,
    // release focus so the editing register ends. The chrome's
    // natural re-render on `_currentBrowserUrl` update refines the
    // displayed value to its canonical form (typed `google.com` →
    // resolved `https://google.com/`) — same transition Safari
    // shows. Clearing the input synchronously here used to flash
    // the placeholder between Enter and resolution
    // because the navigate result is async; the user perceived the
    // bar going blank then their URL coming back. Blur ends the
    // edit register without the flash.
    input.blur();
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
  // Borderless tinted glyph — Apple HIG ornament pattern for chrome
  // affordances. No framed cell, no background, no border. The
  // glyph IS the affordance; the cell that used to surround it
  // was web-form-shaped UI that broke the slab-native register.
  // Hit area expanded via padding so the glyph stays comfortably
  // tappable without rendering as a button-shape.
  btn.style.flex = "0 0 auto";
  btn.style.padding = "4px 8px";
  btn.style.font = "15px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
  btn.style.color = "rgba(40, 55, 90, 0.65)";
  btn.style.background = "transparent";
  btn.style.border = "none";
  btn.style.borderRadius = "0";
  btn.style.cursor = "pointer";
  btn.style.userSelect = "none";
  btn.style.pointerEvents = "auto";
  btn.style.transition = "color 120ms ease-out";
  btn.addEventListener("mouseenter", () => {
    btn.style.color = "rgba(40, 55, 90, 0.95)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.color = "rgba(40, 55, 90, 0.65)";
  });
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

// ── chrome-1c: act-firing + receipt-sign animations ────────────────────
//
// Closes the felt thesis line "Motebit acts, I supervise" at sub-
// second granularity. Today the chrome shows session/control state;
// chrome-1c makes per-action firing visible: every signed
// `ToolInvocationReceipt` produces a tool-name-keyed Web-Animation
// pulse on the mark, plus a brief shimmer overlay signaling
// "this was signed." Same primitive (the mark), three composing
// triggers (tool fire + tool kind + receipt sign).
//
// Receipts bus is the trigger source — subscribing to
// `runtime.subscribeToolInvocations` fires once per signed receipt
// after a successful tool call. Failed acts and gate-denied acts
// don't sign (fail-closed), so the visual feedback is "this
// completed AND was audited" — not "this was attempted." Honest
// signal.
//
// Animation kinds map to the tool's semantic shape. `read_page` =
// outward ripple (the AI is reading outward across the page);
// `screenshot` = inward shutter pulse (the AI is capturing); click
// kinds = inward pulse (focused, decisive); type kinds = small
// flicker (rapid keystroke staccato); generic acts (web_search,
// recall_memories, etc.) = soft scale pulse (something happened,
// not visually distinguished).
//
// Web Animations API (`Element.animate`) is the chosen primitive:
// per-call instances clean up automatically on finish, no class-
// state management, no animation queue collisions when receipts
// fire fast (each call is independent). Pure-function `pickReceipt
// Animation` is testable under jsdom (no animation runtime
// required); `animateMarkForReceipt` is the call-site that the
// browser executes.

/**
 * Tool-name-keyed animation kind. Closed string-literal — adding a
 * new kind is additive and lands without breaking call sites.
 */
export type ReceiptAnimationKind = "read" | "look" | "click" | "type" | "generic";

/**
 * Pick the animation kind for a signed receipt. Pure function — the
 * keyframes/timing themselves are returned by `getReceiptAnimation`
 * separately so this stays trivially testable. Maps tool names to
 * intent-shaped animations:
 *
 *   read_page                              → "read"   (reading outward)
 *   computer({screenshot})                 → "look"   (capturing)
 *   click_element / focus_element /
 *     computer({click,double_click,...})   → "click"  (decisive)
 *   type_into / computer({type,key})       → "type"   (rapid keystroke)
 *   anything else                          → "generic"
 *
 * The `args` parameter is a JSON-serializable record matching the
 * receipt's args (or the activity-bus's args). When `tool_name ===
 * "computer"` and args includes a discriminating `action.kind`,
 * the helper differentiates into the right sub-animation. Without
 * args available (the receipt only carries `args_hash`), the
 * fallback for `computer` is "click" — most computer actions are
 * click-shaped acts (per the v1 action taxonomy).
 */
export function pickReceiptAnimation(
  toolName: string,
  args?: Record<string, unknown>,
): ReceiptAnimationKind {
  if (toolName === "read_page") return "read";
  if (toolName === "click_element" || toolName === "focus_element") return "click";
  if (toolName === "type_into") return "type";
  if (toolName === "computer") {
    // computer has a sub-discriminator — pick by action.kind when
    // args are available (activity bus). Fallback "click" when only
    // the receipt envelope is in scope (tool-name + args_hash).
    const action = (args?.["action"] as { kind?: string } | undefined) ?? null;
    const kind = action?.kind;
    if (kind === "screenshot") return "look";
    if (kind === "type" || kind === "key") return "type";
    if (kind === "navigate") return "read"; // navigation reveals a page — outward
    if (kind === "scroll") return "generic";
    return "click";
  }
  return "generic";
}

/**
 * Keyframes + timing for a `ReceiptAnimationKind`. Tuned for sub-
 * second feedback (200–600ms). Each kind has a distinct silhouette
 * the user can read peripherally — not a labeled icon, a felt
 * difference. Calm-software register: no flashing, no high-contrast
 * pulses, just shape-shifts of the existing mark.
 */
export function getReceiptAnimation(kind: ReceiptAnimationKind): {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
} {
  switch (kind) {
    case "read":
      // Outward ripple — the mark expands and fades a faint copy.
      // Reads as "spreading outward" / "looking out."
      return {
        keyframes: [
          { transform: "scale(1)", opacity: 1 },
          { transform: "scale(1.45)", opacity: 0.0, offset: 1 },
        ],
        options: { duration: 520, easing: "ease-out" },
      };
    case "look":
      // Camera shutter — quick scale-in then back, like an iris
      // closing/opening. Distinct from "click" (which scales but
      // recovers slower) by the snap timing.
      return {
        keyframes: [
          { transform: "scale(1)" },
          { transform: "scale(0.88)", offset: 0.5 },
          { transform: "scale(1)" },
        ],
        options: { duration: 320, easing: "ease-in-out" },
      };
    case "click":
      // Inward pulse — decisive, single beat. Same scale shape as
      // "look" but slower and softer; reads as "I pressed something"
      // rather than "I captured something."
      return {
        keyframes: [
          { transform: "scale(1)" },
          { transform: "scale(0.85)", offset: 0.5 },
          { transform: "scale(1)" },
        ],
        options: { duration: 280, easing: "ease-out" },
      };
    case "type":
      // Two-beat opacity flicker — rapid keystroke staccato.
      // Matches the felt rhythm of typing (multiple characters in
      // quick succession) without literally one-pulse-per-char,
      // which would be noisy.
      return {
        keyframes: [
          { opacity: 1 },
          { opacity: 0.7, offset: 0.25 },
          { opacity: 1, offset: 0.5 },
          { opacity: 0.7, offset: 0.75 },
          { opacity: 1 },
        ],
        options: { duration: 240, easing: "linear" },
      };
    case "generic":
      // Soft single beat — anything that isn't a known shape.
      // Quieter than "click" so it doesn't compete with named acts.
      return {
        keyframes: [
          { transform: "scale(1)" },
          { transform: "scale(1.08)", offset: 0.5 },
          { transform: "scale(1)" },
        ],
        options: { duration: 320, easing: "ease-out" },
      };
  }
}

/**
 * Fire the receipt-shimmer + tool-keyed pulse on the current mark
 * element. Called from the receipts-bus subscription when a signed
 * `ToolInvocationReceipt` arrives. Looks up the live mark via the
 * standard class selector (the strip is rebuilt on every state
 * transition; the mark element is always reachable by class).
 *
 * Animations stack on the same element — Web Animations API runs
 * each call independently and cleans up on finish. Two simultaneous
 * receipts (rare but possible on parallel tool dispatch) produce
 * two overlapping pulses; the visual register tolerates this fine.
 */
export function animateMarkForReceipt(
  mark: Element,
  toolName: string,
  args?: Record<string, unknown>,
): void {
  // Defensive guard for environments without Web Animations API
  // (older browsers, jsdom). The animation is purely cosmetic — a
  // missing API should never break anything else on the page.
  if (typeof (mark as HTMLElement).animate !== "function") return;
  const kind = pickReceiptAnimation(toolName, args);
  const { keyframes, options } = getReceiptAnimation(kind);
  (mark as HTMLElement).animate(keyframes, options);
}
