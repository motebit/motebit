// --- CLI subcommand handlers (non-REPL) ---
//
// Barrel file. Every `handleX` function is defined in a topic-scoped
// file in this directory; this file only re-exports them so the
// single importer (`../index.ts`) keeps one import site.
//
// Shared internal helpers (`fetchRelayJson`, `getRelayUrl`,
// `getRelayAuthHeaders`, `requireMotebitId`) live in `./_helpers.ts`.
// The leading underscore marks that module as internal to this
// directory — it is deliberately not re-exported here.
//
// Modules are listed alphabetically. Handlers within a module are
// listed in their on-disk declaration order to keep the barrel's
// signature stable against cosmetic reorderings inside a topic file.

export {
  handleApprovalApprove,
  handleApprovalDeny,
  handleApprovalList,
  handleApprovalShow,
} from "./approvals.js";
export { handleCredentials } from "./credentials.js";
export { handleDelegate } from "./delegate.js";
export { handleDoctor } from "./doctor.js";
export { handleExport } from "./export.js";
export {
  handleFederationPeer,
  handleFederationPeers,
  handleFederationStatus,
} from "./federation.js";
export {
  handleGoalAdd,
  handleGoalList,
  handleGoalOutcomes,
  handleGoalRemove,
  handleGoalSetEnabled,
} from "./goals.js";
export { handleId } from "./id.js";
export { handleLedger } from "./ledger.js";
export { handleBalance, handleFund, handleWithdraw } from "./market.js";
export { handleRegister } from "./register.js";
export { handleRotate } from "./rotate.js";
export { handleVerify } from "./verify.js";
export { handleWallet } from "./wallet.js";
