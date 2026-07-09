export {
  createSovereignController,
  type SovereignController,
  type SovereignFetchAdapter,
  type SovereignFetchInit,
  type VerifiedFetchResult,
  type StateExportVerificationStatus,
  type SovereignState,
  type SovereignTab,
  type CredentialEntry,
  type BalanceResponse,
  type BalanceTransaction,
  type BudgetResponse,
  type BudgetAllocation,
  type GoalRow,
  type LedgerManifest,
  type LedgerTimelineEvent,
  type SuccessionResponse,
  type KeySuccessionEntry,
  type LocalIdentitySnapshot,
} from "./sovereign/controller";

export {
  createAgentsController,
  applySortFilter,
  collectCapabilities,
  scoreHardwareAttestation,
  formatHardwarePlatform,
  formatNameClaim,
  formatLatency,
  shortMotebitId,
  agentDisplayLabel,
  trustAuraClass,
  economicForPeer,
  formatPeerEconomics,
  type AgentsController,
  type AgentsFetchAdapter,
  type AgentsState,
  type AgentsTab,
  type AgentRecord,
  type AgentEconomicSummary,
  type AgentPeerEconomics,
  type AgentEconomicUnattributed,
  type DiscoveredAgent,
  type AgentHardwareAttestation,
  type AgentHardwarePlatform,
  type AgentLatencyStats,
  type PricingEntry,
  type TrustLevel,
  type AgentFreshness,
  type SortKey,
} from "./agents/controller";

export {
  // The trust resting record (felt-interior.md §6) — the RELATIONAL register,
  // "whom the interior has come to know." Proven-only (Known edges), score-free
  // by construction (the global-score refusal turned inward); surfaces call
  // resolveFeltTrust and render the returned FeltTrustRecord. Locked by
  // check-felt-interior-honesty (invariant 4).
  resolveFeltTrust,
  type FeltTrustRecord,
  type FeltTrustShapeEntry,
} from "./agents/felt-trust";

export {
  createMemoryController,
  filterMemoriesView,
  classifyCertainty,
  type Certainty,
  type MemoryController,
  type MemoryControllerOptions,
  type MemoryFetchAdapter,
  type MemoryState,
  type MemoryNode,
  type DeletionCertificate,
} from "./memory/controller";

export {
  // Canonical entry point — projects + verifies internally, returns only
  // render-safe records. The candidate-consuming primitives
  // (projectFeltConsolidation / verifyFeltCoverage / feltReceiptOnly) and the
  // `FeltCandidate` type are deliberately NOT exported: unverified
  // cycle-attributed mutations must not cross the panels boundary.
  resolveFeltConsolidation,
  defaultFeltRedaction,
  feltHeadline,
  feltMutationLine,
  feltVerifiedAssurance,
  feltAssuranceGlyph,
  feltReceiptScope,
  type FeltSourceEvent,
  type FeltAssurance,
  type FeltMutation,
  type FeltMutationKind,
  type FeltReceiptSummary,
  type FeltMutationEvidence,
  type FeltConsolidationRecord,
  type FeltRedactionPolicy,
  type FeltCoverageAdapter,
} from "./memory/felt-consolidation";
export {
  // The memory resting record (felt-interior.md §5) — the RECORD to
  // consolidation's ACTS. Content-free and assurance-free by construction
  // (unsigned-local honesty); surfaces call resolveFeltMemory and render the
  // returned FeltMemoryRecord. Locked by check-felt-interior-honesty (inv. 3).
  resolveFeltMemory,
  type FeltMemoryNode,
  type FeltMemoryShapeEntry,
  type FeltMemoryRecord,
} from "./memory/felt-memory";

export {
  // The leverage-moment attribution (felt-accumulation Inc 3) — the calm,
  // sensitivity-bounded phrase a surface weaves into the act when accrued
  // state was drawn upon. Pure projection; the basis is produced-not-authored
  // upstream. Surfaces render the returned text their own way (Ring 3).
  resolveAccrualAttribution,
  type AccrualAttribution,
} from "./memory/accrual-attribution";

export {
  createActivityController,
  filterActivityView,
  type ActivityController,
  type ActivityControllerOptions,
  type ActivityFetchAdapter,
  type ActivityState,
  type ActivityEvent,
  type ActivityKind,
  type ActivityAuditRecord,
  type ActivityEventRecord,
} from "./activity/controller";

export {
  createRetentionController,
  summarizeRetentionCeilings,
  type RetentionController,
  type RetentionFetchAdapter,
  type RetentionState,
  type RetentionVerification,
  type RetentionManifest,
  type RetentionStoreDeclaration,
  type TransparencyManifestSummary,
} from "./retention/controller";

export {
  createSelfTestController,
  selfTestBadgeLabel,
  type SelfTestController,
  type SelfTestFetchAdapter,
  type SelfTestState,
  type SelfTestStatus,
  type SelfTestRunStatus,
  type SelfTestResult,
} from "./self-test/controller";

export {
  createGoalsController,
  type GoalsController,
  type GoalsFetchAdapter,
  type GoalsState,
  type NewGoalInput,
} from "./goals/controller";

export { type ScheduledGoal, type GoalMode, type GoalStatus } from "./goals/types";

export { formatCountdownUntil, formatTokens } from "./goals/format";

export {
  createSkillsController,
  filterSkillsView,
  type SkillsController,
  type SkillsPanelAdapter,
  type SkillsPanelState,
  type SkillsInstallSource,
  type SkillSummary,
  type SkillDetail,
  type SkillInstallResult,
  type SkillProvenanceStatus,
  type SkillSensitivity,
  type SkillPlatform,
} from "./skills/controller";

export {
  createTrustController,
  isDeletionAction,
  type TrustController,
  type TrustControllerOptions,
  type TrustFetchAdapter,
  type TrustState,
  type TrustCookieSummary,
  type TrustMemoryNode,
  type TrustConversation,
  type TrustReceipt,
  type TrustAuditRecord,
  type TrustPeerRecord,
  type TrustCookie,
} from "./trust/controller";

export {
  RegistryBackedSkillsPanelAdapter,
  SkillConsentDeclined,
  requiresInstallConsent,
  type RegistryBackedSkillsPanelAdapterOptions,
  type RequestInstallConsentFn,
  type SkillBundleShape,
  type SkillInstallConsentRequest,
  type SkillRegistryShape,
} from "./skills/registry-backed-adapter";

export {
  SIDE_RAIL_PANELS,
  PANEL_PRESENTATION_AVAILABILITY,
  type PanelRegister,
  type PanelPrimitive,
  type PanelPresentationMode,
  type PanelSurface,
  type IsPresentationAvailable,
  type SideRailPanel,
} from "./registry";
