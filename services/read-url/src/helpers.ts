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
    apiToken: process.env["MOTEBIT_API_TOKEN"],
    /**
     * MCP HTTP endpoint protection. When set, the MCP server only accepts
     * requests carrying `Authorization: Bearer ${authToken}` (or a motebit
     * signed token). The relay's `forwardTaskViaMcp` sends Bearer apiToken;
     * this lets a relay-forwarded task reach this atom without spoofing.
     */
    authToken: process.env["MOTEBIT_AUTH_TOKEN"],
    publicUrl: process.env["MOTEBIT_PUBLIC_URL"],
  };
}
