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
    githubToken: process.env["GITHUB_TOKEN"],
    /** GitHub OAuth — takes precedence over static GITHUB_TOKEN. */
    githubOAuthClientId: process.env["GITHUB_OAUTH_CLIENT_ID"],
    githubOAuthClientSecret: process.env["GITHUB_OAUTH_CLIENT_SECRET"],
    githubOAuthRefreshToken: process.env["GITHUB_OAUTH_REFRESH_TOKEN"],
  };
}
