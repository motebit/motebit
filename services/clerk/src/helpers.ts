/**
 * Env-derived configuration for the Clerk service. Every variable read here
 * MUST appear in `.env.example` (check-deploy-parity rules 3 + 5, both
 * directions gated).
 */

import { parseMicroEnv } from "@motebit/molecule-runner";

export interface ClerkServiceConfig {
  port: number;
  dbPath: string;
  dataDir: string;
  /** Solana RPC for the sovereign wallet rail (the Clerk's own funds). */
  solanaRpcUrl: string | null;
  /** The relay operator's PINNED Ed25519 public key (hex) — P2P treasury root. */
  relayPublicKey: string | null;
  /** Capability to hire when the task prompt does not name one. */
  defaultCapability: string;
  /** The self-imposed lifetime spend ceiling (micro-USD) the self-grant commits to. */
  ceilingMicro: number;
  /**
   * Dry-run posture — DEFAULT TRUE. The whole metered spine runs at hard-zero
   * (grant verify → gate → meter → ceiling → refusal) with no broadcast. Set
   * `DRY_RUN=0` (or `false`) to move real money — a deliberate operator step.
   */
  dryRun: boolean;
  unitCost: number;
  syncUrl: string | null;
  publicUrl: string | null;
}

/** DRY_RUN is TRUE unless explicitly disabled — the fail-safe default. */
function parseDryRun(raw: string | undefined): boolean {
  if (raw == null) return true;
  const v = raw.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no");
}

export function loadConfig(): ClerkServiceConfig {
  return {
    port: parseInt(process.env["MOTEBIT_PORT"] ?? "3700", 10),
    dbPath: process.env["MOTEBIT_DB_PATH"] ?? "./data/clerk.db",
    dataDir: process.env["MOTEBIT_DATA_DIR"] ?? "./data",
    solanaRpcUrl: process.env["MOTEBIT_SOLANA_RPC_URL"] ?? null,
    relayPublicKey: process.env["MOTEBIT_RELAY_PUBLIC_KEY"] ?? null,
    defaultCapability: process.env["MOTEBIT_CLERK_CAPABILITY"] ?? "research",
    // $1 lifetime by default. Strict: a malformed or empty value refuses the
    // boot — it is signed into the clerk's own grant.
    ceilingMicro: parseMicroEnv(
      "MOTEBIT_CLERK_CEILING_MICRO",
      process.env["MOTEBIT_CLERK_CEILING_MICRO"],
      1_000_000,
    ),
    dryRun: parseDryRun(process.env["DRY_RUN"]),
    unitCost: parseFloat(process.env["MOTEBIT_UNIT_COST"] ?? "0.01"),
    syncUrl: process.env["MOTEBIT_SYNC_URL"] ?? null,
    publicUrl: process.env["MOTEBIT_PUBLIC_URL"] ?? null,
  };
}
