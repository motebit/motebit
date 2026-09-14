/**
 * Pure helper functions for the read-url service.
 * Extracted from index.ts for testability.
 */

export function loadConfig() {
  return {
    port: parseInt(process.env["MOTEBIT_PORT"] ?? "3200", 10),
    dbPath: process.env["MOTEBIT_DB_PATH"] ?? "./data/read-url.db",
    // Persistent volume root. On Fly this is `/data` (mounted via
    // fly.toml); locally, a scratch directory works. The service
    // bootstraps its motebit identity inside this directory via
    // `bootstrapServiceIdentity()` — motebit.json + motebit.key +
    // motebit.md all live under here and survive redeploys.
    dataDir: process.env["MOTEBIT_DATA_DIR"] ?? "./data",
    syncUrl: process.env["MOTEBIT_SYNC_URL"],
    /**
     * MCP HTTP endpoint protection. When set, the MCP server only accepts
     * requests carrying `Authorization: Bearer ${authToken}` (or a motebit
     * signed token). The relay's `forwardTaskViaMcp` authenticates AS THE
     * RELAY with the per-task dispatch token (`Bearer motebit:<dispatch>`,
     * verified under the pinned relay key) — this static bearer is for
     * direct, non-relay callers.
     */
    authToken: process.env["MOTEBIT_AUTH_TOKEN"],
    publicUrl: process.env["MOTEBIT_PUBLIC_URL"],
    /** Pinned relay Ed25519 public key (hex) for task admission; TOFU from the well-known when unset. */
    relayPublicKey: process.env["MOTEBIT_RELAY_PUBLIC_KEY"]?.trim() || undefined,
    // Unpriced by decision (2026-09-13): read-url is an internal utility atom
    // whose value is priced into the molecules that call it (research $0.25,
    // code-review $0.20). A separate price created an unpayable internal hop
    // (code-review has no payer seam) that kept admission open here. A price
    // may return when an external payer exists; the listing shape stays.
    unitCost: parseFloat(process.env["MOTEBIT_UNIT_COST"] ?? "0"),
  };
}
