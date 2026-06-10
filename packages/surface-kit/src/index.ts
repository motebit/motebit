/**
 * @motebit/surface-kit — surface-agnostic controllers shared across flat
 * surfaces (mobile, spatial, web, desktop). State + actions live here; each
 * surface injects its platform adapters (storage, runtime, tool-registry
 * variant) through narrow ports and keeps a thin wiring shim. This is the
 * extraction home for logic that was previously forked per surface.
 *
 * First controller: the HTTP MCP manager (was MobileMcpManager /
 * SpatialMcpManager, identical state machines bar storage + naming).
 */

export { McpManager } from "./mcp-manager.js";
export type {
  KeyValueStore,
  ExternalToolHost,
  McpServerStatus,
  McpManagerCoreDeps,
} from "./mcp-manager.js";
