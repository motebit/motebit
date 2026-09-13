/**
 * Outbound URL policy — the one place motebit decides whether a URL it did
 * not author may be fetched from a server's network position.
 *
 * Every caller-influenced fetch is a server-side request forgery primitive
 * until proven otherwise: the web proxy's `/v1/fetch`, the read-url atom,
 * the local `read_url` tool driven by a model, the relay's registered agent
 * endpoints and federation peers. Before this module each site had its own
 * `startsWith("http")` and nothing else (2026-09-13 external review, F2/F4).
 *
 * The law is small and closed:
 *   - `http:` / `https:` only; no credentials in the URL.
 *   - The host must be a globally-routable destination: never loopback,
 *     private (RFC 1918 / ULA), link-local (incl. cloud metadata
 *     169.254.169.254), CGNAT, multicast, reserved, documentation ranges,
 *     `localhost`, `*.local`, `*.internal`, `*.home.arpa`, or an IPv4
 *     address smuggled inside IPv6 (`::ffff:a.b.c.d`, NAT64).
 *   - When the caller can resolve DNS (Node), every resolved address must
 *     ALSO pass — a public hostname pointing at 10.0.0.1 is refused.
 *   - Redirects are never followed blindly: `fetchPublic` walks them
 *     manually and re-applies the law to every hop.
 *
 * What it does NOT claim: DNS rebinding between resolve and connect is not
 * closed by a policy check (that needs a connect-time pin in the transport);
 * an edge runtime with no resolver only checks literals and names. Both are
 * stated here so no consumer over-claims.
 *
 * Deliberately dependency-free and side-effect-free: the resolver and the
 * fetch are injected, so the same law runs in Node, Vercel edge, and tests.
 */

export type OutboundUrlRefusal =
  | "invalid_url"
  | "scheme_not_allowed"
  | "credentials_in_url"
  | "host_not_public"
  | "resolved_address_not_public"
  | "resolution_failed";

export type OutboundUrlVerdict =
  { ok: true; url: URL } | { ok: false; reason: OutboundUrlRefusal; detail?: string };

export interface OutboundUrlOptions {
  /**
   * Permit loopback + private destinations. ONLY for local development
   * (a personal runtime reading its own localhost dev server). Never set
   * this on a deployed service.
   */
  allowPrivateNetwork?: boolean;
  /**
   * Resolve a hostname to its addresses. Supply `dns.promises.lookup` (all:
   * true) in Node so the resolved addresses are checked too. Absent (edge
   * runtimes), only literals and names are checked — say so in the consumer.
   */
  resolve?: (hostname: string) => Promise<string[]>;
}

// ── IPv4 ────────────────────────────────────────────────────────────────

function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map((p) => Number(p));
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/** Non-global IPv4 per IANA special-purpose registry (the SSRF-relevant set). */
function ipv4IsPublic(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0) return false; // 0.0.0.0/8 "this network"
  if (a === 10) return false; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local incl. metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC 1918
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
  if (a === 192 && b === 168) return false; // RFC 1918
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast + reserved + broadcast
  return true;
}

// ── IPv6 ────────────────────────────────────────────────────────────────

/** Expand an IPv6 literal (no brackets, may carry a zone id) to 8 hextets. */
function parseIPv6(host: string): number[] | null {
  let h = host;
  const zone = h.indexOf("%");
  if (zone !== -1) h = h.slice(0, zone);
  // Embedded IPv4 tail: ::ffff:1.2.3.4 or 64:ff9b::1.2.3.4
  const tail = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (tail) {
    const v4 = parseIPv4(tail[2]!);
    if (!v4) return null;
    h = `${tail[1]}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const toHextets = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const part of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };
  const head = toHextets(halves[0] ?? "");
  const rest = halves.length === 2 ? toHextets(halves[1] ?? "") : [];
  if (head == null || rest == null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

function ipv6IsPublic(h: number[]): boolean {
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const allZeroTo = (n: number) => h.slice(0, n).every((x) => x === 0);
  if (allZeroTo(7) && h7 === 0) return false; // ::
  if (allZeroTo(7) && h7 === 1) return false; // ::1
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (allZeroTo(5) && (h5 === 0xffff || h5 === 0)) {
    return ipv4IsPublic([h6 >> 8, h6 & 0xff, h7 >> 8, h7 & 0xff]);
  }
  // NAT64 well-known prefix 64:ff9b::/96 — embedded v4 must be public too
  if (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    return ipv4IsPublic([h6 >> 8, h6 & 0xff, h7 >> 8, h7 & 0xff]);
  }
  if ((h0 & 0xfe00) === 0xfc00) return false; // fc00::/7 ULA
  if ((h0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((h0 & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (h0 === 0x2001 && h1 === 0x0db8) return false; // documentation
  if (h0 === 0x2002) {
    // 6to4 — embedded v4 must be public
    return ipv4IsPublic([h1 >> 8, h1 & 0xff, h2 >> 8, h2 & 0xff]);
  }
  return true;
}

// ── Names ───────────────────────────────────────────────────────────────

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".localdomain"];
const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "0",
]);

/** Is this literal address (v4 or v6, no brackets) globally routable? */
export function isPublicAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return ipv4IsPublic(v4);
  const v6 = parseIPv6(address);
  if (v6) return ipv6IsPublic(v6);
  return false; // not an address at all
}

function hostIsBlockedName(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTS.has(h)) return true;
  return BLOCKED_HOST_SUFFIXES.some((s) => h.endsWith(s));
}

// ── The law ─────────────────────────────────────────────────────────────

/**
 * Decide whether `raw` may be fetched. Pure except for the injected
 * resolver. Returns the parsed URL on success so callers fetch exactly what
 * was checked (no re-parse drift).
 */
export async function checkOutboundUrl(
  raw: unknown,
  opts: OutboundUrlOptions = {},
): Promise<OutboundUrlVerdict> {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 8192) {
    return { ok: false, reason: "invalid_url" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "scheme_not_allowed", detail: url.protocol };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "credentials_in_url" };
  }
  const hostname = url.hostname; // WHATWG-normalised: IPv4 forms → dotted, IDN → punycode
  if (hostname === "") return { ok: false, reason: "invalid_url" };

  if (!opts.allowPrivateNetwork) {
    const literal = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
    const isLiteral = parseIPv4(literal) != null || parseIPv6(literal) != null;
    if (isLiteral) {
      if (!isPublicAddress(literal)) {
        return { ok: false, reason: "host_not_public", detail: literal };
      }
    } else if (hostIsBlockedName(hostname)) {
      return { ok: false, reason: "host_not_public", detail: hostname };
    } else if (opts.resolve) {
      let addrs: string[];
      try {
        addrs = await opts.resolve(hostname);
      } catch {
        return { ok: false, reason: "resolution_failed", detail: hostname };
      }
      if (addrs.length === 0) return { ok: false, reason: "resolution_failed", detail: hostname };
      const bad = addrs.find((a) => !isPublicAddress(a));
      if (bad != null) {
        return { ok: false, reason: "resolved_address_not_public", detail: `${hostname} → ${bad}` };
      }
    }
  }
  return { ok: true, url };
}

/** Throwing form for call sites that already sit in a try/catch. */
export async function assertOutboundUrl(raw: unknown, opts?: OutboundUrlOptions): Promise<URL> {
  const v = await checkOutboundUrl(raw, opts);
  if (!v.ok) {
    throw new OutboundUrlRefusedError(v.reason, v.detail);
  }
  return v.url;
}

export class OutboundUrlRefusedError extends Error {
  constructor(
    public readonly reason: OutboundUrlRefusal,
    public readonly detail?: string,
  ) {
    super(`outbound url refused: ${reason}${detail ? ` (${detail})` : ""}`);
    this.name = "OutboundUrlRefusedError";
  }
}

// ── Redirect-safe fetch ─────────────────────────────────────────────────

export interface FetchPublicOptions extends OutboundUrlOptions {
  /** Injected fetch (tests, edge). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Max redirect hops re-checked against the law. Default 5. */
  maxRedirects?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * `fetch` that applies the outbound law to the initial URL AND to every
 * redirect hop. Redirects are followed manually (`redirect: "manual"`), so a
 * public URL that 302s into 169.254.169.254 is refused at the hop rather
 * than silently followed by the platform.
 */
export async function fetchPublic(
  raw: string,
  init: RequestInit = {},
  opts: FetchPublicOptions = {},
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRedirects = opts.maxRedirects ?? 5;
  let current = await assertOutboundUrl(raw, opts);
  let method = init.method ?? "GET";
  let body = init.body;
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(current.href, { ...init, method, body, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(res.status)) return res;
    if (hop >= maxRedirects) throw new OutboundUrlRefusedError("invalid_url", "too many redirects");
    const location = res.headers.get("location");
    if (location == null) return res;
    // Resolve relative Locations against the current URL, then re-apply the law.
    current = await assertOutboundUrl(new URL(location, current).href, opts);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
  }
}
