// Platform-agnostic surface — loadable in environments without Node
// APIs (the desktop webview). Node hosts additionally import
// `@motebit/runtime-host/node` for the node platform + canonical paths.
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
  ChatMessage,
  ResolveApprovalMessage,
  QueryMessage,
  ActMessage,
  QueryResultMessage,
  QueryErrorMessage,
  RegisterCapabilitiesMessage,
  BridgeInvokeMessage,
  BridgeChunkMessage,
  BridgeEndMessage,
  BridgeErrorMessage,
  ChunkMessage,
  EndMessage,
  InvokeErrorMessage,
  EventMessage,
  SubscribeMessage,
  UnsubscribeMessage,
} from "./protocol.js";

export { isWindowsPipePath } from "./paths-shared.js";
export type { RuntimeHostPaths } from "./paths-shared.js";

export type { FrameConnection, FrameListener, RuntimeHostPlatform } from "./transport.js";

export { readLockfile, writeLockfile, removeLockfile } from "./lockfile.js";
export type { LockfileRecord } from "./lockfile.js";

export { RuntimeHostServer, CoordinatorAlreadyBoundError } from "./server.js";
export type {
  RuntimeHostServerOptions,
  RuntimeHostLogger,
  InvokeHandler,
  ChatHandler,
  ResolveApprovalHandler,
  QueryHandler,
} from "./server.js";

export {
  RuntimeHostClient,
  AttachRefusedError,
  CoordinatorUnreachableError,
  mintAttachToken,
} from "./client.js";
export type { RuntimeHostClientOptions, BridgedCapabilityHandler } from "./client.js";

export { pickSafeChatOptions, pickSafeInvokeOptions } from "./safe-options.js";

export {
  AI_LOOP_EXCLUDED_ORGANS,
  BRIDGED_ORGAN_TOOL_SOURCE,
  bridgedToolRegistry,
  wireBridgedOrganTools,
} from "./bridged-tools.js";
export type { BridgedOrganDefinitions, BridgedToolHost } from "./bridged-tools.js";

export {
  electRuntimeHost,
  probeSocketLive,
  acquireTakeoverMutex,
  releaseTakeoverMutex,
} from "./election.js";
export type { ElectionOutcome, ElectRuntimeHostOptions } from "./election.js";
