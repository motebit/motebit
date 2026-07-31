/**
 * Pure render for the mode row — the persistent current-truth line that
 * gives the banner's launch-time facts a live home (#480). The banner is
 * scrollback (history, correct as written); the mode row is chrome:
 * render(controlState), updated in place when `/model` switches.
 *
 * Register: one dim line, no box-drawing frame — the surface reads as an
 * application because its state is legible, not because it is boxed.
 *   ── claude-opus-4-6 · anthropic
 *   ── attached · coordinator pid 4211
 */

import { meta } from "./colors.js";

export interface ModeState {
  /** The model actually serving turns right now (runtime.currentModel). */
  model?: string;
  /** The provider the runtime was started against. */
  provider?: string;
  /** Attached mode: this terminal renders, the coordinator acts. */
  attachedPid?: number;
}

export function renderModeRow(state: ModeState): string {
  const parts: string[] = [];
  if (state.attachedPid != null) parts.push(`attached · coordinator pid ${state.attachedPid}`);
  if (state.model) parts.push(state.model);
  if (state.provider) parts.push(state.provider);
  return meta(`  ── ${parts.join(" · ")}`);
}
