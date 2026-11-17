/**
 * A relay key is established only for the URL that key signs.
 *
 * `relayPinKey` is the comparable form of a relay URL; `verifyRelayMetadataForUrl`
 * establishes a key for a URL from the relay's signed discovery metadata, and
 * refuses a document signed for any other URL. Ephemeral keys; every relay is
 * a real HTTP server on 127.0.0.1 (so a redirect, if followed, would really
 * succeed); the default five-second timeout is driven by a fake clock.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToHex, canonicalJson, generateKeypair, signBySuite } from "@motebit/crypto";
import { relayPinKey, verifyRelayMetadataForUrl } from "../relay-key-pin.js";

const SUITE = "motebit-jcs-ed25519-hex-v1" as const;

interface RelayIdentity {
  hex: string;
  privateKey: Uint8Array;
}

async function newRelay(): Promise<RelayIdentity> {
  const kp = await generateKeypair();
  return { hex: bytesToHex(kp.publicKey), privateKey: kp.privateKey };
}

/** Relay metadata signed by `relay`, with `overrides` applied BEFORE signing. */
async function signedMetadata(
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

type Handler = (req: IncomingMessage, res: ServerResponse, base: string) => void;

const servers: Server[] = [];

/** A real HTTP server on 127.0.0.1; `handler` gets the server's own base URL. */
async function serve(handler: Handler): Promise<{ base: string; paths: string[] }> {
  const paths: string[] = [];
  let base = "";
  const server = createServer((req, res) => {
    paths.push(req.url ?? "");
    handler(req, res, base);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, paths };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const METADATA = "/.well-known/motebit.json";

/** A server whose metadata is built from its own base URL. */
function serveMetadata(
  build: (base: string) => Promise<unknown>,
): Promise<{ base: string; paths: string[] }> {
  return serve((req, res, base) => {
    if (req.url !== METADATA) return json(res, 404, {});
    void build(base).then((doc) => json(res, 200, doc));
  });
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});

describe("relayPinKey (design test 1)", () => {
  it("one key for a trailing slash, host case, :443, IDN and dot segments", () => {
    const key = "https://relay.example/a";
    for (const spelling of [
      "https://relay.example/a",
      "https://relay.example/a/",
      "https://relay.example/a///",
      "https://RELAY.Example/a",
      "https://relay.example:443/a",
      "https://relay.example/x/../a",
      "https://relay.example/./a/",
    ]) {
      expect(relayPinKey(spelling), spelling).toBe(key);
    }
    expect(relayPinKey("https://relay.example")).toBe("https://relay.example");
    expect(relayPinKey("https://relay.example/")).toBe("https://relay.example");
    expect(relayPinKey("https://BÜCHER.example")).toBe("https://xn--bcher-kva.example");
    expect(relayPinKey("https://xn--bcher-kva.example/")).toBe("https://xn--bcher-kva.example");
    expect(relayPinKey("http://relay.example:80")).toBe("http://relay.example");
  });

  it("different paths on one host get different keys", () => {
    const a = relayPinKey("https://relay.example/a");
    const b = relayPinKey("https://relay.example/b");
    const root = relayPinKey("https://relay.example");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    expect(a).not.toBe(root);
    expect(relayPinKey("http://relay.example")).not.toBe(relayPinKey("https://relay.example"));
    expect(relayPinKey("https://relay.example:8443")).not.toBe(root);
  });

  it("spellings the parser does not unify stay distinct (fails toward no pin)", () => {
    expect(relayPinKey("http://localhost:3000")).not.toBe(relayPinKey("http://127.0.0.1:3000"));
  });

  it("null for a backslash", () => {
    expect(relayPinKey("https://relay.example\\a")).toBeNull();
    expect(relayPinKey("https:\\\\relay.example")).toBeNull();
  });

  it("null for `?` and `#`, including empty ones", () => {
    for (const u of [
      "https://relay.example?x=1",
      "https://relay.example/?",
      "https://relay.example?",
      "https://relay.example#frag",
      "https://relay.example#",
      "https://relay.example/a#",
    ]) {
      expect(relayPinKey(u), u).toBeNull();
    }
  });

  it("null for `@` anywhere: userinfo, empty userinfo, and in the path", () => {
    for (const u of [
      "https://user@relay.example",
      "https://user:pw@relay.example",
      "https://@relay.example",
      "https://:@relay.example",
      "https://relay.example/@x",
    ]) {
      expect(relayPinKey(u), u).toBeNull();
    }
  });

  it("null for whitespace and control characters", () => {
    for (const u of [
      " https://relay.example",
      "https://relay.example ",
      "https://relay.example/a b",
      "https://relay.example/a\tb",
      "https://relay.example/a\nb",
      "https://relay.example/\u0000",
      "https://relay.example/\u007f",
    ]) {
      expect(relayPinKey(u), JSON.stringify(u)).toBeNull();
    }
  });

  it("null for a scheme that is not http(s), and for what does not parse", () => {
    for (const u of [
      "ftp://relay.example",
      "ws://relay.example",
      "file:///etc/passwd",
      "",
      "relay.example",
      "https://",
      "http://[::1",
    ]) {
      expect(relayPinKey(u), JSON.stringify(u)).toBeNull();
    }
  });
});

describe("verifyRelayMetadataForUrl (design test 2, the metadata reasons)", () => {
  it("establishes the key for the URL the relay signs, lowercased, with its relay id", async () => {
    const relay = await newRelay();
    const { base, paths } = await serveMetadata((b) =>
      signedMetadata(relay, `${b}/`, { public_key: relay.hex.toUpperCase() }),
    );
    const result = await verifyRelayMetadataForUrl(`${base}/`);
    expect(result).toEqual({ ok: true, publicKey: relay.hex, relayId: "relay-under-test" });
    expect(paths).toEqual([METADATA]);
  });

  it("unpinnable_url: a URL with no pin key makes no request", async () => {
    const fetchImpl = vi.fn();
    const result = await verifyRelayMetadataForUrl("http://127.0.0.1:1/?x=1", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: "unpinnable_url" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("unreachable: nothing listens at the address", async () => {
    const { base } = await serve((_req, res) => json(res, 200, {}));
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await verifyRelayMetadataForUrl(base)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("unreachable: no answer within the timeout — five seconds by default", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      })) as unknown as typeof fetch;
    let settled: unknown = null;
    const pending = verifyRelayMetadataForUrl("http://127.0.0.1:9", { fetchImpl }).then((r) => {
      settled = r;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(aborted).toBe(false);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(aborted).toBe(true);
    expect(settled).toEqual({ ok: false, reason: "unreachable" });
  });

  it("unreachable: `timeoutMs` shortens the wait (a server that never answers)", async () => {
    const { base } = await serve(() => {
      /* never answers */
    });
    const started = Date.now();
    const result = await verifyRelayMetadataForUrl(base, { timeoutMs: 40 });
    expect(result).toEqual({ ok: false, reason: "unreachable" });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("redirect_refused: a redirect is not followed, even to a document that would pass", async () => {
    const relay = await newRelay();
    const { base, paths } = await serve((req, res, b) => {
      if (req.url === METADATA) {
        res.writeHead(302, { Location: `${b}/moved.json` });
        res.end();
        return;
      }
      if (req.url === "/moved.json") {
        void signedMetadata(relay, b).then((doc) => json(res, 200, doc));
        return;
      }
      json(res, 404, {});
    });
    // Following it WOULD succeed: the target serves this URL's valid metadata.
    const followed = await fetch(`${base}${METADATA}`);
    expect(followed.ok).toBe(true);
    paths.length = 0;

    expect(await verifyRelayMetadataForUrl(base)).toEqual({
      ok: false,
      reason: "redirect_refused",
    });
    expect(paths).toEqual([METADATA]);
  });

  it("metadata_unavailable: answered, but not with the document (non-2xx)", async () => {
    const { base } = await serve((_req, res) => json(res, 404, { error: "nope" }));
    expect(await verifyRelayMetadataForUrl(base)).toEqual({
      ok: false,
      reason: "metadata_unavailable",
    });
  });

  it("metadata_unavailable: not JSON, not an object, or missing fields", async () => {
    const relay = await newRelay();
    const notJson = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>hello</html>");
    });
    const notObject = await serve((_req, res) => json(res, 200, ["a"]));
    const noKey = await serveMetadata(async (b) => {
      const doc = await signedMetadata(relay, b);
      delete doc["public_key"];
      return doc;
    });
    const noRelayId = await serveMetadata((b) => signedMetadata(relay, b, { relay_id: "" }));
    for (const { base } of [notJson, notObject, noKey, noRelayId]) {
      expect(await verifyRelayMetadataForUrl(base)).toEqual({
        ok: false,
        reason: "metadata_unavailable",
      });
    }
  });

  it("malformed_key: `public_key` is not 64 hex characters", async () => {
    const relay = await newRelay();
    const { base } = await serveMetadata((b) =>
      signedMetadata(relay, b, { public_key: relay.hex.slice(0, 62) }),
    );
    expect(await verifyRelayMetadataForUrl(base)).toEqual({ ok: false, reason: "malformed_key" });
  });

  it("bad_signature: the document does not verify under the key it names", async () => {
    const relay = await newRelay();
    const other = await newRelay();
    // Signed by `other`, naming `relay`'s key: valid in every other respect.
    const { base } = await serveMetadata(async (b) => {
      const doc = await signedMetadata(other, b, { public_key: relay.hex });
      return doc;
    });
    expect(await verifyRelayMetadataForUrl(base)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("bad_signature, never a throw: metadata nested so deeply that canonicalising it overflows the stack", async () => {
    const relay = await newRelay();
    const depth = 200_000;
    const { base } = await serve((_req, res, b) => {
      const fields = JSON.stringify({
        protocol_version: "1.0",
        relay_id: "relay-under-test",
        public_key: relay.hex,
        endpoint_url: b,
        suite: SUITE,
        signature: "00".repeat(64),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(`${fields.slice(0, -1)},"capabilities":${"[".repeat(depth)}${"]".repeat(depth)}}`);
    });
    await expect(verifyRelayMetadataForUrl(base)).resolves.toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("endpoint_empty: the relay signs no URL", async () => {
    const relay = await newRelay();
    const { base } = await serveMetadata(() => signedMetadata(relay, ""));
    expect(await verifyRelayMetadataForUrl(base)).toEqual({ ok: false, reason: "endpoint_empty" });
  });

  it("endpoint_mismatch: the relay signs another URL, and the result carries its pin key", async () => {
    const relay = await newRelay();
    const { base } = await serveMetadata(() =>
      signedMetadata(relay, "https://Relay.Elsewhere.example:443/"),
    );
    expect(await verifyRelayMetadataForUrl(base)).toEqual({
      ok: false,
      reason: "endpoint_mismatch",
      signedPinKey: "https://relay.elsewhere.example",
    });
  });

  it("endpoint_mismatch: a signed value with no pin key carries null", async () => {
    const relay = await newRelay();
    const { base } = await serveMetadata(() => signedMetadata(relay, "not a url"));
    expect(await verifyRelayMetadataForUrl(base)).toEqual({
      ok: false,
      reason: "endpoint_mismatch",
      signedPinKey: null,
    });
  });
});

describe("a server holding only copies of relay A's documents (design test 3)", () => {
  it("B, on A's host under another path, serving A's metadata: endpoint_mismatch naming the URL A signed", async () => {
    const relayA = await newRelay();
    // One host. A lives at /a and signs /a; B lives at /b and serves A's bytes.
    const { base } = await serve((req, res, b) => {
      if (req.url === `/a${METADATA}` || req.url === `/b${METADATA}`) {
        void signedMetadata(relayA, `${b}/a`).then((doc) => json(res, 200, doc));
        return;
      }
      json(res, 404, {});
    });

    expect(await verifyRelayMetadataForUrl(`${base}/a`)).toEqual({
      ok: true,
      publicKey: relayA.hex,
      relayId: "relay-under-test",
    });
    expect(await verifyRelayMetadataForUrl(`${base}/b`)).toEqual({
      ok: false,
      reason: "endpoint_mismatch",
      signedPinKey: `${base}/a`,
    });
  });
});
