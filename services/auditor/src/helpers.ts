/**
 * Env-derived configuration for the Auditor service. Every variable read
 * here MUST appear in `.env.example` (check-deploy-parity rules 3 + 5,
 * both directions gated).
 */

export interface AuditorServiceConfig {
  port: number;
  dbPath: string;
  dataDir: string;
  /** The relay whose PUBLIC endpoints are the audit evidence source. */
  relayUrl: string | null;
  /**
   * Optional hard pin for the relay's transparency public key (hex).
   * Absent ⇒ trust-on-first-use via the verified self-signature of
   * /.well-known/motebit-transparency.json. Present + mismatch ⇒ refusal.
   */
  relayPublicKey: string | null;
  /** How many supplied receipts the spot-check samples at most. */
  receiptSampleN: number;
  unitCost: number;
  authToken: string | null;
  syncUrl: string | null;
  apiToken: string | null;
  publicUrl: string | null;
}

export function loadConfig(): AuditorServiceConfig {
  return {
    port: parseInt(process.env["MOTEBIT_PORT"] ?? "3600", 10),
    dbPath: process.env["MOTEBIT_DB_PATH"] ?? "./data/auditor.db",
    dataDir: process.env["MOTEBIT_DATA_DIR"] ?? "./data",
    relayUrl: process.env["MOTEBIT_RELAY_URL"] ?? process.env["MOTEBIT_SYNC_URL"] ?? null,
    relayPublicKey: process.env["MOTEBIT_RELAY_PUBLIC_KEY"] ?? null,
    receiptSampleN: parseInt(process.env["MOTEBIT_RECEIPT_SAMPLE_N"] ?? "3", 10),
    unitCost: parseFloat(process.env["MOTEBIT_UNIT_COST"] ?? "0.05"),
    authToken: process.env["MOTEBIT_AUTH_TOKEN"] ?? null,
    syncUrl: process.env["MOTEBIT_SYNC_URL"] ?? null,
    apiToken: process.env["MOTEBIT_API_TOKEN"] ?? null,
    publicUrl: process.env["MOTEBIT_PUBLIC_URL"] ?? null,
  };
}
