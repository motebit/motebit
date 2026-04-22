import { InMemoryToolRegistry } from "../index.js";
import type { SearchProvider } from "../search-provider.js";

export { webSearchDefinition, createWebSearchHandler } from "./web-search.js";
export { readUrlDefinition, createReadUrlHandler } from "./read-url.js";
export { readFileDefinition, createReadFileHandler } from "./read-file.js";
export { writeFileDefinition, createWriteFileHandler } from "./write-file.js";
export type { WriteFileConfig } from "./write-file.js";
export { shellExecDefinition, createShellExecHandler, DESTRUCTIVE_PATTERNS } from "./shell-exec.js";
export type { ShellExecConfig } from "./shell-exec.js";
export { undoWriteDefinition, createUndoWriteHandler } from "./undo-write.js";
export { isPathAllowed, isDirectoryAllowed } from "./path-sandbox.js";
export { recallMemoriesDefinition, createRecallMemoriesHandler } from "./recall-memories.js";
export {
  rewriteMemoryDefinition,
  createRewriteMemoryHandler,
  type RewriteMemoryDeps,
} from "./rewrite-memory.js";
export {
  searchConversationsDefinition,
  createSearchConversationsHandler,
  type ConversationSearchHit,
} from "./search-conversations.js";
export { currentTimeDefinition, createCurrentTimeHandler } from "./current-time.js";
export {
  recallSelfDefinition,
  createRecallSelfHandler,
  type RecallSelfHit,
} from "./recall-self.js";
export { listEventsDefinition, createListEventsHandler } from "./list-events.js";
export { selfReflectDefinition, createSelfReflectHandler } from "./self-reflect.js";
export type { ReflectionToolResult } from "./self-reflect.js";
export {
  createSubGoalDefinition,
  completeGoalDefinition,
  reportProgressDefinition,
} from "./goal-tools.js";
export {
  computerDefinition,
  createComputerHandler,
  type ComputerDispatcher,
  type ComputerHandlerOptions,
  type ComputerUnsupportedReason,
} from "./computer.js";

import { webSearchDefinition, createWebSearchHandler } from "./web-search.js";
import { readUrlDefinition, createReadUrlHandler } from "./read-url.js";
import { readFileDefinition, createReadFileHandler } from "./read-file.js";
import { writeFileDefinition, createWriteFileHandler } from "./write-file.js";
import { shellExecDefinition, createShellExecHandler } from "./shell-exec.js";
import { undoWriteDefinition, createUndoWriteHandler } from "./undo-write.js";
import { recallMemoriesDefinition, createRecallMemoriesHandler } from "./recall-memories.js";
import {
  rewriteMemoryDefinition,
  createRewriteMemoryHandler,
  type RewriteMemoryDeps,
} from "./rewrite-memory.js";
import {
  searchConversationsDefinition,
  createSearchConversationsHandler,
  type ConversationSearchHit,
} from "./search-conversations.js";
import { currentTimeDefinition, createCurrentTimeHandler } from "./current-time.js";
import { listEventsDefinition, createListEventsHandler } from "./list-events.js";

export interface BuiltinToolOptions {
  allowedPaths?: string[];
  /** Allowed shell commands (fail-closed: empty/unset = shell_exec denied). */
  commandAllowList?: string[];
  /** Blocked shell commands (always denied, even if allowlisted). */
  commandBlockList?: string[];
  /** Directory for write_file pre-write backups. */
  backupDir?: string;
  searchProvider?: SearchProvider;
  memorySearchFn?: (
    query: string,
    limit: number,
  ) => Promise<Array<{ content: string; confidence: number }>>;
  eventQueryFn?: (
    limit: number,
    eventType?: string,
  ) => Promise<Array<{ event_type: string; timestamp: number; payload: Record<string, unknown> }>>;
  /**
   * When provided, registers the `rewrite_memory` tool (spec/memory-delta-v1.md
   * §5.8 companion). The agent uses this to supersede a stale memory by the
   * short node id surfaced in the Layer-1 memory index. Omitted when the
   * surface doesn't expose the index (no value in registering a tool whose
   * primary input — the short id — isn't visible to the agent).
   */
  rewriteMemoryDeps?: RewriteMemoryDeps;
  /**
   * When provided, registers `search_conversations` — Layer-3
   * transcript retrieval. Returns the agent's verbatim exchange
   * history ranked by BM25. Complements `memorySearchFn` (Layer-2
   * embedding recall over distilled memory nodes).
   */
  conversationSearchFn?: (
    query: string,
    limit: number,
  ) => Promise<ConversationSearchHit[]> | ConversationSearchHit[];
}

export function registerBuiltinTools(
  registry: InMemoryToolRegistry,
  options: BuiltinToolOptions = {},
): void {
  registry.register(currentTimeDefinition, createCurrentTimeHandler());
  registry.register(webSearchDefinition, createWebSearchHandler(options.searchProvider));
  registry.register(readUrlDefinition, createReadUrlHandler());
  registry.register(readFileDefinition, createReadFileHandler(options.allowedPaths));
  registry.register(
    writeFileDefinition,
    createWriteFileHandler({
      allowedPaths: options.allowedPaths,
      backupDir: options.backupDir,
    }),
  );
  registry.register(
    shellExecDefinition,
    createShellExecHandler({
      commandAllowList: options.commandAllowList,
      commandBlockList: options.commandBlockList,
      allowedPaths: options.allowedPaths,
    }),
  );
  registry.register(
    undoWriteDefinition,
    createUndoWriteHandler({
      allowedPaths: options.allowedPaths,
      backupDir: options.backupDir,
    }),
  );

  if (options.memorySearchFn) {
    registry.register(
      recallMemoriesDefinition,
      createRecallMemoriesHandler(options.memorySearchFn),
    );
  }
  if (options.eventQueryFn) {
    registry.register(listEventsDefinition, createListEventsHandler(options.eventQueryFn));
  }
  if (options.rewriteMemoryDeps) {
    registry.register(
      rewriteMemoryDefinition,
      createRewriteMemoryHandler(options.rewriteMemoryDeps),
    );
  }
  if (options.conversationSearchFn) {
    registry.register(
      searchConversationsDefinition,
      createSearchConversationsHandler(options.conversationSearchFn),
    );
  }
}
