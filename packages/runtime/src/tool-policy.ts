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
  // Slice 2h — `read_page` is the first ax-tier tool. Same family as
  // read_url (motebit's eye on a page) but operates against an open
  // browser session and returns DOM-derived structured text rather
  // than fetching a fresh URL. Renders as a `fetch` slab item, rests
  // so the user can refer back to the extraction.
  ["read_page", { kind: "fetch", mode: "virtual_browser", endState: "rest" }],
  // computer — Motebit's screenshot/click/type primitive. Renders on
  // the slab as a fetch-kind card so screenshot observations land in
  // the same reader/image-frame surface the user is already watching
  // (kind=fetch picks up the image-srcdoc renderer when the result
  // shape is `{ kind: "screenshot", bytes_base64, ... }`).
  //
  // Mode here is the **safe floor** (`tool_result`) for unknown
  // registrations only. The cloud-browser path (apps/web) and the
  // desktop OS-drive path (apps/desktop) BOTH register this tool with
  // an explicit `embodimentMode` on the ToolDefinition
  // (`virtual_browser` and `desktop_drive` respectively); ai-core
  // carries that mode forward on the `tool_status` chunk; the
  // runtime's slab-projection picks `chunk.mode` over the floor (see
  // `motebit-runtime.ts` projectSlabForTurn). So the floor here only
  // fires when a future caller registers the `computer` tool name
  // through some path that doesn't declare an embodimentMode — at
  // which point the safe `tool_result` (tier-bounded-by-tool) keeps
  // the OCR classifier on every screenshot doing the load-bearing
  // redaction without over-claiming the embodiment contract.
  //
  // Doctrine: motebit-computer.md §"v1 implementation status —
  // Deferred to v1.5+: per-dispatcher mode stamping" — landed as
  // v1.1 of the virtual_browser arc. The drift gate
  // `check-computer-dispatcher-modes` enforces that every site
  // registering the `computer` tool declares a mode (or marks
  // itself as the explicit fallback path).
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

  // peer_viewport — delegation to a federated peer motebit. The
  // streaming pipeline opens the slab item explicitly on
  // `delegation_start` (motebit-runtime.ts L1518), so this row is
  // the safe-floor for any future caller that reaches the tool
  // through the registry alone (e.g. an MCP-imported delegate_to_agent
  // surfaced at the same name). End-state is `detach`: a returned
  // signed receipt is durable proof — pinches to a receipt artifact
  // in the scene rather than dissolving. Doctrine:
  // motebit-computer.md §"peer_viewport" — "the receipt is the
  // proof." Sensitivity is `tier-bounded-by-source` (the source
  // being the peer-receipt itself) which composes correctly through
  // `getEffectiveSessionSensitivity`.
  ["delegate_to_agent", { kind: "delegation", mode: "peer_viewport", endState: "detach" }],
]);

/**
 * Resolve the slab-projection policy for a tool by name. Unknown tools
 * get the default (generic card, tool_result mode, dissolve on done).
 */
export function toolPolicy(name: string): ToolPolicy {
  return TOOL_POLICIES.get(name) ?? DEFAULT_POLICY;
}
