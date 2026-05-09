// === Runtime Session State (Prompt-1) ===
//
// Snapshot of the runtime state that the AI's reasoning needs to
// know about THIS turn — injected into the system prompt's dynamic
// suffix as a `[Session]` block. The shape exists because of a
// recurring hallucination pattern witnessed across the co-browse
// arc: the AI claims runtime state ("browser is already open",
// "there's a sensitivity hold", "I haven't seen the pixels") from
// memory rather than from a typed signal. The fix is to surface
// the truth in the prompt so the AI can read it instead of
// inferring.
//
// Same shape as the existing `[Body]` and `[State]` blocks — they
// expose creature mood and body cues. `[Session]` exposes the
// runtime's session-level state: cloud-browser status, control
// holder, effective sensitivity tier, pixel-passthrough consent.
//
// Doctrine: `motebit-computer.md` §"Mode contract" + the
// PERCEPTION_DOCTRINE block in `packages/ai-core/src/prompt.ts`
// (perception integrity — runtime state arrives as typed signal,
// never as inference).

import type { ControlState } from "./index.js";
import type { SensitivityLevel } from "./index.js";
import type { PixelConsentState } from "./pixel-consent.js";

/**
 * Cloud-browser session info — populated by the surface that owns
 * the session lifecycle (web's `registerWebComputerTool`).
 * Surfaces without a virtual_browser embodiment (desktop_drive,
 * sandboxed) report `status: "closed"` always — those surfaces
 * don't expose `computer({navigate})` at all, so the AI shouldn't
 * be reasoning about a browser session there.
 */
export interface BrowserSessionInfo {
  /**
   * Whether motebit currently has an active virtual_browser
   * session. `closed` means no live screencast, no Chromium
   * process; the AI must call a tool to open one before
   * navigating / reading / screenshotting.
   */
  readonly status: "closed" | "open";
  /**
   * URL of the page motebit is currently looking at. Present
   * only when `status === "open"` AND the surface is tracking
   * navigation events. May be omitted (`undefined`) if the
   * surface hasn't wired URL tracking yet — absent means
   * "we don't know," not "no URL."
   */
  readonly url?: string;
  /**
   * Co-browse control state — who's driving. Present when
   * `status === "open"` AND the session has a co-browse machine
   * (web). Absent on surfaces without co-browse (desktop_drive
   * v1).
   */
  readonly control?: ControlState;
}

/**
 * Full runtime session-state snapshot — composed by the runtime
 * from per-surface browser info plus its own sensitivity and
 * consent fields. Threaded through `MotebitLoopOptions` →
 * `ContextPack.sessionState` → the system prompt's dynamic
 * suffix as a `[Session]` block.
 *
 * v1 surface scope: web (cloud-browser embodiment). Desktop and
 * mobile surfaces will populate the same shape with their own
 * embodiment's state when the prompt-1 pattern lands there.
 */
export interface SessionStateSnapshot {
  /** Cloud-browser session info from the surface. */
  readonly browser: BrowserSessionInfo;
  /** Effective session sensitivity tier — runtime-owned, applies to all AI calls. */
  readonly sensitivity: SensitivityLevel;
  /** Per-session pixel-passthrough consent — runtime-owned. */
  readonly pixelConsent: PixelConsentState;
}
