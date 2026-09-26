/**
 * A browser hands page JS only the CORS-safelisted response headers unless
 * the response names the rest in `Access-Control-Expose-Headers`. The
 * relay's 429 `Retry-After` and the state-export `X-Motebit-Content-Manifest`
 * are not safelisted, so without the expose list web and desktop (Tauri
 * webview fetch) read them as `null` — the roster clients' 429 bound was
 * inert there, and browser manifest verification read "no manifest".
 *
 * Driven through the REAL app middleware stack (`createSyncRelay`), with an
 * `Origin` header, the way a browser sends it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "../index.js";
import type { SyncRelay } from "../index.js";
import { CORS_EXPOSED_RESPONSE_HEADERS } from "../middleware.js";
import { RateLimitError } from "../errors.js";

const ORIGIN = "https://motebit.com";
const ROSTER = "/api/v1/agents/019a0000-0000-7000-8000-000000000001/roster";

function exposed(res: Response): string[] {
  return (res.headers.get("access-control-expose-headers") ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
}

describe("CORS: headers a browser client reads are exposed", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createSyncRelay({
      allowPrivateEndpoints: true,
      apiToken: "test-token",
      x402: {
        payToAddress: "0x0000000000000000000000000000000000000000",
        network: "eip155:84532",
        testnet: true,
      },
      enableDeviceAuth: true,
    });
  });

  afterEach(async () => {
    await relay.close();
  });

  it("a browser-origin roster request driven to 429 can read Retry-After", async () => {
    let res: Response | undefined;
    // The roster route is on the write limiter (30/min per IP).
    for (let i = 0; i < 40; i++) {
      res = await relay.app.request(ROSTER, { headers: { Origin: ORIGIN } });
      if (res.status === 429) break;
    }
    expect(res?.status).toBe(429);
    expect(Number(res!.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(res!.headers.get("access-control-allow-origin")).toBe("*");
    expect(exposed(res!)).toContain("retry-after");
  });

  it("every response carries the full list, including X-Motebit-Content-Manifest", async () => {
    // An unauthenticated roster read is refused through the error handler:
    // the list rides that path too.
    const res = await relay.app.request(ROSTER, { headers: { Origin: ORIGIN } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const list = exposed(res);
    for (const h of CORS_EXPOSED_RESPONSE_HEADERS) expect(list).toContain(h.toLowerCase());
    expect(list).toContain("x-motebit-content-manifest");
  });

  it("a RateLimitError thrown into onError still lets a browser read Retry-After", async () => {
    // No production door throws it today; the error handler sets
    // Retry-After for any that does. Mounted AFTER the real middleware, so
    // it runs behind the real CORS layer and ends in the real onError.
    relay.app.get("/__test/throws-rate-limit", () => {
      throw new RateLimitError("slow down", 42);
    });
    const res = await relay.app.request("/__test/throws-rate-limit", {
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(exposed(res)).toContain("retry-after");
  });

  it("preflight is otherwise unchanged: 204, any origin, the default methods", async () => {
    const res = await relay.app.request(ROSTER, {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const methods = (res.headers.get("access-control-allow-methods") ?? "").toUpperCase();
    for (const m of ["GET", "POST", "PUT", "DELETE", "PATCH"]) expect(methods).toContain(m);
    // Hono echoes the requested headers when none are configured.
    expect((res.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain(
      "authorization",
    );
  });
});
