/**
 * Tool-policy registry — one row per tool, one source of truth for how
 * a tool call projects onto the slab.
 *
 * Per motebit-computer.md, every slab item carries three orthogonal
 * classifications:
 *
 *   - `kind` — fine-grained content shape. Drives which per-kind
 *     renderer mounts (stream, fetch, shell, memory, delegation, …).
 *   - `mode` — coarse-grained embodiment. Drives governance gating
 *     and the perceptual framing (mind, tool_result, virtual_browser,
 *     shared_gaze, desktop_drive, peer_viewport).
 *   - `endState` — what happens when active work completes:
 *     `dissolve` (ephemeral plumbing), `rest` (working material, stays
 *     on the slab), `detach` (graduate into the scene as an artifact).
 *
 * Before this registry, these three classifications lived in separate
 * Sets and switch statements; adding a tool meant editing three places
 * and risking drift between them. Now one row declares the full
 * policy, and callers project onto whichever axis they need.
 *
 * Missing tools fall back to `DEFAULT_POLICY` (generic tool_call,
 * tool_result mode, dissolve on completion) — the safe floor.
 */

import type { SlabItemKind, EmbodimentMode } from "@motebit/render-engine";

/** Lifecycle end-state for a tool's slab item when active work finishes. */
export type ToolEndState = "dissolve" | "rest" | "detach";

export interface ToolPolicy {
  readonly kind: SlabItemKind;
  readonly mode: EmbodimentMode;
  readonly endState: ToolEndState;
}

const DEFAULT_POLICY: ToolPolicy = {
  kind: "tool_call",
  mode: "tool_result",
  endState: "dissolve",
};

// One row per tool. Order groups by mode for readability; lookup is
// a Map so declaration order doesn't matter.
const TOOL_POLICIES: ReadonlyMap<string, ToolPolicy> = new Map<string, ToolPolicy>([
  // virtual_browser — the motebit's eye on an isolated page. Renders
  // as a reader-view iframe on the slab. Rests as an open "tab" until
  // the user dismisses it.
  ["read_url", { kind: "fetch", mode: "virtual_browser", endState: "rest" }],
  ["fetch_url", { kind: "fetch", mode: "virtual_browser", endState: "rest" }],
  // computer — Motebit's screenshot/click/type primitive. Renders on
  // the slab as a fetch-kind card so screenshot observations land in
  // the same reader/image-frame surface the user is already watching
  // (kind=fetch picks up the image-srcdoc renderer when the result
  // shape is `{ kind: "screenshot", bytes_base64, ... }`).
  //
  // Mode is `tool_result` here, **not** `virtual_browser` /
  // `desktop_drive`, even though the doctrinal embodiment differs by
  // surface (cloud Chromium → virtual_browser; user's real OS →
  // desktop_drive). The tool-policy registry is name-keyed and
  // surface-blind, so a single mode would mis-tag one surface — and
  // the sensitivity-routing implications are real: virtual_browser
  // is `tier-bounded-by-source`, desktop_drive is `all-tiers`. Safe-
  // floor `tool_result` (tier-bounded-by-tool) lets the OCR
  // classifier on every screenshot do the load-bearing redaction;
  // the per-surface mode upgrade is deferred until the runtime
  // gains a per-item dispatcher hint (motebit-computer.md §"Mode
  // contract" already names this graduation: "the runtime can
  // override per item").
  //
  // GRADUATION TRIGGER: when the slab-item open path threads the
  // dispatcher's mode forward (or a per-invocation mode hint lands
  // alongside `chunk.context` in the streaming pipeline), promote
  // this row to surface-aware: cloud browser screenshots stamp
  // `virtual_browser` (tier-bounded-by-source) and desktop computer
  // observations stamp `desktop_drive` (all-tiers). Until then,
  // this is a known temporary floor — sensitivity routing is honest
  // (tier-bounded-by-tool composes), but the embodiment-mode
  // contract under-claims the cloud-browser case.
  ["computer", { kind: "fetch", mode: "tool_result", endState: "rest" }],

  // tool_result — search is not a browser viewport, but the results
  // are still working material worth resting (user may re-read).
  ["web_search", { kind: "tool_call", mode: "tool_result", endState: "rest" }],

  // tool_result — shell / terminal. Output rests as a transcript the
  // user may consult. Upgrades to desktop_drive in future when the
  // motebit acts on the user's real terminal.
  ["shell_exec", { kind: "shell", mode: "tool_result", endState: "rest" }],
  ["bash", { kind: "shell", mode: "tool_result", endState: "rest" }],
  ["shell", { kind: "shell", mode: "tool_result", endState: "rest" }],
  ["exec", { kind: "shell", mode: "tool_result", endState: "rest" }],
  ["run_command", { kind: "shell", mode: "tool_result", endState: "rest" }],

  // tool_result — file read. The motebit's eye on a local file.
  ["read_file", { kind: "tool_call", mode: "tool_result", endState: "rest" }],

  // mind — memory surfacing is internal reorganization made visible.
  // Rests as referenceable nodes while the turn works with them.
  ["recall_memories", { kind: "memory", mode: "mind", endState: "rest" }],
  ["search_memories", { kind: "memory", mode: "mind", endState: "rest" }],
]);

/**
 * Resolve the slab-projection policy for a tool by name. Unknown tools
 * get the default (generic card, tool_result mode, dissolve on done).
 */
export function toolPolicy(name: string): ToolPolicy {
  return TOOL_POLICIES.get(name) ?? DEFAULT_POLICY;
}
