/**
 * Pure helper functions for the web-search service.
 * Extracted for testability — no I/O, no side effects.
 */

/**
 * Canonicalize search results for deterministic receipt hashing.
 * Strips tracking params, normalizes URLs, sorts by URL, takes top N.
 */
export function canonicalizeResults(raw: string, maxResults = 5): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return raw;

    const normalized = parsed
      .slice(0, maxResults)
      .map((r: Record<string, unknown>) => {
        const rawUrl = r["url"] ?? r["link"];
        let url = typeof rawUrl === "string" ? rawUrl : "";
        try {
          const u = new URL(url);
          for (const p of [
            "utm_source",
            "utm_medium",
            "utm_campaign",
            "utm_content",
            "ref",
            "fbclid",
            "gclid",
          ]) {
            u.searchParams.delete(p);
          }
          url = u.toString();
        } catch {
          // Not a valid URL — keep as-is
        }
        const rawTitle = r["title"];
        const rawSnippet = r["snippet"] ?? r["description"];
        return {
          title: typeof rawTitle === "string" ? rawTitle : "",
          url,
          snippet: typeof rawSnippet === "string" ? rawSnippet : "",
        };
      })
      .sort((a, b) => a.url.localeCompare(b.url));

    return JSON.stringify(normalized);
  } catch {
    return raw;
  }
}

/** Load service configuration from environment variables. */
export function loadConfig() {
  return {
    port: parseInt(process.env["MOTEBIT_PORT"] ?? "3200", 10),
    dbPath: process.env["MOTEBIT_DB_PATH"] ?? "./data/web-search.db",
    // Persistent volume root for bootstrapServiceIdentity(). On Fly
    // this is `/data`; locally, ./data. Identity (motebit.json,
    // motebit.key, motebit.md) is generated here on first boot and
    // reloaded on every subsequent boot. Survives deploys.
    dataDir: process.env["MOTEBIT_DATA_DIR"] ?? "./data",
    authToken: process.env["MOTEBIT_AUTH_TOKEN"],
    syncUrl: process.env["MOTEBIT_SYNC_URL"],
    apiToken: process.env["MOTEBIT_API_TOKEN"],
    braveApiKey: process.env["BRAVE_SEARCH_API_KEY"],
    tavilyApiKey: process.env["TAVILY_API_KEY"],
    publicUrl: process.env["MOTEBIT_PUBLIC_URL"],
    delegateReadUrl: process.env["MOTEBIT_DELEGATE_READ_URL"],
    delegateTargetId: process.env["MOTEBIT_DELEGATE_TARGET_ID"],
  };
}
