import { parseMicroEnv } from "@motebit/molecule-runner";

/**
 * claude-sonnet-4-6 list pricing in micro-USD per million tokens — the one
 * table both the per-report cost estimate (research.ts) and the paid-spend
 * budget's LLM reserve read. Cache tiers: writes bill 1.25× input, reads 0.1×.
 */
export const SONNET_MICRO_PER_MTOK = {
  input: 3_000_000,
  output: 15_000_000,
  cacheWrite: 3_750_000,
  cacheRead: 300_000,
} as const;

/** Default thin margin: 5% of the listed task price, in basis points. */
export const DEFAULT_RESEARCH_MARGIN_BPS = 500;

/**
 * The conservative per-task inference reserve, in micro-USD, derived from the
 * loop's own caps priced at {@link SONNET_MICRO_PER_MTOK}. Every term is a
 * structural bound in research.ts, not an observation:
 *
 *   context  = 2,000 (system prompt + tool defs) + maxToolCalls × 2,000
 *              (read-url's 8,000-char projection cap ≈ 2,000 tokens/result)
 *   reserve  = context            × cacheWrite   (each token cached once)
 *            + maxToolCalls × context/2 × cacheRead (tool turns re-read the prefix)
 *            + context            × cacheRead    (the synthesis call reads it all)
 *            + maxToolCalls × 128 × output       (tool_use turns' small outputs)
 *            + 4,096              × output       (synthesis at its max_tokens cap)
 *
 * At the default cap of 8: 67,500 + 21,600 + 5,400 + 15,360 + 61,440 =
 * 171,300 µ ($0.1713). The live `cost_estimate_usd` log is the meter that
 * replaces this bound with observed cost via MOTEBIT_RESEARCH_LLM_RESERVE_MICRO.
 */
export function deriveLlmReserveMicro(maxToolCalls: number): number {
  const p = SONNET_MICRO_PER_MTOK;
  const context = 2_000 + maxToolCalls * 2_000;
  const microTokens =
    context * p.cacheWrite +
    maxToolCalls * (context / 2) * p.cacheRead +
    context * p.cacheRead +
    maxToolCalls * 128 * p.output +
    4_096 * p.output;
  return Math.ceil(microTokens / 1_000_000);
}

/**
 * Per-task ceiling on PAID sub-delegation outflow (worker net + relay fee), in
 * micro-USD: own price − thin margin − inference reserve, clamped at zero. A
 * zero budget means zero paid hops — free tools still run.
 */
export function computePaidSpendBudgetMicro(params: {
  unitCostMicro: number;
  marginBps: number;
  llmReserveMicro: number;
}): number {
  const marginMicro = Math.ceil((params.unitCostMicro * params.marginBps) / 10_000);
  const budget = params.unitCostMicro - marginMicro - params.llmReserveMicro;
  // Defence in depth behind the boot validation: a non-finite input yields a
  // ZERO budget, never NaN (`spent + q > NaN` is false — it would pay every hop).
  return Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;
}

/** Default listed price of a research task, USD (`MOTEBIT_UNIT_COST`). */
export const DEFAULT_RESEARCH_UNIT_COST = "0.25";

/**
 * Parse `MOTEBIT_UNIT_COST` (USD, decimal) to integer micro-units, or `null`
 * when it is not a finite non-negative decimal — the boot refuses rather than
 * running with a NaN price (`parseFloat("abc")` ⇒ NaN ⇒ a NaN budget).
 */
export function parseUnitCostMicro(raw: string | undefined): number | null {
  const v = (raw ?? DEFAULT_RESEARCH_UNIT_COST).trim();
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const micro = Math.round(Number(v) * 1_000_000);
  return Number.isSafeInteger(micro) ? micro : null;
}

/**
 * Boot validation of every paid-spend budget input. Returns the refusal
 * message, or `null` when all inputs are finite, non-negative and in range.
 * The service refuses to start on a message — an invalid budget input is an
 * operator error, never silently a default and never NaN.
 */
export function paidSpendBudgetConfigError(params: {
  unitCostRaw: string | undefined;
  maxToolCalls: number;
  marginBps: number;
  llmReserveMicro: number;
}): string | null {
  if (parseUnitCostMicro(params.unitCostRaw) == null) {
    return `MOTEBIT_UNIT_COST=${JSON.stringify(params.unitCostRaw)} is not a non-negative decimal USD price`;
  }
  if (!Number.isSafeInteger(params.maxToolCalls) || params.maxToolCalls < 1) {
    return "MOTEBIT_MAX_TOOL_CALLS must be a positive integer";
  }
  if (!Number.isSafeInteger(params.marginBps) || params.marginBps < 0 || params.marginBps > 9_999) {
    return "MOTEBIT_RESEARCH_MARGIN_BPS must be an integer in [0, 9999]";
  }
  if (!Number.isSafeInteger(params.llmReserveMicro) || params.llmReserveMicro < 0) {
    return "MOTEBIT_RESEARCH_LLM_RESERVE_MICRO must be a non-negative integer (micro-USD), or empty for the derived default";
  }
  return null;
}

/**
 * Non-negative safe integer from env; unset or empty ⇒ `fallback`. A value
 * that is SET but invalid (non-numeric, negative, above `max`) yields NaN, so
 * `paidSpendBudgetConfigError` refuses the boot instead of silently defaulting.
 */
function envNonNegativeInt(
  raw: string | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (raw == null || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) return NaN;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n <= max ? n : NaN;
}

/** Load service configuration from environment variables. */
export function loadConfig() {
  const maxToolCalls = envNonNegativeInt(process.env["MOTEBIT_MAX_TOOL_CALLS"], 8);
  return {
    port: parseInt(process.env["MOTEBIT_PORT"] ?? "3400", 10),
    dbPath: process.env["MOTEBIT_DB_PATH"] ?? "./data/research.db",
    // Persistent volume root for bootstrapServiceIdentity(). On Fly this is
    // /data; locally, ./data. Identity (motebit.json, motebit.key, motebit.md)
    // is generated here on first boot and reloaded on every subsequent boot.
    dataDir: process.env["MOTEBIT_DATA_DIR"] ?? "./data",
    syncUrl: process.env["MOTEBIT_SYNC_URL"],
    publicUrl: process.env["MOTEBIT_PUBLIC_URL"],
    anthropicApiKey: process.env["ANTHROPIC_API_KEY"],
    /** URL of the motebit web-search MCP endpoint (e.g. http://localhost:3200/mcp). */
    webSearchUrl: process.env["MOTEBIT_WEB_SEARCH_URL"],
    /** URL of the motebit read-url MCP endpoint. */
    readUrlUrl: process.env["MOTEBIT_READ_URL_URL"],
    /** Optional motebit IDs of the target atoms — used for relay budget binding. */
    webSearchTargetId: process.env["MOTEBIT_WEB_SEARCH_TARGET_ID"],
    readUrlTargetId: process.env["MOTEBIT_READ_URL_TARGET_ID"],
    /** Maximum total tool calls (search + fetch combined) per research turn. */
    maxToolCalls,
    // Inc 2b — paid sub-delegation money seam. Both must be set to pay atoms
    // P2P; absent ⇒ atom hops use the free direct-MCP path (dormant until the
    // atoms are priced). The molecule's identity key IS the Solana wallet seed.
    solanaRpcUrl: process.env["MOTEBIT_SOLANA_RPC_URL"] ?? null,
    relayPublicKey: process.env["MOTEBIT_RELAY_PUBLIC_KEY"]?.trim() || null,
    // USDC SPL mint for the sovereign wallet rail — MUST match the network
    // behind MOTEBIT_SOLANA_RPC_URL (devnet USDC on staging). Absent ⇒ the rail
    // defaults to mainnet USDC (only correct on a mainnet deployment).
    solanaUsdcMint: process.env["MOTEBIT_SOLANA_USDC_MINT"] ?? null,
    // Lifetime spend ceiling for the self-issued grant (micro-USD). Default $1.
    // Strict: a malformed or empty value refuses the boot (signed into the grant).
    ceilingMicro: parseMicroEnv(
      "MOTEBIT_RESEARCH_CEILING_MICRO",
      process.env["MOTEBIT_RESEARCH_CEILING_MICRO"],
      1_000_000,
    ),
    // Per-task paid-spend budget inputs (micro-units, integer). Margin below
    // 100%; reserve defaults to the structural bound for this tool-call cap.
    marginBps: envNonNegativeInt(
      process.env["MOTEBIT_RESEARCH_MARGIN_BPS"],
      DEFAULT_RESEARCH_MARGIN_BPS,
      9_999,
    ),
    llmReserveMicro: envNonNegativeInt(
      process.env["MOTEBIT_RESEARCH_LLM_RESERVE_MICRO"],
      deriveLlmReserveMicro(maxToolCalls),
    ),
  };
}
