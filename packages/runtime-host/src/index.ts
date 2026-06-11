export {
  RUNTIME_HOST_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  encodeFrame,
  JsonLineDecoder,
} from "./protocol.js";
export type {
  AttachRefusalReason,
  ClientMessage,
  ServerMessage,
  HelloMessage,
  HelloAckMessage,
  RefuseMessage,
  InvokeMessage,
  ChunkMessage,
  EndMessage,
  InvokeErrorMessage,
  EventMessage,
  SubscribeMessage,
  UnsubscribeMessage,
} from "./protocol.js";

export { defaultRuntimeHostPaths } from "./paths.js";
export type { RuntimeHostPaths } from "./paths.js";

export { readLockfile, writeLockfile, removeLockfile, isPidAlive } from "./lockfile.js";
export type { LockfileRecord } from "./lockfile.js";

export { RuntimeHostServer, CoordinatorAlreadyBoundError } from "./server.js";
export type { RuntimeHostServerOptions, RuntimeHostLogger, InvokeHandler } from "./server.js";

export {
  RuntimeHostClient,
  AttachRefusedError,
  CoordinatorUnreachableError,
  mintAttachToken,
} from "./client.js";
export type { RuntimeHostClientOptions } from "./client.js";

export { electRuntimeHost } from "./election.js";
export type { ElectionOutcome, ElectRuntimeHostOptions } from "./election.js";
