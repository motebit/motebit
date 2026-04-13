/**
 * Suite registry tests. Locks the closed vocabulary of verification
 * recipes so a new suite can only land via intentional update of both
 * the `SuiteId` union and the `SUITE_REGISTRY` record.
 */
import { describe, it, expect } from "vitest";
import {
  ALL_SUITE_IDS,
  getSuiteEntry,
  isSuiteId,
  SUITE_REGISTRY,
  type SuiteId,
} from "../crypto-suite.js";

describe("SUITE_REGISTRY", () => {
  it("has exactly the five registered entries", () => {
    expect(Object.keys(SUITE_REGISTRY).length).toBe(5);
    expect(Object.keys(SUITE_REGISTRY).sort()).toEqual(
      [
        "eddsa-jcs-2022",
        "motebit-concat-ed25519-hex-v1",
        "motebit-jcs-ed25519-b64-v1",
        "motebit-jcs-ed25519-hex-v1",
        "motebit-jwt-ed25519-v1",
      ].sort(),
    );
  });

  it("every entry's id matches its key (no drift)", () => {
    for (const [key, entry] of Object.entries(SUITE_REGISTRY)) {
      expect(entry.id).toBe(key);
    }
  });

  it("every suite ID is URL-safe (alphanumeric, dashes, no ambiguity)", () => {
    for (const id of ALL_SUITE_IDS) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("every entry has non-empty metadata", () => {
    for (const entry of Object.values(SUITE_REGISTRY)) {
      expect(entry.algorithm).toBeTruthy();
      expect(entry.canonicalization).toBeTruthy();
      expect(entry.signatureEncoding).toBeTruthy();
      expect(entry.publicKeyEncoding).toBeTruthy();
      expect(entry.status).toMatch(/^(preferred|allowed|legacy)$/);
      expect(entry.description.length).toBeGreaterThan(20);
    }
  });

  it("all v1 suites ship as 'preferred'", () => {
    // When PQ suites land this will change; the test documents the
    // current launch state and makes the demotion intentional.
    for (const entry of Object.values(SUITE_REGISTRY)) {
      expect(entry.status).toBe("preferred");
    }
  });

  it("is frozen at the top level", () => {
    expect(Object.isFrozen(SUITE_REGISTRY)).toBe(true);
  });

  it("ALL_SUITE_IDS enumerates every key in the registry", () => {
    expect([...ALL_SUITE_IDS].sort()).toEqual(Object.keys(SUITE_REGISTRY).sort());
    expect(Object.isFrozen(ALL_SUITE_IDS)).toBe(true);
  });
});

describe("isSuiteId", () => {
  it("narrows registered IDs", () => {
    const s: unknown = "motebit-jcs-ed25519-b64-v1";
    if (isSuiteId(s)) {
      const id: SuiteId = s;
      expect(id).toBe("motebit-jcs-ed25519-b64-v1");
    } else {
      throw new Error("isSuiteId should have narrowed");
    }
  });

  it("rejects unknown strings", () => {
    expect(isSuiteId("motebit-jcs-ml-dsa-44-b64-v1")).toBe(false);
    expect(isSuiteId("Ed25519")).toBe(false);
    expect(isSuiteId("")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isSuiteId(42)).toBe(false);
    expect(isSuiteId(null)).toBe(false);
    expect(isSuiteId(undefined)).toBe(false);
    expect(isSuiteId({ id: "motebit-jcs-ed25519-b64-v1" })).toBe(false);
  });
});

describe("getSuiteEntry", () => {
  it("returns the entry for a known ID", () => {
    const entry = getSuiteEntry("motebit-jcs-ed25519-b64-v1");
    expect(entry.algorithm).toBe("Ed25519");
    expect(entry.canonicalization).toBe("jcs");
    expect(entry.signatureEncoding).toBe("base64url");
  });

  it("returns undefined for unknown ID strings", () => {
    expect(getSuiteEntry("motebit-jcs-ml-dsa-44-b64-v1")).toBeUndefined();
    expect(getSuiteEntry("")).toBeUndefined();
  });
});
