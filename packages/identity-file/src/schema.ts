export type MotebitIdentityType = "personal" | "service" | "collaborative";

export interface MotebitIdentityFile {
  spec: string; // "motebit/identity@1.0"
  motebit_id: string; // UUID v7
  created_at: string; // ISO 8601
  owner_id: string;

  // Service identity fields (optional, spec §3.6)
  type?: MotebitIdentityType;
  service_name?: string;
  service_description?: string;
  service_url?: string;
  capabilities?: string[];
  terms_url?: string;

  identity: {
    algorithm: "Ed25519";
    public_key: string; // hex-encoded
  };

  governance: {
    trust_mode: "full" | "guarded" | "minimal";
    max_risk_auto: string; // RiskLevel name
    require_approval_above: string;
    deny_above: string;
    operator_mode: boolean;
    /** Optional multi-party approval quorum. */
    approval_quorum?: {
      threshold: number;
      approvers: string[];
      risk_floor?: string;
    };
  };

  privacy: {
    default_sensitivity: string; // SensitivityLevel
    retention_days: Record<string, number>;
    fail_closed: boolean;
  };

  memory: {
    half_life_days: number;
    confidence_threshold: number;
    per_turn_limit: number;
  };

  /** Organizational guardian for key recovery and enterprise custody (§3.3). */
  guardian?: {
    public_key: string;
    organization?: string;
    organization_id?: string;
    established_at: string;
    /** Ed25519 signature by guardian key over canonical JSON of {action,guardian_public_key,motebit_id}. Proves organizational custody. */
    attestation?: string;
  };

  devices: Array<{
    device_id: string;
    name: string;
    public_key: string;
    registered_at: string;
  }>;

  succession?: Array<{
    old_public_key: string;
    new_public_key: string;
    timestamp: number;
    reason?: string;
    old_key_signature?: string;
    new_key_signature: string;
    recovery?: boolean;
    guardian_signature?: string;
  }>;
}
