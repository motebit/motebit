/**
 * Release witness — the operator-transparency domain extended to the
 * published artifact (docs/doctrine/operator-transparency.md;
 * docs/doctrine/self-attesting-system.md).
 *
 * The `motebit` npm package ships the whole workspace inlined into one
 * bundled file. That is the right shape for a money-path application
 * (the tested bytes ARE the shipped bytes) — but it leaves one
 * unverifiable claim in a system whose thesis is claims-you-can-verify:
 * nothing proves that `motebit@X` on the registry is the audited tree.
 * Its provenance is "trust npm."
 *
 * This module closes that gap as a WITNESS: the relay observes the
 * public registry, hashes what it sees — the tarball and the bundle
 * file inside it — and signs the observation in the exact envelope of
 * the transparency declaration (same canonicalJson + SHA-256 + Ed25519,
 * same `verifyTransparencyDeclaration` on the consumer side, same
 * pinned key from `motebit register`). An installed CLI can then hash
 * its OWN bytes and check them against the witness: the self-signing
 * body becomes self-verifying.
 *
 * Honesty boundary: this is an operator's signed observation of
 * registry state, not a reproducible-build proof. It binds artifact →
 * operator's word → pinned key; a verifier who distrusts the operator
 * gains nothing (correctly — the operator published the artifact). The
 * reproducible-build rung is a separate, later arc.
 */

import { gunzipSync } from "node:zlib";
import { canonicalJson, sha256, sign, bytesToHex } from "@motebit/encryption";
import { TRANSPARENCY_SUITE } from "@motebit/protocol";
import type { Hono } from "hono";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "release-witness" });

/** Spec id for the witness envelope (sibling of the transparency draft). */
const SPEC_ID = "motebit-release-witness/draft-2026-07-07";

/** Registry packument + tarball origin. */
const REGISTRY = "https://registry.npmjs.org";

/** Witnessed package + the attested file inside its tarball. */
const PACKAGE = "motebit";
const BUNDLE_PATH = "package/dist/index.js";

/** How many most-recent versions to witness per build. */
const VERSION_COUNT = 3;

/** Rebuild the witness when older than this (registry state moves slowly). */
const WITNESS_TTL_MS = 60 * 60 * 1000;

export interface WitnessedRelease {
  version: string;
  /** npm's own content address for the tarball (`dist.integrity`). */
  tarball_integrity: string;
  /** The commit npm recorded at publish (`gitHead`), when present. */
  git_head?: string;
  /** SHA-256 (hex) of the bundle file inside the tarball — what an
   *  installed CLI compares its own bytes against. */
  files: Record<string, string>;
}

interface RelayIdentityLike {
  relayMotebitId: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Minimal tar reader — extract one entry by name from a tarball buffer.
 * The tar format is a sequence of 512-byte headers (name at offset 0,
 * size as octal ASCII at offset 124) followed by size bytes rounded up
 * to 512. No dependency earns its keep for one-file extraction.
 */
export function extractTarEntry(tarBytes: Uint8Array, entryName: string): Uint8Array | null {
  let offset = 0;
  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) return null; // end-of-archive
    const nameEnd = header.indexOf(0);
    const name = new TextDecoder().decode(header.subarray(0, nameEnd === -1 ? 100 : nameEnd));
    const sizeField = new TextDecoder().decode(header.subarray(124, 136)).replace(/\0.*$/, "");
    const size = parseInt(sizeField.trim(), 8);
    if (!Number.isFinite(size) || size < 0) return null; // malformed — fail closed
    const dataStart = offset + 512;
    if (name === entryName) {
      if (dataStart + size > tarBytes.length) return null;
      return tarBytes.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Observe the registry: packument → recent versions → tarball hashes. */
export async function observeReleases(
  fetchImpl: typeof fetch = fetch,
): Promise<WitnessedRelease[]> {
  const res = await fetchImpl(`${REGISTRY}/${PACKAGE}`);
  if (!res.ok) throw new Error(`packument fetch failed: HTTP ${res.status}`);
  const packument = (await res.json()) as {
    versions: Record<string, { dist: { integrity?: string; tarball: string }; gitHead?: string }>;
    time?: Record<string, string>;
  };
  const versions = Object.keys(packument.versions)
    .sort((a, b) => (packument.time?.[a] ?? "").localeCompare(packument.time?.[b] ?? ""))
    .slice(-VERSION_COUNT);

  const witnessed: WitnessedRelease[] = [];
  for (const version of versions) {
    const meta = packument.versions[version]!;
    const tarRes = await fetchImpl(meta.dist.tarball);
    if (!tarRes.ok) throw new Error(`tarball fetch failed for ${version}: HTTP ${tarRes.status}`);
    const gz = new Uint8Array(await tarRes.arrayBuffer());
    const tar = new Uint8Array(gunzipSync(gz));
    const bundle = extractTarEntry(tar, BUNDLE_PATH);
    if (bundle == null) {
      // A published version without the bundle is itself worth
      // witnessing loudly — but never silently skipped.
      throw new Error(`${BUNDLE_PATH} missing from ${PACKAGE}@${version} tarball`);
    }
    witnessed.push({
      version,
      tarball_integrity: meta.dist.integrity ?? "",
      ...(meta.gitHead != null ? { git_head: meta.gitHead } : {}),
      files: { "dist/index.js": bytesToHex(await sha256(bundle)) },
    });
  }
  return witnessed;
}

/** Sign the observation in the transparency-declaration envelope. */
export async function buildSignedReleaseWitness(
  relayIdentity: RelayIdentityLike,
  releases: WitnessedRelease[],
  declaredAt: number = Date.now(),
): Promise<Record<string, unknown>> {
  const payload = {
    spec: SPEC_ID,
    declared_at: declaredAt,
    relay_id: relayIdentity.relayMotebitId,
    relay_public_key: bytesToHex(relayIdentity.publicKey),
    content: { package: PACKAGE, registry: REGISTRY, releases },
  };
  const canonical = canonicalJson(payload);
  const canonicalBytes = new TextEncoder().encode(canonical);
  const hashHex = bytesToHex(await sha256(canonicalBytes));
  const signatureHex = bytesToHex(await sign(canonicalBytes, relayIdentity.privateKey));
  return { ...payload, hash: hashHex, suite: TRANSPARENCY_SUITE, signature: signatureHex };
}

/**
 * `GET /.well-known/motebit-releases.json` — lazy-built, TTL-cached.
 * Registry unavailability degrades to 503 (the witness never serves a
 * stale-beyond-TTL or partial observation as fresh truth).
 */
export function registerReleaseWitnessRoutes(deps: {
  app: Hono;
  relayIdentity: RelayIdentityLike;
  fetchImpl?: typeof fetch;
}): void {
  const { app, relayIdentity } = deps;
  let cached: { body: string; builtAt: number } | null = null;
  let building: Promise<string> | null = null;

  const build = async (): Promise<string> => {
    const releases = await observeReleases(deps.fetchImpl ?? fetch);
    const witness = await buildSignedReleaseWitness(relayIdentity, releases);
    const body = canonicalJson(witness);
    cached = { body, builtAt: Date.now() };
    return body;
  };

  /** @internal */
  app.get("/.well-known/motebit-releases.json", async (_c) => {
    try {
      if (cached != null && Date.now() - cached.builtAt < WITNESS_TTL_MS) {
        return new Response(cached.body, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=300",
          },
        });
      }
      building ??= build().finally(() => {
        building = null;
      });
      const body = await building;
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
      });
    } catch (err) {
      logger.warn("release_witness.build_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      // Serve a stale witness over an error — it is still SIGNED truth
      // about the registry at builtAt; the consumer sees declared_at.
      if (cached != null) {
        return new Response(cached.body, {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      return new Response(JSON.stringify({ error: "witness_unavailable" }), { status: 503 });
    }
  });
}
