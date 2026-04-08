// --- CLI subcommand handlers (non-REPL) ---
//
// Barrel file. Every handler is defined in a topic-scoped file under
// `./subcommands/{topic}.ts`; this file just re-exports them so the
// one importer (`./index.ts`) can keep its `import from "./subcommands.js"`
// unchanged.
//
// The extraction happened in 13 targets (T1 doctor → T13 delegate),
// mirroring the leaves-first, one-commit-per-target pattern proven
// on the runtime, desktop, mobile, and spatial surfaces. Shared
// internal helpers (`fetchRelayJson`, `getRelayUrl`,
// `getRelayAuthHeaders`) live in `./subcommands/_helpers.ts` — the
// underscore marks that module as internal to this directory, not
// part of the public barrel.

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
