/**
 * DNS-based discovery for motebits.
 *
 * Protocol: _motebit.{domain} TXT "v=motebit1 url=https://example.com/.well-known/motebit.md [endpoint=...]"
 *
 * Fallback: fetch https://{domain}/.well-known/motebit.md directly.
 *
 * Never throws — all errors are captured in the result object.
 */

export interface DnsDiscoveryResult {
  domain: string;
  motebitUrl: string;
  endpointUrl?: string;
  identityVerified: boolean;
  motebitId?: string;
  publicKey?: string;
  motebitType?: string;
  serviceName?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Minimal identity file frontmatter extraction (no @motebit/verify dependency)
// ---------------------------------------------------------------------------

interface ParsedFrontmatter {
  motebit_id?: string;
  public_key?: string;
  motebit_type?: string;
  name?: string;
}

function extractFrontmatter(content: string): ParsedFrontmatter {
  const firstDash = content.indexOf("---\n");
  if (firstDash === -1) return {};
  const bodyStart = firstDash + 4;
  const secondDash = content.indexOf("\n---", bodyStart);
  if (secondDash === -1) return {};
  const yaml = content.slice(bodyStart, secondDash);

  const idMatch = /motebit_id:\s*"?([^"\n]+)"?/.exec(yaml);
  const keyMatch = /public_key:\s*"?([0-9a-fA-F]+)"?/.exec(yaml);
  const typeMatch = /motebit_type:\s*"?([^"\n]+)"?/.exec(yaml);
  const nameMatch = /(?:^|\n)\s*name:\s*"?([^"\n]+)"?/.exec(yaml);

  return {
    motebit_id: idMatch?.[1]?.trim(),
    public_key: keyMatch?.[1]?.trim(),
    motebit_type: typeMatch?.[1]?.trim(),
    name: nameMatch?.[1]?.trim(),
  };
}

// ---------------------------------------------------------------------------
// TXT record parsing
// ---------------------------------------------------------------------------

interface TxtFields {
  version?: string;
  url?: string;
  endpoint?: string;
}

function parseTxtRecord(records: string[][]): TxtFields | null {
  for (const chunks of records) {
    // DNS TXT records may be split into multiple strings — join them.
    const full = chunks.join("");
    if (!full.includes("v=motebit1")) continue;

    const parts = full.split(/\s+/);
    const fields: TxtFields = {};
    for (const part of parts) {
      if (part.startsWith("v=")) fields.version = part.slice(2);
      else if (part.startsWith("url=")) fields.url = part.slice(4);
      else if (part.startsWith("endpoint=")) fields.endpoint = part.slice(9);
    }
    if (fields.version === "motebit1" && fields.url) return fields;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fetch with timeout
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Fetch + parse identity file
// ---------------------------------------------------------------------------

async function fetchIdentity(
  url: string,
  domain: string,
  endpointUrl?: string,
): Promise<DnsDiscoveryResult> {
  const content = await fetchWithTimeout(url, 5000);
  const fm = extractFrontmatter(content);

  if (!fm.motebit_id || !fm.public_key) {
    return {
      domain,
      motebitUrl: url,
      endpointUrl,
      identityVerified: false,
      error: "Identity file missing motebit_id or public_key",
    };
  }

  return {
    domain,
    motebitUrl: url,
    endpointUrl,
    identityVerified: true,
    motebitId: fm.motebit_id,
    publicKey: fm.public_key,
    motebitType: fm.motebit_type,
    serviceName: fm.name,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** DNS resolve function type — injectable for testing. */
export type ResolveTxtFn = (hostname: string) => Promise<string[][]>;

/**
 * Discover a motebit via DNS TXT record.
 * Looks up _motebit.{domain} for a TXT record with v=motebit1.
 *
 * @param domain - The domain to look up.
 * @param resolveTxt - Optional override for DNS resolution (used in tests).
 */
export async function discoverByDns(
  domain: string,
  resolveTxt?: ResolveTxtFn,
): Promise<DnsDiscoveryResult> {
  try {
    let resolve: ResolveTxtFn;
    if (resolveTxt) {
      resolve = resolveTxt;
    } else {
      const dns = await import("node:dns/promises");
      resolve = (hostname: string) => dns.resolveTxt(hostname);
    }

    // 5-second timeout
    const records = await Promise.race([
      resolve(`_motebit.${domain}`),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("DNS lookup timed out")), 5000),
      ),
    ]);

    const fields = parseTxtRecord(records);
    if (!fields || !fields.url) {
      return {
        domain,
        motebitUrl: "",
        identityVerified: false,
        error: "No valid v=motebit1 TXT record found",
      };
    }

    return await fetchIdentity(fields.url, domain, fields.endpoint);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      domain,
      motebitUrl: "",
      identityVerified: false,
      error: `DNS discovery failed: ${message}`,
    };
  }
}

/**
 * Discover a motebit via .well-known URL (fallback when DNS isn't available).
 * Fetches https://{domain}/.well-known/motebit.md
 */
export async function discoverByWellKnown(domain: string): Promise<DnsDiscoveryResult> {
  const url = `https://${domain}/.well-known/motebit.md`;
  try {
    return await fetchIdentity(url, domain);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      domain,
      motebitUrl: url,
      identityVerified: false,
      error: `Well-known discovery failed: ${message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Relay-based discovery
// ---------------------------------------------------------------------------

export interface RelayDiscoveryResult {
  motebit_id: string;
  endpoint_url: string;
  capabilities: string[];
  public_key: string;
}

export interface RelayDiscoveryOptions {
  relayUrl: string;
  capability?: string;
  authToken?: string;
  limit?: number;
}

/**
 * Discover motebits via the API relay's agent registry.
 * Queries GET /api/v1/agents/discover with optional capability and limit filters.
 *
 * Never throws — returns an empty array on failure.
 */
export async function discoverViaRelay(
  opts: RelayDiscoveryOptions,
): Promise<RelayDiscoveryResult[]> {
  try {
    const url = new URL("/api/v1/agents/discover", opts.relayUrl);
    if (opts.capability) url.searchParams.set("capability", opts.capability);
    if (opts.limit != null) url.searchParams.set("limit", String(opts.limit));

    const headers: Record<string, string> = {};
    if (opts.authToken) {
      headers["Authorization"] = `Bearer ${opts.authToken}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let resp: Response;
    try {
      resp = await fetch(url.toString(), { headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      return [];
    }

    const body = (await resp.json()) as { agents?: RelayDiscoveryResult[] };
    if (!Array.isArray(body.agents)) {
      return [];
    }

    return body.agents;
  } catch {
    return [];
  }
}

/**
 * Try DNS first, fall back to .well-known.
 */
export async function discoverMotebit(domain: string): Promise<DnsDiscoveryResult> {
  const dnsResult = await discoverByDns(domain);
  if (dnsResult.identityVerified) return dnsResult;

  // DNS failed or didn't verify — try .well-known fallback
  const wellKnownResult = await discoverByWellKnown(domain);
  if (wellKnownResult.identityVerified) return wellKnownResult;

  // Both failed — return DNS error (more informative usually)
  return {
    domain,
    motebitUrl: dnsResult.motebitUrl || wellKnownResult.motebitUrl,
    identityVerified: false,
    error: `DNS: ${dnsResult.error ?? "unknown"}; Well-known: ${wellKnownResult.error ?? "unknown"}`,
  };
}
