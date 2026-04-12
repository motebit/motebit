/**
 * Admin endpoint auth parity — every /api/v1/admin/* route must require the
 * master bearer token. Encodes the sibling boundary rule so a new admin
 * endpoint cannot be added without explicit auth wiring.
 *
 * Add new admin endpoints to ADMIN_ENDPOINTS below. Missing entries are the
 * drift we are defending against.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";

/** Every admin endpoint, paired with the HTTP method it accepts. */
const ADMIN_ENDPOINTS: ReadonlyArray<{ method: "GET" | "POST"; path: string }> = [
  { method: "GET", path: "/api/v1/admin/disputes" },
  { method: "GET", path: "/api/v1/admin/settlements" },
  { method: "GET", path: "/api/v1/admin/credential-anchoring" },
  { method: "POST", path: "/api/v1/admin/freeze" },
  { method: "POST", path: "/api/v1/admin/unfreeze" },
  { method: "GET", path: "/api/v1/admin/reconciliation" },
];

describe("admin auth parity", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });

  afterEach(async () => {
    await relay.close();
  });

  for (const { method, path } of ADMIN_ENDPOINTS) {
    it(`${method} ${path} rejects unauthenticated requests`, async () => {
      const res = await relay.app.request(path, { method });
      expect(res.status).toBe(401);
    });

    it(`${method} ${path} rejects wrong bearer token`, async () => {
      const res = await relay.app.request(path, {
        method,
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    });

    it(`${method} ${path} accepts correct bearer token`, async () => {
      const res = await relay.app.request(path, {
        method,
        headers: AUTH_HEADER,
      });
      // Any non-401 is acceptable — the endpoint may legitimately 400/404/405
      // for missing body/params. The invariant is: auth is enforced before
      // the handler runs.
      expect(res.status).not.toBe(401);
    });
  }
});
