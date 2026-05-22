/**
 * resolveReceiptBinding fetches the producer's identity material from the relay
 * so a pasted receipt can climb to pinned/anchored. It TOFU-pins the relay key
 * (transparency declaration), derives the relay Solana address as base58 of that
 * key, fetches the identity bundle, and assembles the verifier options. The
 * contract: a valid round-trip yields a verifier-usable identity (+ an anchor
 * option when the bundle is anchored); ANY relay failure is fail-closed → null.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  base58btcEncode,
  canonicalJson,
  sha256,
  signBySuite,
  verifyKeyBindingAtTime,
} from "@motebit/crypto";
import { resolveReceiptBinding, type IdentityBundle } from "../relay-binding.js";

// Literal member of crypto's SuiteId union — avoids a test-only @motebit/protocol dep.
const SUITE = "motebit-jcs-ed25519-hex-v1" as const;
const RELAY = "https://relay.example.com";

let relayPub: Uint8Array;
let relayPubHex: string;
let relayPriv: Uint8Array;
let motebitKeyHex: string;

beforeAll(async () => {
  const relay = await generateKeypair();
  relayPub = relay.publicKey;
  relayPubHex = bytesToHex(relay.publicKey);
  relayPriv = relay.privateKey;
  motebitKeyHex = bytesToHex((await generateKeypair()).publicKey);
});

async function signedDeclaration(): Promise<unknown> {
  const payload = {
    spec: "motebit-transparency/draft-2026-04-14",
    declared_at: 1736500000000,
    relay_id: "relay-r",
    relay_public_key: relayPubHex,
    content: { purpose: "test", retention: "none" },
  };
  const canonical = new TextEncoder().encode(canonicalJson(payload));
  return {
    ...payload,
    hash: bytesToHex(await sha256(canonical)),
    suite: SUITE,
    signature: bytesToHex(await signBySuite(SUITE, canonical, relayPriv)),
  };
}

function bundle(anchored: IdentityBundle["anchored"]): IdentityBundle {
  return {
    motebit_id: "mote-x",
    created_at: new Date(1000).toISOString(),
    current_public_key: motebitKeyHex,
    succession: [],
    anchored,
  };
}

interface RouteOpts {
  declStatus?: number;
  bundleStatus?: number;
  bundleBody?: unknown;
  bundleThrows?: boolean;
}

async function routedFetch(
  bundleObj: IdentityBundle,
  opts: RouteOpts = {},
): Promise<typeof globalThis.fetch> {
  const decl = await signedDeclaration();
  // The verifier only ever calls fetch with string URLs, so narrow the mock's
  // param to string (avoids no-base-to-string on RequestInfo).
  return (async (url: string) => {
    if (url.includes("/.well-known/motebit-transparency.json")) {
      if (opts.declStatus !== undefined && opts.declStatus !== 200)
        return new Response("x", { status: opts.declStatus });
      return new Response(JSON.stringify(decl), { status: 200 });
    }
    if (url.includes("/api/v1/identity/")) {
      if (opts.bundleThrows) throw new Error("connection reset");
      if (opts.bundleStatus !== undefined && opts.bundleStatus !== 200)
        return new Response("x", { status: opts.bundleStatus });
      return new Response(JSON.stringify(opts.bundleBody ?? bundleObj), { status: 200 });
    }
    return new Response("?", { status: 500 });
  }) as unknown as typeof globalThis.fetch;
}

const ANCHORED: IdentityBundle["anchored"] = {
  proof: { index: 0, siblings: [], layerSizes: [1], anchoredRoot: "ab".repeat(32) },
  tx_hash: "anchor-tx-hash",
  network: "mainnet-beta",
};

describe("resolveReceiptBinding", () => {
  it("anchored bundle → identity + anchor; relay address is base58 of the pinned key", async () => {
    const fetch = await routedFetch(bundle(ANCHORED));
    const r = await resolveReceiptBinding({ relayBase: RELAY, motebitId: "mote-x", fetch });
    expect(r).not.toBeNull();
    expect(r!.identity.motebit_id).toBe("mote-x");
    expect(r!.identity.identity.public_key).toBe(motebitKeyHex);
    expect(r!.anchor).toBeDefined();
    expect(r!.anchor!.proof.anchoredRoot).toBe("ab".repeat(32));
    expect(r!.anchor!.relayAnchorAddress).toBe(base58btcEncode(relayPub));

    // The reconstructed identity is verifier-usable: the current key binds at a
    // time after created_at.
    const bound = await verifyKeyBindingAtTime(r!.identity, motebitKeyHex, 2000);
    expect(bound.bound).toBe(true);
  });

  it("forwards a Solana RPC override into the anchor lookup options", async () => {
    const fetch = await routedFetch(bundle(ANCHORED));
    const r = await resolveReceiptBinding({
      relayBase: RELAY,
      motebitId: "mote-x",
      fetch,
      solanaRpc: "https://my.rpc",
    });
    expect(r!.anchor!.lookup?.rpcUrl).toBe("https://my.rpc");
  });

  it("un-anchored bundle → identity only, no anchor (honest pinned-at-best)", async () => {
    const fetch = await routedFetch(bundle(null));
    const r = await resolveReceiptBinding({ relayBase: RELAY, motebitId: "mote-x", fetch });
    expect(r).not.toBeNull();
    expect(r!.anchor).toBeUndefined();
    expect(r!.identity.motebit_id).toBe("mote-x");
  });

  it("fail-closed when the transparency anchor can't be fetched", async () => {
    const fetch = await routedFetch(bundle(ANCHORED), { declStatus: 404 });
    expect(
      await resolveReceiptBinding({ relayBase: RELAY, motebitId: "mote-x", fetch }),
    ).toBeNull();
  });

  it("fail-closed when the identity bundle 404s", async () => {
    const fetch = await routedFetch(bundle(ANCHORED), { bundleStatus: 404 });
    expect(
      await resolveReceiptBinding({ relayBase: RELAY, motebitId: "mote-x", fetch }),
    ).toBeNull();
  });

  it("fail-closed on a malformed bundle body", async () => {
    const fetch = await routedFetch(bundle(ANCHORED), { bundleBody: { not: "a bundle" } });
    expect(
      await resolveReceiptBinding({ relayBase: RELAY, motebitId: "mote-x", fetch }),
    ).toBeNull();
  });

  it("fail-closed when the bundle fetch throws (relay drops mid-request)", async () => {
    const fetch = await routedFetch(bundle(ANCHORED), { bundleThrows: true });
    expect(
      await resolveReceiptBinding({ relayBase: RELAY, motebitId: "mote-x", fetch }),
    ).toBeNull();
  });
});
