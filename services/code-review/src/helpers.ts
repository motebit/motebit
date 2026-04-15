/** Load service configuration from environment variables. */
export function loadConfig() {
  return {
    port: parseInt(process.env["MOTEBIT_PORT"] ?? "3300", 10),
    dbPath: process.env["MOTEBIT_DB_PATH"] ?? "./data/code-review.db",
    // Persistent volume root for bootstrapServiceIdentity(). On Fly
    // this is `/data`; locally, ./data. Identity (motebit.json,
    // motebit.key, motebit.md) is generated here on first boot and
    // reloaded on every subsequent boot. Survives deploys.
    dataDir: process.env["MOTEBIT_DATA_DIR"] ?? "./data",
    authToken: process.env["MOTEBIT_AUTH_TOKEN"],
    syncUrl: process.env["MOTEBIT_SYNC_URL"],
    apiToken: process.env["MOTEBIT_API_TOKEN"],
    publicUrl: process.env["MOTEBIT_PUBLIC_URL"],
    anthropicApiKey: process.env["ANTHROPIC_API_KEY"],
    /**
     * URL of the motebit read-url atom (e.g. http://localhost:3500/mcp).
     * Required — code-review is a molecule that delegates diff fetching to
     * read-url so the response carries a signed delegation receipt. Without
     * a readUrlUrl the service cannot produce its chain.
     */
    readUrlUrl: process.env["MOTEBIT_READ_URL_URL"],
    /** Optional: motebit_id of the read-url atom for relay budget binding. */
    readUrlTargetId: process.env["MOTEBIT_READ_URL_TARGET_ID"],
  };
}
