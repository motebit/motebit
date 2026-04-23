/**
 * Tool cost-tier taxonomy.
 *
 * Every `ToolDefinition` declares one of these modes. The motebit's
 * tool registry sorts the list by tier, so when the model scans its
 * available tools it sees structured / cheap options first and the
 * pixel-level fallback last. Cost tiers (hybrid engine doctrine):
 *
 *   - **api** — structured, semantically rich, KB round-trip.
 *     MCP tools, web_search, read_url, memory ops, file I/O, goals.
 *     The default for any tool that moves text or structured data.
 *
 *   - **ax** — accessibility-tree extraction: DOM, AX API, reader
 *     shapes. Structured but lossy (visual context discarded). Used
 *     when the target surface exposes a hierarchy the motebit can
 *     read without screen capture. Today: the web Reader / virtual
 *     browser path. Tomorrow: macOS AXUIElement traversal for native
 *     apps.
 *
 *   - **pixels** — screen capture + synthetic input. Works on every
 *     app (legacy software, games, custom UI) but costs ~30k tokens
 *     per observation even downscaled and crosses a whole-screen
 *     privacy surface. The universal fallback — reserved for
 *     surfaces that have no API and no accessibility tree.
 *
 * `ToolMode` is a closed string-literal union, following the `SuiteId`
 * registry pattern. Adding a tier is additive (new entry + new
 * priority arm in the registry sort). Removing one is a wire-format
 * break — third parties declare `mode` in their tool definitions and
 * that claim is stable.
 */

export type ToolMode = "api" | "ax" | "pixels";

/**
 * All declared modes in priority order (cheapest first). Consumers
 * that need to rank or enumerate tool modes iterate this array rather
 * than hard-coding the order.
 */
export const TOOL_MODES = ["api", "ax", "pixels"] as const;

/**
 * Priority index of a declared mode (0 = cheapest). Tools without a
 * `mode` declaration sort to the end (`TOOL_MODES.length`) — they are
 * neither rejected nor prioritized, just deprioritized relative to
 * explicit tiers.
 */
export function toolModePriority(mode: ToolMode | undefined): number {
  if (mode === undefined) return TOOL_MODES.length;
  const idx = TOOL_MODES.indexOf(mode);
  return idx === -1 ? TOOL_MODES.length : idx;
}
