/**
 * Solana JSON-RPC passthrough — the ONLY path a browser surface takes to a
 * Solana RPC provider.
 *
 * The law (incident 2026-09-30): a provider credential never reaches a
 * browser, by construction. `apps/web` once read `VITE_SOLANA_RPC_URL`, and
 * Vite inlines every `VITE_*` value into public JS, so a Helius mainnet
 * `?api-key=` shipped in the production bundle; strangers drained the
 * account's credits and the provider halted every key on it. The key now
 * lives here, as the server secret `SOLANA_RPC_UPSTREAM_URL`, and the browser
 * points at `https://api.motebit.com/v1/solana-rpc`.
 *
 * What crosses this boundary, deny-by-default:
 *   - POST only; one JSON-RPC 2.0 request per call (no batches);
 *   - a method allowlist of exactly what `apps/web` + `apps/verify` call;
 *   - a body cap, a browser-origin allowlist, and three rate limits — per
 *     client (IPv4 address / IPv6 /64), per IPv6 /48, and a GLOBAL per-minute
 *     upstream budget. The Origin header is spoofable off-browser and one /48
 *     holds 65,536 /64s, so only the global budget bounds what a single
 *     attacker can spend of the provider's credit (the 2026-09-30 drain class);
 *   - in production (VERCEL_ENV=production) the limiter must be the shared
 *     (KV) one — a per-isolate memory limiter there ⇒ 503, never a silent
 *     per-isolate budget;
 *   - the upstream URL is never echoed in a response or a log line — every
 *     upstream-derived string is scrubbed of it, and logs carry the host only;
 *   - upstream unset ⇒ 503, never a silent fallback to a public endpoint.
 *
 * Pure handler (injected env/fetch/limiter/logger) so every guarantee is a
 * unit test; `app/v1/solana-rpc/route.ts` is the thin edge binding.
 */

/**
 * Every RPC method a browser surface issues, and who issues it. `@solana/web3.js`
 * `Connection` method → wire method; spl-token `getAccount` → `getAccountInfo`.
 * A method not listed here is refused (403) — adding one is a reviewed edit,
 * with the caller named.
 */
export const SOLANA_RPC_METHOD_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    "getAccountInfo",
    "wallet-solana web3js-adapter: spl-token getAccount (USDC ATA balance / dest ATA existence)",
  ],
  [
    "getBalance",
    "wallet-solana web3js-adapter + memo-submitter + jupiter: SOL balance / gas floor",
  ],
  [
    "getBlockHeight",
    "web3.js confirmTransaction: blockhash-expiry polling (adapter, memo-submitter, jupiter)",
  ],
  ["getEpochInfo", "wallet-solana web3js-adapter getSignatureOutcome: decisive expiry verdict"],
  [
    "getGenesisHash",
    "wallet-solana isReachable + memo-submitter resolveNetwork: cluster detection",
  ],
  ["getLatestBlockhash", "wallet-solana adapter/memo-submitter/jupiter: tx build + outcome check"],
  ["getMinimumBalanceForRentExemption", "wallet-solana memo-submitter: anchor fee-payer floor"],
  ["getSignatureStatuses", "web3.js confirmTransaction + adapter getSignatureOutcome"],
  [
    "getSignaturesForAddress",
    "state-export-client anchor/revocation lookups (apps/verify) + adapter",
  ],
  ["getTransaction", "wallet-solana web3js-adapter getTransaction: P2P payment verification"],
  ["sendTransaction", "web3.js sendRawTransaction: USDC sends, anchor memos, Jupiter gas swap"],
]);

/** 16 KiB. A max-size Solana tx is 1232 bytes (~1.7 KB base64); every read is far smaller. */
export const SOLANA_RPC_MAX_BODY_BYTES = 16 * 1024;
/** Per-client (IPv4 address / IPv6 /64) requests per minute. Generous for a wallet UI. */
export const SOLANA_RPC_PER_MINUTE_LIMIT = 120;
/** Per IPv6 /48 requests per minute — one /48 is 65,536 /64 buckets. */
export const SOLANA_RPC_PER_48_LIMIT = 600;
/**
 * Default GLOBAL upstream budget (forwarded requests per minute, all clients).
 * `SOLANA_RPC_GLOBAL_PER_MINUTE` (positive integer) overrides it; an invalid
 * value falls back to this default, never to "unlimited".
 */
export const SOLANA_RPC_GLOBAL_PER_MINUTE_DEFAULT = 3000;
const UPSTREAM_TIMEOUT_MS = 20_000;

/**
 * Browser origins that may call. `SOLANA_RPC_ALLOWED_ORIGINS` (comma list)
 * appends further https origins. apps/verify is served by Vercel project
 * receipt-computer at https://receipt.computer and defaults to this route.
 */
export const SOLANA_RPC_DEFAULT_ORIGINS: readonly string[] = [
  "https://motebit.com",
  "https://www.motebit.com",
  "https://receipt.computer", // apps/verify (Vercel project receipt-computer)
  "http://localhost:5173", // apps/web dev
  "http://localhost:5176", // apps/verify dev
  "http://localhost:4173", // vite preview
];

export interface RateLimiter {
  /** true ⇒ allowed. Implementations fail CLOSED (false) when their store errors. */
  hit(key: string, limit: number): Promise<boolean>;
  /**
   * "shared" ⇒ one counter store across every isolate/instance (KV);
   * "memory" ⇒ per-isolate. Production refuses to serve on "memory".
   */
  readonly kind: "shared" | "memory";
}

/**
 * The env keys the handler reads — closed, so a new key is a type error until
 * the route supplies it (as a literal-key `process.env.<NAME>` read).
 */
export interface SolanaRpcEnv {
  SOLANA_RPC_ALLOWED_ORIGINS?: string | undefined;
  SOLANA_RPC_GLOBAL_PER_MINUTE?: string | undefined;
  SOLANA_RPC_UPSTREAM_URL?: string | undefined;
  VERCEL_ENV?: string | undefined;
}

export interface SolanaRpcDeps {
  env: SolanaRpcEnv;
  fetch: typeof fetch;
  limiter: RateLimiter;
  log: (line: string) => void;
  now?: () => number;
}

/**
 * Fixed-window in-memory limiter — the local-dev floor when no shared store is
 * configured. Bounded: at `maxKeys` it evicts the OLDEST key (Map insertion
 * order; keys carry their minute, so the oldest windows go first), never every
 * counter — clearing all would hand every live client a fresh budget.
 */
export function createMemoryRateLimiter(maxKeys = 10_000): RateLimiter {
  const counts = new Map<string, number>();
  return {
    kind: "memory",
    hit(key, limit) {
      if (!counts.has(key)) {
        while (counts.size >= maxKeys) {
          const oldest = counts.keys().next();
          if (oldest.done === true) break;
          counts.delete(oldest.value);
        }
      }
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return Promise.resolve(n <= limit);
    },
  };
}

/** The global upstream budget per minute from env (invalid ⇒ the default). */
export function globalBudget(env: SolanaRpcEnv): number {
  const raw = env.SOLANA_RPC_GLOBAL_PER_MINUTE?.trim() ?? "";
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) return SOLANA_RPC_GLOBAL_PER_MINUTE_DEFAULT;
  return Number(raw);
}

/** Host of a URL with no path, query, or userinfo — the only form a log line may carry. */
export function redactUrl(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return "<unparseable-url>";
  }
}

/** Remove every occurrence of the upstream URL and its secret-bearing parts from `text`. */
export function scrubUpstream(text: string, upstream: string): string {
  const secrets = new Set<string>([upstream]);
  try {
    const u = new URL(upstream);
    if (u.search.length > 1) secrets.add(u.search.slice(1));
    for (const v of u.searchParams.values()) if (v.length >= 6) secrets.add(v);
    if (u.username) secrets.add(u.username);
    if (u.password) secrets.add(u.password);
    const segs = u.pathname.split("/").filter((s) => s.length >= 16);
    for (const s of segs) secrets.add(s);
  } catch {
    /* unparseable upstream — the whole-string entry still applies */
  }
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    if (s.length > 0) out = out.split(s).join("[redacted]");
  }
  return out;
}

function allowedOrigins(env: SolanaRpcEnv): Set<string> {
  const extra = (env.SOLANA_RPC_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("https://") || s.startsWith("http://localhost:"));
  return new Set([...SOLANA_RPC_DEFAULT_ORIGINS, ...extra]);
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    // web3.js sends `solana-client: js/<version>` on every request.
    "Access-Control-Allow-Headers": "Content-Type, solana-client",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

type RpcId = string | number | null;

function rpcError(
  status: number,
  code: number,
  message: string,
  id: RpcId,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id }), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

/** Every non-IP string (absent header, garbage, an unparseable address) shares this ONE bucket. */
export const INVALID_IP_BUCKET = "invalid";

const IPV4 =
  /^(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;

/** The first `n` 16-bit groups of an IPv6 address, normalized; null if not IPv6. */
function ipv6Prefix(raw: string, n: number): string[] | null {
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const all = [...head, ...tail];
  // Only the address's final group may be an embedded dotted quad (two groups).
  const final = halves.length === 2 ? tail.at(-1) : head.at(-1);
  const dotted = final?.includes(".") === true;
  if (dotted && !IPV4.test(final ?? "")) return null;
  const hexGroups = dotted ? all.slice(0, -1) : all;
  if (hexGroups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const count = all.length + (dotted ? 1 : 0);
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - count;
    if (fill < 1) return null;
    groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  } else {
    if (count !== 8) return null;
    groups = head;
  }
  return groups.slice(0, n).map((g) => parseInt(g, 16).toString(16));
}

function normalizeIp(ip: string): string {
  return (
    ip
      .trim()
      .replace(/^\[|\](?::\d+)?$/g, "")
      .split("%")[0] ?? ""
  );
}

/**
 * The per-client rate-limit bucket. IPv4 is per address; IPv6 is per /64 —
 * one subscriber is routinely handed a whole /64, so a per-address key would
 * give a single client 2^64 fresh budgets. Anything that is not a valid IPv4
 * or IPv6 address (including "" and "unknown") shares ONE bucket,
 * `INVALID_IP_BUCKET` — never a per-string key a caller could vary.
 */
export function rateLimitBucket(ip: string): string {
  const raw = normalizeIp(ip);
  if (IPV4.test(raw)) return raw;
  if (!raw.includes(":")) return INVALID_IP_BUCKET;
  // IPv4-mapped (::ffff:1.2.3.4) is an IPv4 client.
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw);
  if (mapped?.[1]) return IPV4.test(mapped[1]) ? mapped[1] : INVALID_IP_BUCKET;
  const prefix = ipv6Prefix(raw, 4);
  return prefix == null ? INVALID_IP_BUCKET : `${prefix.join(":")}::/64`;
}

/**
 * The aggregate bucket above `rateLimitBucket`: an IPv6 client's /48 (one
 * /48 is 65,536 /64s — a per-/64 limit alone multiplies by that). null for
 * IPv4 and invalid addresses (their per-client bucket is already the unit).
 */
export function rateLimitAggregateBucket(ip: string): string | null {
  if (!rateLimitBucket(ip).endsWith("::/64")) return null;
  const prefix = ipv6Prefix(normalizeIp(ip), 3);
  return prefix == null ? null : `${prefix.join(":")}::/48`;
}

/** Read at most `cap` bytes; null when the body is larger. */
async function readCapped(request: Request, cap: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > cap) return null;
  if (request.body == null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export function handleSolanaRpcOptions(request: Request, deps: SolanaRpcDeps): Response {
  const origin = request.headers.get("origin") ?? "";
  if (!allowedOrigins(deps.env).has(origin)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function handleSolanaRpcPost(
  request: Request,
  deps: SolanaRpcDeps,
): Promise<Response> {
  const origin = request.headers.get("origin") ?? "";
  if (!allowedOrigins(deps.env).has(origin)) {
    return rpcError(403, -32000, "origin not allowed", null, {});
  }
  const cors = corsHeaders(origin);

  const upstream = deps.env.SOLANA_RPC_UPSTREAM_URL?.trim() ?? "";
  if (upstream === "") {
    // Fail closed: never fall back to a public endpoint or a client-supplied URL.
    return rpcError(503, -32000, "solana rpc not configured on this server", null, cors);
  }
  if (deps.env.VERCEL_ENV === "production" && deps.limiter.kind !== "shared") {
    // A per-isolate limiter in production is N independent budgets (one per
    // isolate) and no global cap at all. Refuse rather than serve unbounded.
    deps.log("[solana-rpc] refusing: production without a shared (KV) rate limiter");
    return rpcError(503, -32000, "solana rpc rate limiter not configured", null, cors);
  }

  const now = deps.now?.() ?? Date.now();
  const minute = Math.floor(now / 60_000);
  const limited = (): Response => {
    const res = rpcError(429, -32005, "rate limited", null, cors);
    res.headers.set("Retry-After", "60");
    return res;
  };
  const ip = clientIp(request);
  if (
    !(await deps.limiter.hit(
      `proxy:solana-rpc:${rateLimitBucket(ip)}:${minute}`,
      SOLANA_RPC_PER_MINUTE_LIMIT,
    ))
  ) {
    return limited();
  }
  const aggregate = rateLimitAggregateBucket(ip);
  if (
    aggregate != null &&
    !(await deps.limiter.hit(`proxy:solana-rpc:${aggregate}:${minute}`, SOLANA_RPC_PER_48_LIMIT))
  ) {
    return limited();
  }

  const text = await readCapped(request, SOLANA_RPC_MAX_BODY_BYTES);
  if (text === null) return rpcError(413, -32600, "request too large", null, cors);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rpcError(400, -32700, "parse error", null, cors);
  }
  if (Array.isArray(body))
    return rpcError(400, -32600, "batch requests are not supported", null, cors);
  if (body === null || typeof body !== "object") {
    return rpcError(400, -32600, "invalid request", null, cors);
  }
  const req = body as { jsonrpc?: unknown; method?: unknown; params?: unknown; id?: unknown };
  const id: RpcId = typeof req.id === "string" || typeof req.id === "number" ? req.id : null;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return rpcError(400, -32600, "invalid request", id, cors);
  }
  if (!SOLANA_RPC_METHOD_ALLOWLIST.has(req.method)) {
    return rpcError(403, -32601, "method not allowed", id, cors);
  }
  if (req.params !== undefined && (req.params === null || typeof req.params !== "object")) {
    return rpcError(400, -32602, "invalid params", id, cors);
  }

  // The GLOBAL upstream budget, spent only by requests that will actually be
  // forwarded: it bounds total provider spend whatever the client spread.
  if (!(await deps.limiter.hit(`proxy:solana-rpc:global:${minute}`, globalBudget(deps.env)))) {
    deps.log(`[solana-rpc] global upstream budget exhausted minute=${minute}`);
    return limited();
  }

  // Forward a re-serialized request: only the four JSON-RPC fields cross.
  const forward = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: req.method,
    ...(req.params !== undefined ? { params: req.params } : {}),
  });

  // The fetch AND the body read share one scrubbing try: a body stream can
  // fail (abort, reset, timeout mid-body) with an error naming the URL.
  let upstreamRes: Response;
  let upstreamBody: string;
  try {
    upstreamRes = await deps.fetch(upstream, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: forward,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    upstreamBody = await upstreamRes.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log(
      `[solana-rpc] upstream fetch failed host=${redactUrl(upstream)} method=${req.method}: ${scrubUpstream(msg, upstream)}`,
    );
    return rpcError(502, -32603, "upstream unavailable", id, cors);
  }

  const upstreamText = scrubUpstream(upstreamBody, upstream);
  if (!upstreamRes.ok) {
    deps.log(
      `[solana-rpc] upstream status=${upstreamRes.status} host=${redactUrl(upstream)} method=${req.method}`,
    );
  }
  // Pass through the JSON-RPC body only; upstream headers never cross.
  return new Response(upstreamText, {
    status: upstreamRes.ok ? 200 : upstreamRes.status === 429 ? 429 : 502,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
