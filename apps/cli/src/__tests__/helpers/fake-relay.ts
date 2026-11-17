/**
 * A fake relay for the per-relay key tests: a real HTTP server on 127.0.0.1
 * (so a redirect, if followed, really succeeds) with an ephemeral Ed25519
 * key, serving the two documents a key is established from — signed
 * discovery metadata and a signed transparency declaration — plus the two
 * endpoints `motebit register` calls. Every request is logged; any path can
 * be overridden or given a side effect that runs before the answer.
 *
 * Nothing leaves the machine and no money moves.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { bytesToHex, canonicalJson, generateKeypair, hash, signBySuite } from "@motebit/crypto";

const SUITE = "motebit-jcs-ed25519-hex-v1" as const;

export const METADATA_PATH = "/.well-known/motebit.json";
export const DECLARATION_PATH = "/.well-known/motebit-transparency.json";

export interface RelayIdentity {
  /** 64 hex characters, lowercase. */
  hex: string;
  privateKey: Uint8Array;
}

export async function newRelayIdentity(): Promise<RelayIdentity> {
  const kp = await generateKeypair();
  return { hex: bytesToHex(kp.publicKey), privateKey: kp.privateKey };
}

/** Relay metadata signed by `relay`; `overrides` are applied BEFORE signing. */
export async function signMetadata(
  relay: RelayIdentity,
  endpointUrl: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const body = {
    protocol_version: "1.0",
    relay_id: "relay-under-test",
    public_key: relay.hex,
    endpoint_url: endpointUrl,
    suite: SUITE,
    ...overrides,
  };
  const signature = bytesToHex(
    await signBySuite(SUITE, new TextEncoder().encode(canonicalJson(body)), relay.privateKey),
  );
  return { ...body, signature };
}

/** A transparency declaration signed by `relay`; `overrides` are applied BEFORE signing. */
export async function signDeclaration(
  relay: RelayIdentity,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const payload = {
    spec: "motebit-transparency/1.0",
    declared_at: 1_790_000_000_000,
    relay_id: "relay-under-test",
    relay_public_key: relay.hex,
    content: { posture: "test" },
    ...overrides,
  };
  const canonical = new TextEncoder().encode(canonicalJson(payload));
  return {
    ...payload,
    hash: await hash(canonical),
    suite: SUITE,
    signature: bytesToHex(await signBySuite(SUITE, canonical, relay.privateKey)),
  };
}

/**
 * The raw JSON body of a declaration whose `content` is arrays nested
 * `depth` deep. It parses, and it has every field a declaration has, naming
 * `relay`'s key and relay id — but canonicalising it overflows the stack, so
 * the verifier THROWS on it instead of returning a verdict. It cannot be
 * signed for the same reason; nothing gets as far as its signature.
 */
export function deeplyNestedDeclarationBody(relay: RelayIdentity, depth = 200_000): string {
  const fields = JSON.stringify({
    spec: "motebit-transparency/1.0",
    declared_at: 1_790_000_000_000,
    relay_id: "relay-under-test",
    relay_public_key: relay.hex,
    hash: "00".repeat(32),
    suite: SUITE,
    signature: "00".repeat(64),
  });
  return `${fields.slice(0, -1)},"content":${"[".repeat(depth)}${"]".repeat(depth)}}`;
}

/** Send a raw JSON body (one `JSON.stringify` could not produce). */
export function sendRawJson(res: ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
}

type Route = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface FakeRelay {
  /** `http://127.0.0.1:<port>` — the URL this relay is named by (and signs, by default). */
  base: string;
  identity: RelayIdentity;
  /** Every request received, as `METHOD path`, in order. */
  requests: string[];
  /** How many times `path` was requested (any method). */
  count(path: string): number;
  /**
   * Replace the answer for `path`: a string matches the request URL exactly
   * or its path without the query; a RegExp is tested against the whole URL.
   */
  route(path: string | RegExp, handler: Route): void;
  /** Run `effect` each time `path` is requested, BEFORE it is answered. */
  before(path: string, effect: () => void | Promise<void>): void;
  close(): Promise<void>;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export interface FakeRelayOptions {
  identity?: RelayIdentity;
  /**
   * The `endpoint_url` the relay signs, given its own base URL. Default: the
   * base itself (a relay that signs the URL it is reached at). Return `""`
   * for a relay that signs no URL.
   */
  signs?: (base: string) => string;
  /** Overrides applied to the metadata before signing. */
  metadata?: Record<string, unknown>;
  /** Overrides applied to the declaration before signing. */
  declaration?: Record<string, unknown>;
  /** A path prefix the relay lives under (e.g. `/a`), for two relays on one host. */
  prefix?: string;
}

const open: Server[] = [];

/** Start a fake relay. `closeFakeRelays()` (afterEach) stops every one. */
export async function startFakeRelay(opts: FakeRelayOptions = {}): Promise<FakeRelay> {
  const identity = opts.identity ?? (await newRelayIdentity());
  const prefix = opts.prefix ?? "";
  const routes = new Map<string, Route>();
  const patterns: Array<[RegExp, Route]> = [];
  const effects = new Map<string, () => void | Promise<void>>();
  const requests: string[] = [];
  let base = "";

  const server = createServer((req, res) => {
    const path = req.url ?? "";
    requests.push(`${req.method ?? "GET"} ${path}`);
    void (async () => {
      try {
        await effects.get(path)?.();
        const custom = routes.get(path) ?? routes.get(path.split("?")[0]!);
        if (custom != null) return await custom(req, res);
        for (const [pattern, handler] of patterns) {
          if (pattern.test(path)) return await handler(req, res);
        }
        if (path === `${prefix}${METADATA_PATH}`) {
          const signed = opts.signs != null ? opts.signs(base) : `${base}${prefix}`;
          return sendJson(res, 200, await signMetadata(identity, signed, opts.metadata));
        }
        if (path === `${prefix}${DECLARATION_PATH}`) {
          return sendJson(res, 200, await signDeclaration(identity, opts.declaration));
        }
        if (path === `${prefix}/api/v1/agents/bootstrap`) {
          return sendJson(res, 200, { registered: true });
        }
        if (path === `${prefix}/health`) return sendJson(res, 200, { ok: true });
        sendJson(res, 404, { error: "not found" });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
    })();
  });
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    identity,
    requests,
    count: (path) => requests.filter((r) => r.endsWith(` ${path}`)).length,
    route: (path, handler) =>
      void (typeof path === "string" ? routes.set(path, handler) : patterns.push([path, handler])),
    before: (path, effect) => void effects.set(path, effect),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Stop every fake relay started since the last call. */
export async function closeFakeRelays(): Promise<void> {
  await Promise.all(
    open.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
}

/** A localhost URL nothing listens at. */
export async function deadUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return url;
}
