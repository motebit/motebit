# @motebit/sdk Changelog

All notable changes to `@motebit/sdk` are documented here. For full project history, see the [root changelog](../../CHANGELOG.md).

## [Unreleased]

### Added

- Branded ID types: `AllocationId`, `SettlementId`, `ListingId`, `ProposalId` (join existing `MotebitId`, `DeviceId`, `NodeId`, `GoalId`, `EventId`, `ConversationId`, `PlanId`)
- `PrecisionWeights` interface for active inference precision feedback
- `exploration_weight` field on `MarketConfig`
- `CollaborativePlanProposal`, `ProposalParticipant`, `ProposalStepCounter`, `ProposalResponse`, `CollaborativeReceipt` interfaces
- `ProposalStatus` and `ProposalResponseType` enums
- `assigned_motebit_id` on `PlanStep` and `SyncPlanStep`
- `proposal_id` and `collaborative` on `Plan` and `SyncPlan`
- 5 new `EventType` values: `ProposalCreated`, `ProposalAccepted`, `ProposalRejected`, `ProposalCountered`, `CollaborativeStepCompleted`
- `AgentServiceListing` and `AgentTrustRecord` interfaces for capability market
- `MemoryContent` type separated from `MemoryNode` for safe wire serialization
- `did` field on `VerifyResult` and `AgentCapabilities`
- `ReputationSnapshot` type for Beta-binomial smoothed reputation
- `CandidateProfile` and `TaskRequirements` types for market scoring

## [0.1.0] - 2026-03-08

### Added

- Core protocol types: `MotebitState`, `BehaviorCues`, `MemoryNode`, `EventLogEntry`, `PolicyDecision`, `RenderSpec`
- Identity types: `MotebitId`, `DeviceId`, `NodeId`, `GoalId`, `EventId`, `ConversationId`, `PlanId`
- Agent delegation types: `ExecutionReceipt`, `DelegationToken`, `AgentTrustLevel`
- Tool, policy, and sync interfaces
- MIT licensed, zero dependencies
