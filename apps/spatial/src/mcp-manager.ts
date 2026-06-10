/**
 * Spatial MCP manager — thin surface adapter over the shared
 * `@motebit/surface-kit` `McpManager`. The connect/disconnect/trust/
 * tool-registration lifecycle lives in the package (was forked here and in
 * mobile, identical bar storage + naming). Spatial injects its platform
 * adapters: localStorage persistence and the browser-safe
 * `InMemoryToolRegistry`. Browser-only — HTTP transport only (no stdio; the
 * browser has no node:child_process — use the desktop or CLI app).
 */

import { InMemoryToolRegistry } from "@motebit/tools/web-safe";
import { McpManager } from "@motebit/surface-kit";
import type { KeyValueStore, ExternalToolHost } from "@motebit/surface-kit";
import type { MotebitRuntime } from "@motebit/runtime";

export type { McpServerStatus } from "@motebit/surface-kit";

export interface SpatialMcpManagerDeps {
  getRuntime: () => MotebitRuntime | null;
}

const localStorageAdapter: KeyValueStore = {
  getItem: (key) => Promise.resolve(localStorage.getItem(key)),
  setItem: (key, value) => {
    localStorage.setItem(key, value);
    return Promise.resolve();
  },
};

export class SpatialMcpManager extends McpManager {
  constructor(deps: SpatialMcpManagerDeps) {
    super({
      storage: localStorageAdapter,
      storageKey: "motebit:mcp_servers",
      // MotebitRuntime structurally satisfies ExternalToolHost
      // (register/unregisterExternalTools).
      getToolHost: deps.getRuntime as () => ExternalToolHost | null,
      createToolRegistry: () => new InMemoryToolRegistry(),
    });
  }
}
