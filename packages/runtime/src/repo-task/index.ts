/**
 * Governed repo change — the runtime pieces (milestone B, build step 2).
 * Design of record: docs/proposals/governed-repo-change-v1.md; wire:
 * spec/repo-change-v1.md.
 */
export { checkRepoTaskAuthority } from "./authority.js";
export type {
  RepoTaskAuthorityBundle,
  RepoTaskAuthorityCheck,
  RepoTaskAuthorityFailure,
  RepoTaskPin,
  RepoTaskRevocations,
} from "./authority.js";
export { assertOfferedTools, buildRepoTaskTools, RepoTaskToolMismatchError } from "./tools.js";
export type {
  RepoPathWriteRefusal,
  RepoPathWriteResult,
  RepoPathWriter,
  RepoTaskExpectedTools,
  RepoTaskToolEntry,
  RepoTaskToolHandler,
  RepoTaskToolOutcome,
  RepoTaskToolRegistry,
  RepoTreeEntry,
  RepoTreeReader,
} from "./tools.js";
export { buildRepoTaskPack, repoTaskFrame, repoTaskSystemPrompt } from "./system-prompt.js";
export { runRepoTask, RepoTaskAbortedError, RepoTaskRefusedError } from "./run.js";
export type { RepoTaskAgent, RepoTaskRunEnd, RepoTaskRunInput, RepoTaskRunResult } from "./run.js";
