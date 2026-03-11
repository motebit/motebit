// --- Provider creation, tool registry, runtime bootstrap ---

import * as fs from "node:fs";
import * as path from "node:path";
import { MotebitRuntime, NullRenderer } from "@motebit/runtime";
import { embedText } from "@motebit/memory-graph";
import type { StorageAdapters } from "@motebit/runtime";
import { CloudProvider, OllamaProvider } from "@motebit/ai-core";
import type { StreamingProvider, MotebitPersonalityConfig } from "@motebit/ai-core";
import { openMotebitDatabase, type MotebitDatabase } from "@motebit/persistence";
import {
  HttpEventStoreAdapter,
  EncryptedEventStoreAdapter,
  ConversationSyncEngine,
  HttpConversationSyncAdapter,
} from "@motebit/sync-engine";
import type { ConversationSyncStoreAdapter } from "@motebit/sync-engine";
import type { SyncConversation, SyncConversationMessage } from "@motebit/sdk";
import { EventType } from "@motebit/sdk";
import {
  InMemoryToolRegistry,
  readFileDefinition,
  createReadFileHandler,
  writeFileDefinition,
  createWriteFileHandler,
  shellExecDefinition,
  createShellExecHandler,
  webSearchDefinition,
  createWebSearchHandler,
  readUrlDefinition,
  createReadUrlHandler,
  recallMemoriesDefinition,
  createRecallMemoriesHandler,
  listEventsDefinition,
  createListEventsHandler,
  BraveSearchProvider,
  DuckDuckGoSearchProvider,
  FallbackSearchProvider,
} from "@motebit/tools";
import type { SearchProvider } from "@motebit/tools";
import type { McpServerConfig } from "@motebit/mcp-client";
import type { CliConfig } from "./args.js";
import { CONFIG_DIR } from "./config.js";

export function getApiKey(): string {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (key == null || key === "") {
    console.error(
      "Error: ANTHROPIC_API_KEY environment variable is not set.\n" +
        "Set it with: export ANTHROPIC_API_KEY=sk-ant-...",
    );
    process.exit(1);
  }
  return key;
}

export function getDbPath(override?: string): string {
  if (override != null && override !== "") return override;
  const envPath = process.env["MOTEBIT_DB_PATH"];
  if (envPath != null && envPath !== "") return envPath;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  return path.join(CONFIG_DIR, "motebit.db");
}

export function createProvider(
  config: CliConfig,
  personalityConfig?: MotebitPersonalityConfig,
): StreamingProvider {
  const temperature = personalityConfig?.temperature ?? 0.7;

  if (config.provider === "ollama") {
    return new OllamaProvider({
      model: config.model,
      max_tokens: 1024,
      temperature,
      personalityConfig,
    });
  }

  const apiKey = getApiKey();
  return new CloudProvider({
    provider: "anthropic",
    api_key: apiKey,
    model: config.model,
    max_tokens: 1024,
    temperature,
    personalityConfig,
  });
}

export function buildToolRegistry(
  config: CliConfig,
  runtimeRef: { current: MotebitRuntime | null },
  motebitId: string,
): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();

  // Always available (R0/R1): read-only file access, web search, web read
  registry.register(readFileDefinition, createReadFileHandler(config.allowedPaths));

  // Search provider chain: Brave (if API key configured) -> DuckDuckGo fallback
  const braveKey = process.env["BRAVE_SEARCH_API_KEY"];
  let searchProvider: SearchProvider | undefined;
  if (braveKey != null && braveKey !== "") {
    searchProvider = new FallbackSearchProvider([
      new BraveSearchProvider(braveKey),
      new DuckDuckGoSearchProvider(),
    ]);
  }
  registry.register(webSearchDefinition, createWebSearchHandler(searchProvider));
  registry.register(readUrlDefinition, createReadUrlHandler());

  // Deferred handlers for memory/events (need runtime, which needs registry)
  const memorySearchFn = async (query: string, limit: number) => {
    if (!runtimeRef.current) return [];
    const queryEmbedding = await embedText(query);
    const nodes = await runtimeRef.current.memory.retrieve(queryEmbedding, { limit });
    return nodes.map((n) => ({ content: n.content, confidence: n.confidence }));
  };
  const eventQueryFn = async (limit: number, eventType?: string) => {
    if (!runtimeRef.current) return [];
    const filter: {
      motebit_id: string;
      limit: number;
      event_types?: import("@motebit/sdk").EventType[];
    } = {
      motebit_id: motebitId,
      limit,
    };
    if (eventType != null && eventType !== "") {
      filter.event_types = [eventType as EventType];
    }
    const events = await runtimeRef.current.events.query(filter);
    return events.map((e) => ({
      event_type: e.event_type,
      timestamp: e.timestamp,
      payload: e.payload,
    }));
  };

  registry.register(recallMemoriesDefinition, createRecallMemoriesHandler(memorySearchFn));
  registry.register(listEventsDefinition, createListEventsHandler(eventQueryFn));

  // Operator-only (R2+): write files, execute shell commands
  if (config.operator) {
    registry.register(writeFileDefinition, createWriteFileHandler(config.allowedPaths));
    registry.register(shellExecDefinition, createShellExecHandler());
  }

  return registry;
}

/**
 * Bridges SqliteConversationStore (camelCase) to ConversationSyncStoreAdapter (snake_case).
 */
export class SqliteConversationSyncStoreAdapter implements ConversationSyncStoreAdapter {
  constructor(private store: MotebitDatabase["conversationStore"]) {}

  getConversationsSince(motebitId: string, since: number): SyncConversation[] {
    return this.store.getConversationsSince(motebitId, since).map((c) => ({
      conversation_id: c.conversationId,
      motebit_id: c.motebitId,
      started_at: c.startedAt,
      last_active_at: c.lastActiveAt,
      title: c.title,
      summary: c.summary,
      message_count: c.messageCount,
    }));
  }

  getMessagesSince(conversationId: string, since: number): SyncConversationMessage[] {
    return this.store.getMessagesSince(conversationId, since).map((m) => ({
      message_id: m.messageId,
      conversation_id: m.conversationId,
      motebit_id: m.motebitId,
      role: m.role,
      content: m.content,
      tool_calls: m.toolCalls,
      tool_call_id: m.toolCallId,
      created_at: m.createdAt,
      token_estimate: m.tokenEstimate,
    }));
  }

  upsertConversation(conv: SyncConversation): void {
    this.store.upsertConversation({
      conversationId: conv.conversation_id,
      motebitId: conv.motebit_id,
      startedAt: conv.started_at,
      lastActiveAt: conv.last_active_at,
      title: conv.title,
      summary: conv.summary,
      messageCount: conv.message_count,
    });
  }

  upsertMessage(msg: SyncConversationMessage): void {
    this.store.upsertMessage({
      messageId: msg.message_id,
      conversationId: msg.conversation_id,
      motebitId: msg.motebit_id,
      role: msg.role,
      content: msg.content,
      toolCalls: msg.tool_calls,
      toolCallId: msg.tool_call_id,
      createdAt: msg.created_at,
      tokenEstimate: msg.token_estimate,
    });
  }
}

export async function createRuntime(
  config: CliConfig,
  motebitId: string,
  toolRegistry: InMemoryToolRegistry,
  mcpServers: McpServerConfig[],
  personalityConfig?: MotebitPersonalityConfig,
  encKey?: Uint8Array,
): Promise<{ runtime: MotebitRuntime; moteDb: MotebitDatabase }> {
  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);
  const provider = createProvider(config, personalityConfig);

  console.log(`Data: ${dbPath}`);
  console.log(`Provider: ${config.provider} (${provider.model})`);
  if (config.operator) {
    console.log("Operator mode: enabled");
  }

  const storage: StorageAdapters = {
    eventStore: moteDb.eventStore,
    memoryStorage: moteDb.memoryStorage,
    identityStorage: moteDb.identityStorage,
    auditLog: moteDb.auditLog,
    stateSnapshot: moteDb.stateSnapshot,
    toolAuditSink: moteDb.toolAuditSink,
    conversationStore: moteDb.conversationStore,
  };

  const runtime = new MotebitRuntime(
    {
      motebitId,
      mcpServers,
      policy: {
        operatorMode: config.operator,
        pathAllowList: config.allowedPaths,
      },
    },
    {
      storage,
      renderer: new NullRenderer(),
      ai: provider,
      tools: toolRegistry,
    },
  );

  // Wire sync if configured
  const syncUrl = config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"];
  const syncToken = config.syncToken ?? process.env["MOTEBIT_SYNC_TOKEN"];

  if (syncUrl != null && syncUrl !== "") {
    const httpAdapter = new HttpEventStoreAdapter({
      baseUrl: syncUrl,
      motebitId,
      authToken: syncToken,
    });
    // Wrap with encryption if key available (zero-knowledge relay)
    const remoteStore = encKey
      ? new EncryptedEventStoreAdapter({ inner: httpAdapter, key: encKey })
      : httpAdapter;
    runtime.connectSync(remoteStore);
    console.log(`Sync: ${syncUrl}${encKey ? " (encrypted)" : ""}`);
  } else {
    console.log("Sync: disabled (set MOTEBIT_SYNC_URL to enable)");
  }

  return { runtime, moteDb };
}

// Re-export types/values that other modules need
export {
  MotebitRuntime,
  NullRenderer,
  InMemoryToolRegistry,
  HttpEventStoreAdapter,
  EncryptedEventStoreAdapter,
  ConversationSyncEngine,
  HttpConversationSyncAdapter,
  openMotebitDatabase,
};
export type { StorageAdapters, MotebitDatabase, StreamingProvider, McpServerConfig };
