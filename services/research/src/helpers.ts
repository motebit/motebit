/** Load service configuration from environment variables. */
export function loadConfig() {
  return {
    port: parseInt(process.env["MOTEBIT_PORT"] ?? "3400", 10),
    dbPath: process.env["MOTEBIT_DB_PATH"] ?? "./data/research.db",
    // Persistent volume root for bootstrapServiceIdentity(). On Fly this is
    // /data; locally, ./data. Identity (motebit.json, motebit.key, motebit.md)
    // is generated here on first boot and reloaded on every subsequent boot.
    dataDir: process.env["MOTEBIT_DATA_DIR"] ?? "./data",
    authToken: process.env["MOTEBIT_AUTH_TOKEN"],
    syncUrl: process.env["MOTEBIT_SYNC_URL"],
    apiToken: process.env["MOTEBIT_API_TOKEN"],
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
    maxToolCalls: parseInt(process.env["MOTEBIT_MAX_TOOL_CALLS"] ?? "8", 10),
  };
}
