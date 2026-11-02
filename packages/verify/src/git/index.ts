/**
 * `@motebit/verify/git` — reading a repository for governed repo changes
 * (spec/repo-change-v1.md), without ever running git on the repository's own
 * git directory: the isolated session, tip resolution from the ref files,
 * tree and blob reads, the pins, revocations and path policy at a commit, the
 * spent check, the entries between two trees, and every input
 * `verifyRepoChange` (`@motebit/verifier`) needs in CI-on-PR mode — and,
 * offline on a landed change, the same inputs from raw re-hashed objects,
 * with the squash commit's committer time accepted only under pinned
 * OpenPGP keys (`computeLandedRepoChangeInputs`).
 *
 * One implementation for both judges: `motebit-verify repo-change` and the
 * self-check of `motebit repo-task run`, which imports this subpath.
 */
export {
  GIT_CALL_TIMEOUT_MS,
  MAX_GIT_OUTPUT_BYTES,
  OID,
  openIsolatedGit,
  resolveGitDirectories,
  resolveObjectDirectory,
} from "./session.js";
export type { GitDirectories, IsolatedGit, ObjectStream, StoredObject } from "./session.js";
export {
  ObjectStoreError,
  gitObjectId,
  openRawObjects,
  parseCommit,
  parseTree,
} from "./objects.js";
export type { RawCommit, RawObjects, RawTreeEntry } from "./objects.js";
export {
  crc24,
  parsePinnedSigningKeys,
  splitSignedCommit,
  verifyCommitSignature,
} from "./openpgp.js";
export type { CommitSignatureCheck, PinnedSigningKey } from "./openpgp.js";
export {
  LANDING_COMMITTER,
  acceptLandingTime,
  computeLandedRepoChangeInputs,
  verifyRepoChangeLanded,
} from "./landed.js";
export type {
  LandedRepoChange,
  LandedRepoChangeCheck,
  LandedRepoChangeInputs,
  LandedRepoChangeReport,
  LandedTime,
} from "./landed.js";
export { RepoTipError, resolveRepoTip } from "./tip.js";
export type { RepoTip } from "./tip.js";
export { commitParents, gitBlobId, listTree, pathKey, readBlob } from "./tree.js";
export type { TreeEntry } from "./tree.js";
export {
  AGENT_PIN_DIR,
  BUNDLES_DIR,
  PRINCIPAL_PIN_FILE,
  REVOCATIONS_DIR,
  RepoStateError,
  bundlePath,
  isCanonicalGrantId,
  isGrantSpent,
  pinFromIdentityFile,
  readRepoState,
} from "./state.js";
export type { RepoState } from "./state.js";
export {
  REPO_CHANGE_PUBLISHER,
  computeEntries,
  computeRepoChangeInputs,
  verifyRepoChangePullRequest,
} from "./repo-change.js";
export type {
  RepoChangeInputs,
  RepoChangePullRequest,
  RepoChangePullRequestCheck,
  RepoChangeReport,
} from "./repo-change.js";
