/**
 * Spatial slab chrome dispatcher — `f(controlState × embodimentMode)`,
 * third surface in the matrix-as-primitive cascade.
 *
 * Sibling of `apps/web/src/ui/slab-chrome.ts` (PR 1, shipped
 * 2026-05-12) and `apps/mobile/src/slab-chrome.ts` (PR 2, shipped
 * 2026-05-13). PR 3 (this file) lifts the doctrine from
 * two-instance-deep to three-instance-deep — and tests the
 * spatial-as-endgame validation: the registers translate to a
 * chromeless surface (voice + ambient + gaze) without semantic
 * loss.
 *
 * The dispatcher returns a pure `SlabChromeCell | null` description,
 * same shape as mobile's. A render adapter (`renderCellToActivity`
 * below) maps the cell to spatial-native effects:
 *
 *   - `motebit-narration` → HUD activity label = narration text;
 *     ambient URL chip = host. The creature voices the narration
 *     when the proactive surface allows (caller decides; the
 *     dispatcher only produces the information shape).
 *   - `user-cobrowse` → activity label = "watching"; creature's
 *     gaze withdraws (doctrine §"Spatial-as-endgame validation":
 *     "motebit's gaze withdraws, the user's gaze is the active
 *     gaze").
 *   - `handoff-pending` → activity label = "asks to drive"; the
 *     creature's mark accelerates from the 0.3 Hz Rayleigh-eigenmode
 *     baseline to ~0.67 Hz (same cadence the cobrowse chrome uses
 *     on web — substrate inheritance, not surface-specific tuning).
 *   - `paused` → activity label = "paused"; the held register —
 *     no breathing, doctrine line.
 *
 * Mobile has no live cobrowse session today and ships the
 * dispatcher anyway (so the matrix-as-primitive claim is structural,
 * not ceremonial); spatial does the same. The `motebit-narration`
 * cell is the only one that actually fires today; the user /
 * handoff / paused cells stand ready for the moment a spatial
 * cobrowse session lands.
 *
 * Why a local file rather than importing from
 * `apps/mobile/src/slab-chrome.ts`: per `feedback_endgame_not_mvp`
 * × "rule of three," two consumers with identical 12-line
 * dispatchers don't justify the abstraction extraction yet. The
 * drift gate (`scripts/check-slab-chrome-coverage.ts`, #94)
 * structurally enforces consistency across the duplicated
 * implementations — every surface in `SLAB_SURFACES` must name
 * every cell in source. When a fourth consumer arrives (desktop
 * chrome, perhaps), lift `SlabChromeCell` + `dispatchSlabChrome`
 * + `formatUrlHostForChip` to `@motebit/render-engine` (the
 * existing home of `EmbodimentMode`).
 *
 * Doctrine: [`chrome-as-state-render.md`] § "Spatial-as-endgame
 * validation" + § "PR 3 scope (spatial, this commit)";
 * [`spatial-as-endgame.md`] § "Default companion shape" (voice-
 * first, ambient when idle, gestures-on-objects).
 */

import type { ControlState, ControlHolder } from "@motebit/sdk";
import type { EmbodimentMode } from "@motebit/render-engine/spec";

/**
 * Slab chrome cell description — pure information shape per
 * `chrome-as-state-render.md` § "The four control-state registers
 * as information shapes." Identical to mobile's `SlabChromeCell`
 * by contract (same variants, same fields); ducktyped equality is
 * the doctrine's "register is an information shape" claim made
 * concrete across surfaces. The drift gate enforces the contract
 * structurally — both surfaces name every cell in source.
 *
 *   - `motebit-narration` — `motebit × virtual_browser` register.
 *     Task-step narration is the content; URL chip tethers the
 *     narration to the page motebit is reading. Either or both
 *     fields may be null — the renderer's job to handle empty
 *     gracefully.
 *
 *   - `user-cobrowse` — `user × virtual_browser` register. The
 *     cobrowse-mode-entered cell. Spatial has no live screencast
 *     today; the renderer surfaces the URL as ambient context +
 *     a creature-gaze-withdraws cue so the cell composes correctly
 *     the moment a spatial cobrowse session lands.
 *
 *   - `handoff-pending` — control transition requested. Carries
 *     the parties so the renderer can phrase the affordance
 *     correctly ("asks to drive" when `current === "user"`).
 *
 *   - `paused` — held register. Carries `previousDriver` so a
 *     future resume gesture knows who to restore.
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
   * `motebit-narration` cell renders this as an ambient label; the
   * `user-cobrowse` cell renders this as context for a future
   * spatial URL surface. Null when no session is open.
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
 * PR 3) — the renderer mounts nothing in that case.
 *
 * The signature is the matrix on purpose, matching the web and
 * mobile dispatchers. A signature that took only `controlState`
 * would carry the cobrowser-default-as-only-register polarity
 * error the doctrine corrects; taking only `embodimentMode` would
 * lose the four-register split inside `virtual_browser`.
 */
export function dispatchSlabChrome(
  state: ControlState,
  embodimentMode: EmbodimentMode,
  opts: SlabChromeOpts = {},
): SlabChromeCell | null {
  if (embodimentMode !== "virtual_browser") {
    // PR N — named in the matrix, deferred. The other embodiment
    // columns (`"mind"`, `"tool_result"`, `"shared_gaze"`,
    // `"desktop_drive"`, `"peer_viewport"`) render task-step
    // narration as voice + ambient indicators on AR glasses;
    // their cell-shape and render-adapter land in their own PRs.
    // See `chrome-as-state-render.md` § "Spatial-as-endgame
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
 * Reduce a URL to its host for ambient labeling — same rule the
 * web and mobile dispatchers apply (`formatUrlHostForChip`).
 * Strips the `www.` prefix so the ambient label reads `apple.com`
 * rather than `www.apple.com`. Falls back to the scheme-stripped
 * raw URL when `new URL()` throws — defensive, never empty for
 * the renderer to handle.
 */
export function formatUrlHostForChip(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return url.replace(/^https?:\/\//i, "");
  }
}

/**
 * Spatial render adapter — map a `SlabChromeCell` to the activity
 * label the HUD displays. The HUD is the spatial chrome's render
 * (per `apps/spatial/CLAUDE.md` Rule 1: "src/hud.ts is the
 * non-negotiable safety floor — read-only essentials (connection
 * state, balance, **active task**)"); the activity label is
 * exactly the active-task field, and the slab chrome's cells map
 * directly into it. Voice cues + creature-gaze updates would
 * compose on top of this same cell — the activity label is the
 * minimum semantic render that demonstrates the doctrine.
 *
 * Pure function — caller decides whether to push the label into
 * `ActivityTracker.set()` or another sink. Returns the label
 * string OR `null` to clear the activity register (the cell
 * description's empty state).
 *
 * The empty-register collapse for `motebit-narration` (no
 * narration AND no URL) returns `null` — the activity register
 * recedes to whatever was set before, matching the calm-default
 * doctrine line. The non-empty cells always return a string —
 * spatial's chrome is always SOMEHOW visible when the matrix
 * is in an active cell, just at different ambient registers.
 */
export function renderCellToActivity(cell: SlabChromeCell | null): string | null {
  if (cell === null) return null;
  switch (cell.kind) {
    case "motebit-narration": {
      if (cell.narration !== null && cell.currentUrl !== null) {
        return `${cell.narration} · ${formatUrlHostForChip(cell.currentUrl)}`;
      }
      if (cell.narration !== null) return cell.narration;
      if (cell.currentUrl !== null) return formatUrlHostForChip(cell.currentUrl);
      return null;
    }
    case "user-cobrowse": {
      return cell.currentUrl !== null
        ? `watching · ${formatUrlHostForChip(cell.currentUrl)}`
        : "watching";
    }
    case "handoff-pending":
      // Doctrine §"Spatial-as-endgame validation": the spatial mark
      // pulses faster + spatial audio cue. The activity label is the
      // textual register; the visual/audio register lands in the
      // future creature-pulse adapter (out of scope for PR 3).
      return "asks to drive";
    case "paused":
      return "paused";
  }
}
