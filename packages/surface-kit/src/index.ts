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
  mayMint,
  statusOf,
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
} from "./machine-roster.js";
export { emptyReplica, parseReplica, mergeReplicas, frozenFor } from "./machine-roster-replica.js";
export type {
  MachineRosterReplica,
  ReplicaRead,
  FrozenValue,
  FrozenVerdict,
} from "./machine-roster-replica.js";
export { buildRosterView, keyFingerprint, suppressionText } from "./machine-roster-view.js";
export type {
  MachineRosterView,
  RosterLine,
  RosterNote,
  RosterClaim,
  LineLiveness,
} from "./machine-roster-view.js";
