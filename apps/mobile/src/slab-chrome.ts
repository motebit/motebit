/**
 * Mobile slab chrome dispatcher — `f(controlState × embodimentMode)`.
 *
 * Sibling of `apps/web/src/ui/slab-chrome.ts`. Same architectural
 * primitive (the matrix), surface-native render path. The web
 * dispatcher returns `HTMLElement | null`; the mobile dispatcher
 * returns a pure `SlabChromeCell | null` description that the
 * React Native renderer (`components/SlabChrome.tsx`) consumes.
 *
 * Splitting the matrix decision from the surface render has two
 * load-bearing effects:
 *
 *   - The dispatcher is testable in node without a React Native
 *     test runner. Mobile's vitest config excludes
 *     `src/components/**` (no `@testing-library/react-native`
 *     installed); the pure description function lives outside
 *     `components/` so the matrix-shape and cell-routing
 *     invariants get exhaustive coverage in unit tests.
 *
 *   - The doctrine reads literally — `chrome-as-state-render.md`
 *     § "Each register is an information shape, not a UI
 *     component." The mobile dispatcher embodies that line in
 *     code: the cell description IS the information shape; the
 *     surface render is downstream. The web dispatcher fuses
 *     them out of historical accident (DOM-event wiring lives at
 *     element creation); the mobile split surfaces what the web
 *     version implicitly does.
 *
 * Doctrine: [`chrome-as-state-render.md`] § "The principle" + §
 * "PR 1 scope." PR 2 (this commit) lifts the doctrine from
 * one-instance-deep (web alone) to a generalizable pattern by
 * shipping the second surface dispatcher against the same matrix.
 *
 * Scope, mirroring PR 1 on web: only the `* × virtual_browser`
 * column is meaningful. Other embodiment columns (`mind`,
 * `tool_result`, `shared_gaze`, `desktop_drive`, `peer_viewport`)
 * return null from the dispatcher — they're named in the matrix
 * but deferred. The mobile chat surface treats a null return as
 * "no chrome strip for this cell" and renders nothing.
 */

import type { ControlState, ControlHolder } from "@motebit/sdk";
import type { EmbodimentMode } from "@motebit/render-engine/spec";

/**
 * Slab chrome cell description — pure information shape per
 * `chrome-as-state-render.md` § "The four control-state registers
 * as information shapes." The shape is surface-agnostic; the React
 * Native renderer maps each variant to an `<AnimatedBubble>` /
 * `<TouchableOpacity>` subtree, while a future spatial renderer
 * could map the same variants to voice + ambient indicators
 * without rewriting the dispatcher.
 *
 *   - `motebit-narration` — `motebit × virtual_browser` register.
 *     Task-step narration is the content; URL chip tethers the
 *     narration to the page motebit is reading. Either or both
 *     fields may be null — the renderer's job to handle empty
 *     gracefully.
 *
 *   - `user-cobrowse` — `user × virtual_browser` register. The
 *     cobrowse-mode-entered cell. Mobile has no live screencast
 *     today; the renderer surfaces the URL as context + a
 *     "motebit waiting" hand-back chip so the cell composes
 *     correctly the moment a mobile cloud-browser session lands.
 *
 *   - `handoff-pending` — control transition requested. Carries
 *     the parties so the renderer can phrase the affordance
 *     correctly ("Grant" / "Deny" when current === "user").
 *
 *   - `paused` — held register. Carries `previousDriver` so
 *     `Resume` knows who to restore.
 */
export type SlabChromeCell =
  | {
      readonly kind: "motebit-narration";
      readonly narration: string | null;
      readonly currentUrl: string | null;
    }
  | { readonly kind: "user-cobrowse"; readonly currentUrl: string | null }
  | {
      readonly kind: "handoff-pending";
      readonly current: ControlHolder;
      readonly requesting: ControlHolder;
    }
  | { readonly kind: "paused"; readonly previousDriver: ControlHolder };

export interface SlabChromeOpts {
  /**
   * Current URL of the active browser session, when one exists.
   * Mirrors `RenderCoBrowseChromeOpts.currentUrl` on web. The
   * `motebit-narration` cell renders this as a chip; the
   * `user-cobrowse` cell renders this as context for the future
   * URL input. Null when no session is open.
   */
  readonly currentUrl?: string | null;
  /**
   * Validated task-step narration from the most recent
   * `task_step_narration` chunk. The runtime's
   * `validateTaskStepNarration` already corrected any wire-truth
   * contradictions before the chunk left the loop, so consumers
   * render the string verbatim. Whitespace-only or null collapses
   * the narration register — the cell description carries `null`
   * narration and the renderer recedes.
   */
  readonly taskStepNarration?: string | null;
}

/**
 * Pick the cell description for the current
 * `controlState × embodimentMode`. Returns null when the cell is
 * deferred (every embodiment column except `virtual_browser` in
 * PR 2) — the renderer mounts nothing in that case.
 *
 * The signature is the matrix on purpose, matching the web
 * dispatcher. A signature that took only `controlState` would
 * carry the cobrowser-default-as-only-register polarity error
 * that the doctrine corrects; taking only `embodimentMode` would
 * lose the four-register split inside `virtual_browser`.
 */
export function dispatchSlabChrome(
  state: ControlState,
  embodimentMode: EmbodimentMode,
  opts: SlabChromeOpts = {},
): SlabChromeCell | null {
  if (embodimentMode !== "virtual_browser") {
    // PR N — named in the matrix, deferred. The `motebit × *`
    // family cells render task-step narration as voice on AR
    // glasses, ambient indicators on mobile chrome, etc.; each
    // surface emerges its own way in its own PR. See
    // `chrome-as-state-render.md` § "Spatial-as-endgame
    // validation."
    return null;
  }

  switch (state.kind) {
    case "motebit": {
      const trimmed = opts.taskStepNarration?.trim();
      return {
        kind: "motebit-narration",
        narration: trimmed && trimmed.length > 0 ? trimmed : null,
        currentUrl: opts.currentUrl ?? null,
      };
    }
    case "user":
      return { kind: "user-cobrowse", currentUrl: opts.currentUrl ?? null };
    case "handoff_pending":
      return {
        kind: "handoff-pending",
        current: state.current,
        requesting: state.requesting,
      };
    case "paused":
      return { kind: "paused", previousDriver: state.previousDriver };
  }
}

/**
 * Reduce a URL to its host for chip rendering — same rule the web
 * dispatcher applies (`formatUrlHostForChip`). Strips the `www.`
 * prefix so the chip reads `apple.com` rather than `www.apple.com`.
 * Falls back to the scheme-stripped raw URL when `new URL()`
 * throws — defensive, never empty for the renderer to handle.
 *
 * Lives next to the dispatcher (rather than inline in the
 * component) because it's pure and shipped with the
 * cell-description contract; tests assert chip-text shape against
 * this helper without spinning up the React Native renderer.
 */
export function formatUrlHostForChip(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return url.replace(/^https?:\/\//i, "");
  }
}
