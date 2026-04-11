/**
 * Migration types — motebit/migration@1.0.
 *
 * MIT: these types define the interoperable format for agent migration
 * between relays. Any implementation can produce and verify migration
 * artifacts using these types.
 */

// === Migration Lifecycle (§3) ===

/** Migration lifecycle states. Terminal states are irreversible. */
export type MigrationState =
  | "idle"
  | "initiated"
  | "attesting"
  | "exporting"
  | "settling"
  | "departed"
  | "cancelled";

// === Migration Initiation (§4) ===

/**
 * Agent's request to begin migration.
 *
 * Foundation Law (§4.3):
 * - Relay MUST issue MigrationToken for valid MigrationRequest from registered agent
 * - Relay MUST NOT condition token issuance on destination relay, reason, or any other factor
 */
export interface MigrationRequest {
  /** Agent's MotebitId. */
  motebit_id: string;
  /** Optional: URL or relay_id of intended destination. */
  destination_relay?: string;
  /** Optional: human-readable reason for migration. */
  reason?: string;
  /** Unix ms when the request was made. */
  requested_at: number;
  /** Ed25519 by agent over canonical JSON of all fields except signature. */
  signature: string;
}

/**
 * Token issued by source relay authorizing migration.
 *
 * Foundation Law (§4.3):
 * - Relay MUST NOT revoke MigrationToken once issued (except on agent-initiated cancellation)
 * - Active tasks must complete or expire before advancing past settling
 */
export interface MigrationToken {
  /** UUID v7. */
  token_id: string;
  /** Agent's MotebitId. */
  motebit_id: string;
  /** Issuing relay's identity. */
  source_relay_id: string;
  /** Issuing relay's canonical URL. */
  source_relay_url: string;
  /** Unix ms. */
  issued_at: number;
  /** Unix ms. Default: 72 hours from issuance. */
  expires_at: number;
  /** Ed25519 by source relay over canonical JSON of all fields except signature. */
  signature: string;
}

// === Departure Attestation (§5) ===

/**
 * Signed attestation of an agent's history at the source relay.
 *
 * Foundation Law (§5.3):
 * - Relay MUST issue DepartureAttestation for any agent with active MigrationToken
 * - Relay MUST NOT fabricate or inflate attestation data
 */
export interface DepartureAttestation {
  /** UUID v7. */
  attestation_id: string;
  /** Agent's MotebitId. */
  motebit_id: string;
  /** Attesting relay's identity. */
  source_relay_id: string;
  /** Attesting relay's canonical URL. */
  source_relay_url: string;
  /** Unix ms — when the agent first registered. */
  first_seen: number;
  /** Unix ms — last task execution or interaction. */
  last_active: number;
  /** Agent trust level at departure. */
  trust_level: string;
  /** Total completed tasks as worker. */
  successful_tasks: number;
  /** Total failed tasks as worker. */
  failed_tasks: number;
  /** Total credentials issued to this agent. */
  credentials_issued: number;
  /** Virtual account balance in micro-units at attestation time. */
  balance_at_departure: number;
  /** Unix ms. */
  attested_at: number;
  /** Ed25519 by source relay over canonical JSON of all fields except signature. */
  signature: string;
}

// === Credential Export (§6) ===

/**
 * Bundle of credentials, anchor proofs, and key succession records.
 *
 * Foundation Law (§6.2):
 * - Relay MUST provide credential export for agents with active MigrationToken
 * - Relay MUST NOT withhold credentials issued to agent
 * - Agent signs bundle — relay does not
 */
export interface CredentialBundle {
  /** Agent's MotebitId. */
  motebit_id: string;
  /** Unix ms. */
  exported_at: number;
  /** W3C VC 2.0 credentials (credential@1.0). */
  credentials: Record<string, unknown>[];
  /** Onchain anchors (credential-anchor@1.0). */
  anchor_proofs: Record<string, unknown>[];
  /** Full key rotation history (identity@1.0). */
  key_succession: Record<string, unknown>[];
  /** SHA-256 of canonical JSON of all fields except bundle_hash and signature. */
  bundle_hash: string;
  /** Ed25519 by agent over canonical JSON of all fields except signature. */
  signature: string;
}

// === Balance Settlement (§7) ===

/**
 * Agent's explicit waiver of remaining balance.
 *
 * Foundation Law (§7.3):
 * - Migration advances to departed only after withdrawal confirmed OR agent signs BalanceWaiver
 */
export interface BalanceWaiver {
  /** Agent's MotebitId. */
  motebit_id: string;
  /** Amount waived in micro-units. */
  waived_amount: number;
  /** Unix ms. */
  waived_at: number;
  /** Ed25519 by agent. */
  signature: string;
}

// === Arrival at Destination (§8) ===

/**
 * Complete migration presentation submitted to the destination relay.
 *
 * Foundation Law (§8.4):
 * - Destination relay MUST validate per §8.2
 * - If accepted, motebit_id MUST be preserved
 * - Acceptance is local admission decision; relay MAY decline
 */
export interface MigrationPresentation {
  /** Migration authorization from source relay. */
  migration_token: MigrationToken;
  /** Signed attestation of agent's history. */
  departure_attestation: DepartureAttestation;
  /** Agent's credentials, anchor proofs, and key succession. */
  credential_bundle: CredentialBundle;
  /** Full motebit.md content (identity@1.0). */
  identity_file: string;
  /** Unix ms. */
  presented_at: number;
  /** Ed25519 by agent over canonical JSON of all fields except signature. */
  signature: string;
}
