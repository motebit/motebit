/** Decode hex string to Uint8Array. */
export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/** Load service configuration from environment variables. */
export function loadConfig() {
  return {
    port: parseInt(process.env["MOTEBIT_PORT"] ?? "3300", 10),
    dbPath: process.env["MOTEBIT_DB_PATH"] ?? "./data/code-review.db",
    identityPath: process.env["MOTEBIT_IDENTITY_PATH"] ?? "./motebit.md",
    privateKeyHex: process.env["MOTEBIT_PRIVATE_KEY_HEX"],
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
