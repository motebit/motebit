export type MotebitIdentityType = "personal" | "service" | "collaborative";

export interface MotebitIdentityFile {
  spec: string;                    // "motebit/identity@1.0"
  motebit_id: string;             // UUID v7
  created_at: string;             // ISO 8601
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
    public_key: string;            // hex-encoded
  };

  governance: {
    trust_mode: "full" | "guarded" | "minimal";
    max_risk_auto: string;         // RiskLevel name
    require_approval_above: string;
    deny_above: string;
    operator_mode: boolean;
  };

  privacy: {
    default_sensitivity: string;   // SensitivityLevel
    retention_days: Record<string, number>;
    fail_closed: boolean;
  };

  memory: {
    half_life_days: number;
    confidence_threshold: number;
    per_turn_limit: number;
  };

  devices: Array<{
    device_id: string;
    name: string;
    public_key: string;
    registered_at: string;
  }>;
}
