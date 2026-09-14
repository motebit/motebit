/**
 * The daemon authenticates to its relay as itself — never with the operator's
 * master token, never unauthenticated.
 */

import { describe, it, expect, vi } from "vitest";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex, verifySignedToken } from "@motebit/encryption";
import { registerWithRelay } from "../relay-registration.js";

interface Call {
  url: string;
  init: RequestInit;
}

function relayMock(status: (url: string) => number = () => 200): {
  calls: Call[];
  fetchImpl: typeof fetch;
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), {
      status: status(url),
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const bearer = (c: Call): string | undefined =>
  (c.init.headers as Record<string, string> | undefined)?.Authorization?.replace(/^Bearer /, "");

describe("registerWithRelay — the daemon's relay credential is its own key", () => {
  async function identity() {
    const kp = await generateKeypair();
    return {
      motebitId: "mote-daemon",
      deviceId: "dev-1",
      publicKeyHex: bytesToHex(kp.publicKey),
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    };
  }

  it("bootstraps publicly, then registers, lists, heartbeats and deregisters with per-audience self-signed tokens", async () => {
    const id = await identity();
    const { calls, fetchImpl } = relayMock();
    const logs: string[] = [];
    const handle = await registerWithRelay({
      syncUrl: "http://relay.test/",
      identity: id,
      registration: { motebit_id: id.motebitId, endpoint_url: "ws://x", capabilities: ["echo"] },
      toolNames: ["echo"],
      price: "0.25",
      description: "daemon",
      log: (m) => logs.push(m),
      heartbeatMs: 40,
      fetchImpl,
      env: {},
    });
    expect(handle.registered).toBe(true);

    const byUrl = (needle: string) => calls.filter((c) => c.url.includes(needle));
    // Bootstrap first, unauthenticated, introducing the public key.
    expect(calls[0]!.url).toBe("http://relay.test/api/v1/agents/bootstrap");
    expect(bearer(calls[0]!)).toBeUndefined();
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      motebit_id: "mote-daemon",
      device_id: "dev-1",
      public_key: id.publicKeyHex,
    });

    // Register + listing carry tokens signed by OUR key, bound per audience.
    const reg = await verifySignedToken(bearer(byUrl("/agents/register")[0]!)!, id.publicKey);
    expect(reg?.aud).toBe("admin:query");
    expect(reg?.mid).toBe("mote-daemon");
    const listing = await verifySignedToken(bearer(byUrl("/listing")[0]!)!, id.publicKey);
    expect(listing?.aud).toBe("market:listing");

    // Heartbeats re-mint: wait for at least two ticks; distinct tokens (fresh jti each).
    await vi.waitFor(() => expect(byUrl("/agents/heartbeat").length).toBeGreaterThanOrEqual(2), {
      timeout: 2000,
      interval: 10,
    });
    const hbs = byUrl("/agents/heartbeat");
    expect(bearer(hbs[0]!)).not.toBe(bearer(hbs[1]!));
    const hb = await verifySignedToken(bearer(hbs[1]!)!, id.publicKey);
    expect(hb?.aud).toBe("admin:query");

    await handle.deregister();
    const dereg = byUrl("/agents/deregister")[0]!;
    expect(dereg.init.method).toBe("DELETE");
    expect((await verifySignedToken(bearer(dereg)!, id.publicKey))?.aud).toBe("admin:query");
    // Stopped: no further heartbeats.
    const after = byUrl("/agents/heartbeat").length;
    await new Promise((r) => setTimeout(r, 150));
    expect(byUrl("/agents/heartbeat").length).toBe(after);

    // No request anywhere carried a static secret.
    for (const c of calls) {
      const b = bearer(c);
      if (b != null) expect(b.split(".").length).toBeGreaterThanOrEqual(2);
    }
    expect(logs.join("\n")).toContain("registered with relay");
    expect(logs.join("\n")).toContain("earning enabled");
  });

  it("skips the listing without a price and warns on an invalid one", async () => {
    const id = await identity();
    const a = relayMock();
    await registerWithRelay({
      syncUrl: "http://relay.test",
      identity: id,
      registration: {},
      toolNames: ["echo"],
      description: "d",
      log: () => {},
      fetchImpl: a.fetchImpl,
      env: {},
    });
    expect(a.calls.some((c) => c.url.includes("/listing"))).toBe(false);

    const b = relayMock();
    const logs: string[] = [];
    await registerWithRelay({
      syncUrl: "http://relay.test",
      identity: id,
      registration: {},
      toolNames: ["echo"],
      price: "free",
      description: "d",
      log: (m) => logs.push(m),
      fetchImpl: b.fetchImpl,
      env: {},
    });
    expect(b.calls.some((c) => c.url.includes("/listing"))).toBe(false);
    expect(logs.join("\n")).toContain("not a valid positive number");
  });

  it("refuses to continue when bootstrap says the id is bound to a different key (409)", async () => {
    const id = await identity();
    const { calls, fetchImpl } = relayMock((url) => (url.includes("/bootstrap") ? 409 : 200));
    const logs: string[] = [];
    const handle = await registerWithRelay({
      syncUrl: "http://relay.test",
      identity: id,
      registration: {},
      toolNames: [],
      description: "d",
      log: (m) => logs.push(m),
      fetchImpl,
      env: {},
    });
    expect(handle.registered).toBe(false);
    expect(calls.some((c) => c.url.includes("/agents/register"))).toBe(false);
    expect(logs.join("\n")).toContain("DIFFERENT key");
  });

  it("reports a refused registration and returns an inert handle", async () => {
    const id = await identity();
    const { calls, fetchImpl } = relayMock((url) => (url.includes("/register") ? 401 : 200));
    const logs: string[] = [];
    const handle = await registerWithRelay({
      syncUrl: "http://relay.test",
      identity: id,
      registration: {},
      toolNames: [],
      price: "1",
      description: "d",
      log: (m) => logs.push(m),
      fetchImpl,
      env: {},
    });
    expect(handle.registered).toBe(false);
    expect(logs.join("\n")).toContain("returned 401");
    expect(calls.some((c) => c.url.includes("/listing"))).toBe(false);
    await handle.deregister(); // inert, no throw
    expect(calls.some((c) => c.url.includes("/deregister"))).toBe(false);
  });

  it("an unreachable relay is a logged skip, not a crash", async () => {
    const id = await identity();
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const logs: string[] = [];
    const handle = await registerWithRelay({
      syncUrl: "http://relay.test",
      identity: id,
      registration: {},
      toolNames: [],
      description: "d",
      log: (m) => logs.push(m),
      fetchImpl,
      env: {},
    });
    expect(handle.registered).toBe(false);
    expect(logs.join("\n")).toContain("ECONNREFUSED");
  });
});
