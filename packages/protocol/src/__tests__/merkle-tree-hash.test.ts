/**
 * Merkle tree-hash version registry tests. Locks the closed vocabulary of
 * tree-hash recipes so a new version can only land via intentional update of
 * both the `MerkleTreeVersion` union and the `MERKLE_TREE_VERSION_REGISTRY`
 * record, and pins the RFC 6962 §2.1 domain-separation tag bytes + the
 * load-bearing absent ⇒ v1 downgrade-safety default.
 */
import { describe, it, expect } from "vitest";
import {
  ALL_MERKLE_TREE_VERSIONS,
  DEFAULT_MERKLE_TREE_VERSION,
  getMerkleTreeVersionEntry,
  isMerkleTreeVersion,
  MERKLE_TREE_VERSION_REGISTRY,
  type MerkleTreeVersion,
} from "../merkle-tree-hash.js";

describe("MERKLE_TREE_VERSION_REGISTRY", () => {
  it("has exactly the two registered entries", () => {
    expect(Object.keys(MERKLE_TREE_VERSION_REGISTRY).length).toBe(2);
    expect(Object.keys(MERKLE_TREE_VERSION_REGISTRY).sort()).toEqual(
      ["merkle-sha256-plain-v1", "merkle-sha256-rfc6962-v2"].sort(),
    );
  });

  it("every entry's id matches its key (no drift)", () => {
    for (const [key, entry] of Object.entries(MERKLE_TREE_VERSION_REGISTRY)) {
      expect(entry.id).toBe(key);
    }
  });

  it("every version ID is URL-safe", () => {
    for (const id of ALL_MERKLE_TREE_VERSIONS) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("every entry has non-empty metadata + valid status", () => {
    for (const entry of Object.values(MERKLE_TREE_VERSION_REGISTRY)) {
      expect(entry.hash).toBe("SHA-256");
      expect(entry.status).toMatch(/^(preferred|allowed|legacy)$/);
      expect(entry.description.length).toBeGreaterThan(20);
    }
  });

  it("v1 is the un-tagged legacy version (no domain separation)", () => {
    const v1 = MERKLE_TREE_VERSION_REGISTRY["merkle-sha256-plain-v1"];
    expect(v1.leafTag).toBeNull();
    expect(v1.nodeTag).toBeNull();
    expect(v1.status).toBe("legacy");
  });

  it("v2 carries the RFC 6962 §2.1 leaf/node tag bytes (0x00 / 0x01)", () => {
    const v2 = MERKLE_TREE_VERSION_REGISTRY["merkle-sha256-rfc6962-v2"];
    expect(v2.leafTag).toBe(0x00);
    expect(v2.nodeTag).toBe(0x01);
    expect(v2.status).toBe("preferred");
  });

  it("is frozen at the top level", () => {
    expect(Object.isFrozen(MERKLE_TREE_VERSION_REGISTRY)).toBe(true);
  });

  it("ALL_MERKLE_TREE_VERSIONS enumerates every key in the registry", () => {
    expect([...ALL_MERKLE_TREE_VERSIONS].sort()).toEqual(
      Object.keys(MERKLE_TREE_VERSION_REGISTRY).sort(),
    );
    expect(Object.isFrozen(ALL_MERKLE_TREE_VERSIONS)).toBe(true);
  });
});

describe("DEFAULT_MERKLE_TREE_VERSION (downgrade safety)", () => {
  it("is v1 — a proof with no tree_hash_version resolves to the un-tagged version, never silently upgraded", () => {
    expect(DEFAULT_MERKLE_TREE_VERSION).toBe("merkle-sha256-plain-v1");
    // The default MUST be the legacy version: every proof minted before the
    // field existed is v1, so absent ⇒ v1 keeps them verifiable. Upgrading the
    // default to v2 would break every pre-existing proof — a regression this
    // test pins against.
    expect(MERKLE_TREE_VERSION_REGISTRY[DEFAULT_MERKLE_TREE_VERSION].status).toBe("legacy");
  });
});

describe("isMerkleTreeVersion", () => {
  it("narrows registered IDs", () => {
    const v: unknown = "merkle-sha256-rfc6962-v2";
    if (isMerkleTreeVersion(v)) {
      const id: MerkleTreeVersion = v;
      expect(id).toBe("merkle-sha256-rfc6962-v2");
    } else {
      throw new Error("isMerkleTreeVersion should have narrowed");
    }
  });

  it("rejects unknown strings + non-strings (fail-closed)", () => {
    expect(isMerkleTreeVersion("merkle-sha256-v3")).toBe(false);
    expect(isMerkleTreeVersion("")).toBe(false);
    expect(isMerkleTreeVersion(0)).toBe(false);
    expect(isMerkleTreeVersion(null)).toBe(false);
    expect(isMerkleTreeVersion(undefined)).toBe(false);
  });
});

describe("getMerkleTreeVersionEntry", () => {
  it("returns the entry for a known ID", () => {
    const entry = getMerkleTreeVersionEntry("merkle-sha256-rfc6962-v2");
    expect(entry.leafTag).toBe(0x00);
    expect(entry.nodeTag).toBe(0x01);
  });

  it("returns undefined for unknown ID strings", () => {
    expect(getMerkleTreeVersionEntry("merkle-sha256-v3")).toBeUndefined();
    expect(getMerkleTreeVersionEntry("")).toBeUndefined();
  });
});
