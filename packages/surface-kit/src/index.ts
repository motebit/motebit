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

export {
  performKeyRotation,
  rotateOrThrow,
  parseHeldRotation,
  KeyRotationError,
} from "./key-rotation.js";
export type {
  HeldRotation,
  KeyRotationNote,
  KeyRotationOutcome,
  KeyRotationPorts,
} from "./key-rotation.js";

// Machine roster, part C (docs/proposals/machine-roster-clients-v1.md C2–C6):
// the controller every key-holding surface runs, its replica, and the view.
export {
  MachineRoster,
  createRosterSigner,
  parseServedRoster,
  hostSocketsOpen,
  mayMint,
  statusOf,
  unplaceableEnrollments,
  ROSTER_CHUNK_SIZE,
} from "./machine-roster.js";
export type {
  MachineRosterPorts,
  RosterSigner,
  HostEnrollmentBody,
  HostRetirementBody,
  RosterFetch,
  RosterPresentResponse,
  ServedRoster,
  LivenessRow,
  LiveUnenrolled,
  RosterAcquisition,
  RosterAcquired,
  RosterRemedy,
  RosterRefusalReason,
  SuppressionReason,
  PresentReport,
  ThisDeviceStatus,
  EnsureEnrolledOutcome,
  RetireOutcome,
  EnrollOutcome,
  EnrollRefusal,
  RotationHookOutcome,
  NotCarried,
  MachineRosterOptions,
  HeldKeyRefusal,
} from "./machine-roster.js";
// Machine roster C-2 (docs/proposals/machine-roster-surfaces-v1.md §1A/§1B):
// whether the held key is the identity key, the rotation link, and the
// Settings section state holder every C-2 surface shares.
export { classifyHeldKey, heldKeyText, rotationLinkReplica } from "./machine-roster-held-key.js";
export type { HeldKeyClass, IdentityBasis } from "./machine-roster-held-key.js";
// #800 — what a local motebit.md may contribute: only a file signed by the held key.
export { boundIdentityFile, identityFileRecords } from "./machine-roster-identity-file.js";
export type { BoundIdentityFile } from "./machine-roster-identity-file.js";
export {
  createMachineRosterSection,
  rosterLineActions,
  retireNotice,
  enrollNotice,
  needsForceText,
  replicaDigest,
  presentationDue,
  nextPresentationRecord,
  boundedRetryUntil,
  MAX_RETRY_AFTER_MS,
} from "./machine-roster-section.js";
export type {
  MachineRosterSection,
  MachineRosterSectionDeps,
  MachineRosterSectionState,
  PresentationCadence,
  PresentationRecord,
  RosterLineActions,
} from "./machine-roster-section.js";
export {
  emptyReplica,
  parseReplica,
  mergeReplicas,
  frozenFor,
  captureFor,
} from "./machine-roster-replica.js";
export type {
  MachineRosterReplica,
  ReplicaRead,
  FrozenValue,
  FrozenVerdict,
  RotationCapture,
} from "./machine-roster-replica.js";
export {
  buildRosterView,
  emptyState,
  keyFingerprint,
  suppressionText,
} from "./machine-roster-view.js";
export type {
  MachineRosterView,
  RosterLine,
  RosterNote,
  RosterClaim,
  LineLiveness,
} from "./machine-roster-view.js";
