import { InMemoryToolRegistry } from "../index.js";

export { webSearchDefinition, createWebSearchHandler } from "./web-search.js";
export { readUrlDefinition, createReadUrlHandler } from "./read-url.js";
export { readFileDefinition, createReadFileHandler } from "./read-file.js";
export { writeFileDefinition, createWriteFileHandler } from "./write-file.js";
export { shellExecDefinition, createShellExecHandler } from "./shell-exec.js";
export { recallMemoriesDefinition, createRecallMemoriesHandler } from "./recall-memories.js";
export { listEventsDefinition, createListEventsHandler } from "./list-events.js";
export { createSubGoalDefinition, completeGoalDefinition, reportProgressDefinition } from "./goal-tools.js";

import { webSearchDefinition, createWebSearchHandler } from "./web-search.js";
import { readUrlDefinition, createReadUrlHandler } from "./read-url.js";
import { readFileDefinition, createReadFileHandler } from "./read-file.js";
import { writeFileDefinition, createWriteFileHandler } from "./write-file.js";
import { shellExecDefinition, createShellExecHandler } from "./shell-exec.js";
import { recallMemoriesDefinition, createRecallMemoriesHandler } from "./recall-memories.js";
import { listEventsDefinition, createListEventsHandler } from "./list-events.js";

export interface BuiltinToolOptions {
  allowedPaths?: string[];
  memorySearchFn?: (
    query: string,
    limit: number,
  ) => Promise<Array<{ content: string; confidence: number }>>;
  eventQueryFn?: (
    limit: number,
    eventType?: string,
  ) => Promise<
    Array<{ event_type: string; timestamp: number; payload: Record<string, unknown> }>
  >;
}

export function registerBuiltinTools(
  registry: InMemoryToolRegistry,
  options: BuiltinToolOptions = {},
): void {
  registry.register(webSearchDefinition, createWebSearchHandler());
  registry.register(readUrlDefinition, createReadUrlHandler());
  registry.register(readFileDefinition, createReadFileHandler(options.allowedPaths));
  registry.register(writeFileDefinition, createWriteFileHandler(options.allowedPaths));
  registry.register(shellExecDefinition, createShellExecHandler());

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
