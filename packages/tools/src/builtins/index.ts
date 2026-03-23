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
export { listEventsDefinition, createListEventsHandler } from "./list-events.js";
export { selfReflectDefinition, createSelfReflectHandler } from "./self-reflect.js";
export type { ReflectionToolResult } from "./self-reflect.js";
export {
  createSubGoalDefinition,
  completeGoalDefinition,
  reportProgressDefinition,
} from "./goal-tools.js";

import { webSearchDefinition, createWebSearchHandler } from "./web-search.js";
import { readUrlDefinition, createReadUrlHandler } from "./read-url.js";
import { readFileDefinition, createReadFileHandler } from "./read-file.js";
import { writeFileDefinition, createWriteFileHandler } from "./write-file.js";
import { shellExecDefinition, createShellExecHandler } from "./shell-exec.js";
import { undoWriteDefinition, createUndoWriteHandler } from "./undo-write.js";
import { recallMemoriesDefinition, createRecallMemoriesHandler } from "./recall-memories.js";
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
}

export function registerBuiltinTools(
  registry: InMemoryToolRegistry,
  options: BuiltinToolOptions = {},
): void {
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
}
