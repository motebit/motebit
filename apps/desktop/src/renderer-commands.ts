/**
 * Renderer commands — thin functional wrappers around the ThreeJS render
 * adapter, extracted from the DesktopApp god class.
 *
 * Every function here forwards directly to a `ThreeJSAdapter` method with
 * minimal additional logic. The functions take the adapter as their first
 * parameter (mirrors `memory-commands.ts`); the DesktopApp keeps a single
 * `ThreeJSAdapter` instance and delegates its public render-related methods
 * to these functions one-line at a time. Public DesktopApp API unchanged.
 *
 * Why pure functions instead of a class: there's no NEW instance state.
 * The renderer reference IS the state, and the DesktopApp already owns it.
 * Wrapping it in another class would just be bookkeeping.
 */

import type { ThreeJSAdapter } from "@motebit/render-engine";
import type { InteriorColor } from "@motebit/runtime";
import type { MotebitRuntime } from "@motebit/runtime";
import { COLOR_PRESETS } from "./color-presets.js";

/**
 * Initialize the renderer against a canvas (or canvas-like target). Sets
 * the light environment + enables orbit controls so the creature is
 * visible from the user's perspective on first paint, before the runtime
 * boots and starts driving the cues itself.
 */
export async function initRenderer(renderer: ThreeJSAdapter, canvas: unknown): Promise<void> {
  await renderer.init(canvas);
  renderer.setLightEnvironment();
  renderer.enableOrbitControls();
}

/** Resize the render surface (window resize handler delegate). */
export function resizeRenderer(renderer: ThreeJSAdapter, width: number, height: number): void {
  renderer.resize(width, height);
}

/**
 * Render one frame. If the runtime is up it owns the frame loop (because
 * it's the source of cues from the state vector); if not yet initialized,
 * fall back to a default-cue render so the creature is visible during
 * boot/onboarding.
 */
export function renderFrame(
  renderer: ThreeJSAdapter,
  runtime: MotebitRuntime | null,
  deltaTime: number,
  time: number,
): void {
  if (runtime) {
    runtime.renderFrame(deltaTime, time);
  } else {
    renderer.render({
      cues: {
        hover_distance: 0.4,
        drift_amplitude: 0.02,
        glow_intensity: 0.3,
        eye_dilation: 0.3,
        smile_curvature: 0,
        speaking_activity: 0,
      },
      delta_time: deltaTime,
      time,
    });
  }
}

/**
 * Apply a named color preset (moonlight, amber, rose, …). Silently no-op
 * if the preset name is unknown — the call site is the settings UI which
 * could in principle send a stale name.
 */
export function setInteriorColor(renderer: ThreeJSAdapter, presetName: string): void {
  const preset = COLOR_PRESETS[presetName];
  if (!preset) return;
  renderer.setInteriorColor(preset);
}

/**
 * Apply an arbitrary interior color directly. Used by the custom color
 * picker for live preview (no preset lookup needed because the picker
 * computes the color itself).
 */
export function setInteriorColorDirect(renderer: ThreeJSAdapter, color: InteriorColor): void {
  renderer.setInteriorColor(color);
}

/** Switch the scene to the dark environment preset. */
export function setDarkEnvironment(renderer: ThreeJSAdapter): void {
  renderer.setDarkEnvironment();
}

/** Switch the scene to the light environment preset. */
export function setLightEnvironment(renderer: ThreeJSAdapter): void {
  renderer.setLightEnvironment();
}

/**
 * Push audio energy into the renderer for reactive visuals (the creature
 * breathes / shimmers in response to ambient sound). Pass `null` to clear
 * the reactive state when the mic is disabled.
 */
export function setAudioReactivity(
  renderer: ThreeJSAdapter,
  energy: { rms: number; low: number; mid: number; high: number } | null,
): void {
  renderer.setAudioReactivity(energy);
}
