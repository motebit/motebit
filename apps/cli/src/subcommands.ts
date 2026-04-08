// --- CLI subcommand handlers (non-REPL) ---
//
// Barrel file. Every `handleX` function is defined in a topic-scoped
// file under `./subcommands/{topic}.ts`; this file only re-exports
// them so the single importer (`./index.ts`) keeps one import site.
//
// Shared internal helpers (`fetchRelayJson`, `getRelayUrl`,
// `getRelayAuthHeaders`, `requireMotebitId`) live in
// `./subcommands/_helpers.ts`. The leading underscore marks that
// module as internal to this directory — it is deliberately not
// re-exported here.

export { handleDoctor } from "./subcommands/doctor.js";
export { handleExport } from "./subcommands/export.js";
export {
  handleGoalAdd,
  handleGoalList,
  handleGoalOutcomes,
  handleGoalRemove,
  handleGoalSetEnabled,
} from "./subcommands/goals.js";
export {
  handleApprovalList,
  handleApprovalShow,
  handleApprovalApprove,
  handleApprovalDeny,
} from "./subcommands/approvals.js";
export { handleId } from "./subcommands/id.js";
export { handleLedger } from "./subcommands/ledger.js";
export { handleCredentials } from "./subcommands/credentials.js";
export { handleVerify } from "./subcommands/verify.js";
export { handleRegister } from "./subcommands/register.js";
export {
  handleFederationStatus,
  handleFederationPeers,
  handleFederationPeer,
} from "./subcommands/federation.js";
export { handleRotate } from "./subcommands/rotate.js";
export { handleBalance, handleWithdraw, handleFund } from "./subcommands/market.js";
export { handleDelegate } from "./subcommands/delegate.js";
