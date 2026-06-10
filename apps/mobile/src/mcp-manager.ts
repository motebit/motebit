/**
 * Mobile MCP manager — thin surface adapter over the shared
 * `@motebit/surface-kit` `McpManager`. The connect/disconnect/trust/
 * tool-registration lifecycle lives in the package (was forked here and in
 * spatial, identical bar storage + naming). Mobile injects its platform
 * adapters: AsyncStorage persistence and the node `InMemoryToolRegistry`.
 * Mobile is HTTP-only (no stdio — no node:child_process in React Native).
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { InMemoryToolRegistry } from "@motebit/tools";
import { McpManager } from "@motebit/surface-kit";
import type { KeyValueStore, ExternalToolHost } from "@motebit/surface-kit";
import type { MotebitRuntime } from "@motebit/runtime";
import { ASYNC_STORAGE_KEYS } from "./storage-keys";

export type { McpServerStatus } from "@motebit/surface-kit";

export interface McpManagerDeps {
  getRuntime: () => MotebitRuntime | null;
}

const asyncStorageAdapter: KeyValueStore = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
};

export class MobileMcpManager extends McpManager {
  constructor(deps: McpManagerDeps) {
    super({
      storage: asyncStorageAdapter,
      storageKey: ASYNC_STORAGE_KEYS.mcpServers,
      // MotebitRuntime structurally satisfies ExternalToolHost
      // (register/unregisterExternalTools).
      getToolHost: deps.getRuntime as () => ExternalToolHost | null,
      createToolRegistry: () => new InMemoryToolRegistry(),
    });
  }
}
