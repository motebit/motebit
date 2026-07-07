/**
 * Release witness — signed observation of the npm registry, verified
 * by the SAME consumer verifier as the transparency declaration (the
 * whole point: one pinned key, one envelope, one verification path).
 */
import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { extractTarEntry, observeReleases, buildSignedReleaseWitness } from "../release-witness.js";
import { verifyTransparencyDeclaration } from "@motebit/state-export-client";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair } from "@motebit/encryption";

/** Build a minimal valid tarball containing the given entries. */
function makeTar(entries: Record<string, string>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, content] of Object.entries(entries)) {
    const data = new TextEncoder().encode(content);
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode(name), 0);
    header.set(new TextEncoder().encode(data.length.toString(8).padStart(11, "0") + "\0"), 124);
    blocks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024)); // end-of-archive
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const tar = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    tar.set(b, off);
    off += b.length;
  }
  return tar;
}

describe("extractTarEntry", () => {
  it("extracts the named entry and returns null for absent/malformed", () => {
    const tar = makeTar({
      "package/dist/index.js": "#!/usr/bin/env node\nhello",
      "package/README.md": "docs",
    });
    expect(new TextDecoder().decode(extractTarEntry(tar, "package/dist/index.js")!)).toContain(
      "hello",
    );
    expect(extractTarEntry(tar, "package/missing.js")).toBeNull();
    expect(extractTarEntry(new Uint8Array(1024), "x")).toBeNull();
  });
});

describe("observeReleases", () => {
  it("witnesses the most recent versions with per-file bundle hashes", async () => {
    const tarball = gzipSync(makeTar({ "package/dist/index.js": "BUNDLE-BYTES-1.8.0" }));
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = url instanceof Request ? url.url : String(url);
      if (u.endsWith("/motebit")) {
        return new Response(
          JSON.stringify({
            versions: {
              "1.8.0": {
                dist: { integrity: "sha512-abc", tarball: "https://reg/motebit-1.8.0.tgz" },
                gitHead: "deadbeef",
              },
            },
            time: { "1.8.0": "2026-07-07T12:00:00Z" },
          }),
        );
      }
      return new Response(tarball);
    }) as typeof fetch;

    const releases = await observeReleases(fetchImpl);
    expect(releases).toHaveLength(1);
    expect(releases[0]!.version).toBe("1.8.0");
    expect(releases[0]!.tarball_integrity).toBe("sha512-abc");
    expect(releases[0]!.git_head).toBe("deadbeef");
    expect(releases[0]!.files["dist/index.js"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails loud when the bundle file is missing from a tarball — never silently skipped", async () => {
    const tarball = gzipSync(makeTar({ "package/README.md": "no bundle here" }));
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = url instanceof Request ? url.url : String(url);
      if (u.endsWith("/motebit")) {
        return new Response(
          JSON.stringify({
            versions: { "1.8.0": { dist: { integrity: "x", tarball: "https://reg/t.tgz" } } },
            time: { "1.8.0": "2026-07-07T12:00:00Z" },
          }),
        );
      }
      return new Response(tarball);
    }) as typeof fetch;
    await expect(observeReleases(fetchImpl)).rejects.toThrow(/missing from motebit@1.8.0/);
  });
});

describe("buildSignedReleaseWitness — one envelope, one verifier", () => {
  it("verifies with the canonical transparency verifier and fails on tamper", async () => {
    const keys = await generateKeypair();
    const identity = {
      relayMotebitId: "relay-test",
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    };
    const witness = await buildSignedReleaseWitness(identity, [
      {
        version: "1.8.0",
        tarball_integrity: "sha512-abc",
        files: { "dist/index.js": "aa".repeat(32) },
      },
    ]);

    const ok = await verifyTransparencyDeclaration(witness as never);
    expect(ok.ok).toBe(true);

    // Tamper with the witnessed hash → the same verifier refuses.
    const tampered = JSON.parse(JSON.stringify(witness));
    tampered.content.releases[0].files["dist/index.js"] = "bb".repeat(32);
    const bad = await verifyTransparencyDeclaration(tampered as never);
    expect(bad.ok).toBe(false);
  });
});
