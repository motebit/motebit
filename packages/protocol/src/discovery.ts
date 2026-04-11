/**
 * Discovery types — motebit/discovery@1.0.
 *
 * MIT: these types define the interoperable format for relay discovery
 * and agent resolution. Any implementation can produce and verify
 * relay metadata and resolve agents using these types.
 */

// === Relay Metadata (§3) ===

/** Federation peer entry in relay metadata. */
export interface RelayMetadataPeer {
  /** Peer relay's MotebitId. */
  relay_id: string;
  /** Peer relay's canonical HTTPS endpoint. */
  endpoint_url: string;
}

/**
 * Signed relay metadata served at /.well-known/motebit.json.
 *
 * Foundation Law (§3.5):
 * - Path MUST be /.well-known/motebit.json
 * - Response MUST include relay_id, public_key, endpoint_url, protocol_version, signature
 * - Endpoint MUST be unauthenticated
 * - Signature MUST be verifiable using only the public_key in the response
 */
export interface RelayMetadata {
  /** Spec version (e.g., "1.0"). */
  protocol_version: string;
  /** Relay's MotebitId (UUID v7). */
  relay_id: string;
  /** Human-readable relay name. */
  display_name?: string;
  /** Hex-encoded Ed25519 public key (64 hex chars). */
  public_key: string;
  /** Canonical HTTPS base URL. */
  endpoint_url: string;
  /** Supported feature capabilities. */
  capabilities?: string[];
  /** Platform fee as decimal (0.05 = 5%). */
  fee_rate?: number;
  /** Known federation peers. */
  federation_peers?: RelayMetadataPeer[];
  /** Approximate number of registered agents. */
  agent_count?: number;
  /** Ed25519 signature over canonical JSON of all other fields. */
  signature: string;
}

// === Agent Resolution (§5) ===

/**
 * Result of resolving an agent's location across the federation.
 *
 * Foundation Law (§5.3):
 * - Agent resolution MUST propagate through federation peers
 * - visited_relays set MUST be forwarded for loop prevention
 * - Agents with federation_visible: false MUST NOT appear in remote results
 * - resolved_via chain MUST be included for auditability
 */
export interface AgentResolutionResult {
  /** The queried agent's MotebitId. */
  motebit_id: string;
  /** Whether the agent was located. */
  found: boolean;
  /** Hosting relay's MotebitId (present if found). */
  relay_id?: string;
  /** HTTPS endpoint of the hosting relay (present if found). */
  relay_url?: string;
  /** Agent's advertised capabilities. */
  capabilities?: string[];
  /** Agent's hex-encoded Ed25519 public key (present if found). */
  public_key?: string;
  /** Chain of relay_ids traversed during resolution (audit trail). */
  resolved_via: string[];
  /** Whether result came from cache. */
  cached: boolean;
  /** Seconds until this result should be re-resolved. */
  ttl: number;
}
