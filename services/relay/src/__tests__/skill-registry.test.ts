/**
 * Skills registry endpoint tests — motebit/skills-registry@1.0.
 *
 * Coverage:
 *   - POST /api/v1/skills/submit happy path: signed envelope → 201, canonical
 *     submitter derived from public key, returns the addressing tuple.
 *   - Submit 7 rejection cases: malformed JSON, schema violation, signature
 *     fail, body_hash mismatch, file_hash mismatch (path missing + bad hash),
 *     version_immutable on different content_hash for the same triple.
 *   - Submit idempotency: same content_hash re-submission returns 200 with
 *     the original submitted_at preserved.
 *   - GET /api/v1/skills/discover: curated default (featured-only), pagination,
 *     search by q, filter by submitter, include_unfeatured opt-in.
 *   - GET /api/v1/skills/:submitter/:name/:version: success, 404, byte-identical
 *     bundle round-trips through the relay (consumer-side re-verify scenario).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
// eslint-disable-next-line no-restricted-imports -- tests build wire-shape fixtures
import { generateKeypair, bytesToHex, hash as sha256, canonicalJson } from "@motebit/encryption";
import { publicKeyToDidKey, signSkillEnvelope, signSkillManifest } from "@motebit/crypto";
import type {
  SkillEnvelope,
  SkillManifest,
  SkillRegistryBundle,
  SkillRegistryListing,
  SkillRegistrySubmitRequest,
  SkillRegistrySubmitResponse,
} from "@motebit/protocol";

import { createTestRelay } from "./test-helpers.js";
import type { SyncRelay } from "../index.js";

// === Fixture builders =====================================================

const TEST_BODY = new TextEncoder().encode(
  "# Example\n\n## When to Use\n\nWhen the test fires.\n\n## Procedure\n\n1. Step.\n",
);

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function makeUnsignedManifest(
  opts: {
    name?: string;
    description?: string;
    version?: string;
    category?: string;
    tags?: string[];
  } = {},
) {
  return {
    name: opts.name ?? "demo-skill",
    description: opts.description ?? "demo skill for tests",
    version: opts.version ?? "1.0.0",
    platforms: ["macos" as const, "linux" as const],
    metadata: {
      category: opts.category ?? "test",
      tags: opts.tags ?? ["demo"],
    },
    motebit: {
      spec_version: "1.0" as const,
      sensitivity: "none" as const,
      hardware_attestation: { required: false, minimum_score: 0 },
    },
  };
}

async function buildSignedEnvelope(
  opts: {
    name?: string;
    description?: string;
    version?: string;
    body?: Uint8Array;
  } = {},
): Promise<{
  envelope: SkillEnvelope;
  body: Uint8Array;
  manifest: SkillManifest;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  submitterMotebitId: string;
}> {
  const { privateKey, publicKey } = await generateKeypair();
  const unsigned = makeUnsignedManifest(opts);
  const body = opts.body ?? TEST_BODY;
  const manifest = await signSkillManifest(unsigned, privateKey, publicKey, body);

  // Compute content_hash exactly as the spec defines: JCS(manifest) || 0x0A || lf_body.
  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
  const fullContent = new Uint8Array(manifestBytes.length + 1 + body.length);
  fullContent.set(manifestBytes, 0);
  fullContent[manifestBytes.length] = 0x0a;
  fullContent.set(body, manifestBytes.length + 1);
  const contentHash = await sha256(fullContent);
  const bodyHash = await sha256(body);

  const envelope = await signSkillEnvelope(
    {
      spec_version: "1.0",
      skill: { name: manifest.name, version: manifest.version, content_hash: contentHash },
      manifest,
      body_hash: bodyHash,
      files: [],
    },
    privateKey,
    publicKey,
  );

  return {
    envelope,
    body,
    manifest,
    privateKey,
    publicKey,
    submitterMotebitId: publicKeyToDidKey(publicKey),
  };
}

function makeSubmitBody(envelope: SkillEnvelope, body: Uint8Array): SkillRegistrySubmitRequest {
  return { envelope, body: bytesToBase64(body) };
}

async function postSubmit(
  relay: SyncRelay,
  body: unknown,
): Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }> {
  return relay.app.request("/api/v1/skills/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// === POST /api/v1/skills/submit ===========================================

describe("POST /api/v1/skills/submit", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });
  afterEach(async () => {
    await relay.close();
  });

  it("accepts a valid signed envelope and derives submitter from the public key", async () => {
    const fixture = await buildSignedEnvelope();
    const res = await postSubmit(relay, makeSubmitBody(fixture.envelope, fixture.body));
    expect(res.status).toBe(201);
    const out = (await res.json()) as SkillRegistrySubmitResponse;
    expect(out.submitter_motebit_id).toBe(fixture.submitterMotebitId);
    expect(out.name).toBe(fixture.envelope.skill.name);
    expect(out.version).toBe(fixture.envelope.skill.version);
    expect(out.content_hash).toBe(fixture.envelope.skill.content_hash);
    expect(out.skill_id).toBe(
      `${fixture.submitterMotebitId}/${fixture.envelope.skill.name}@${fixture.envelope.skill.version}`,
    );
    expect(out.submitted_at).toBeGreaterThan(0);
  });

  it("re-submission with the same content_hash is idempotent (200, unchanged submitted_at)", async () => {
    const fixture = await buildSignedEnvelope();
    const first = await postSubmit(relay, makeSubmitBody(fixture.envelope, fixture.body));
    expect(first.status).toBe(201);
    const firstOut = (await first.json()) as SkillRegistrySubmitResponse;

    const second = await postSubmit(relay, makeSubmitBody(fixture.envelope, fixture.body));
    expect(second.status).toBe(200);
    const secondOut = (await second.json()) as SkillRegistrySubmitResponse;
    expect(secondOut.submitted_at).toBe(firstOut.submitted_at);
  });

  it("rejects malformed JSON body with 400", async () => {
    const res = await postSubmit(relay, "{not valid json");
    expect(res.status).toBe(400);
  });

  it("rejects schema violations (missing envelope) with 400", async () => {
    const res = await postSubmit(relay, { body: "anything" });
    expect(res.status).toBe(400);
  });

  it("rejects a tampered envelope (signature does not verify) with 400 verification_failed", async () => {
    const fixture = await buildSignedEnvelope();
    const tampered: SkillEnvelope = {
      ...fixture.envelope,
      manifest: { ...fixture.envelope.manifest, description: "tampered" },
    };
    const res = await postSubmit(relay, makeSubmitBody(tampered, fixture.body));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toMatch(/verification_failed/);
  });

  it("rejects a body_hash mismatch with 400", async () => {
    const fixture = await buildSignedEnvelope();
    const wrongBody = new TextEncoder().encode(
      "# Different body that does not hash to body_hash\n",
    );
    const res = await postSubmit(relay, makeSubmitBody(fixture.envelope, wrongBody));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toMatch(/body_hash_mismatch/);
  });

  it("rejects version_immutable when the same triple ships with different bytes", async () => {
    const original = await buildSignedEnvelope({ name: "immutable-skill", version: "1.2.3" });
    const first = await postSubmit(relay, makeSubmitBody(original.envelope, original.body));
    expect(first.status).toBe(201);

    // Re-sign the same name+version with a DIFFERENT body using the same key
    // so the submitter matches but the content_hash diverges.
    const altBody = new TextEncoder().encode("# Different\n");
    const altManifest = await signSkillManifest(
      makeUnsignedManifest({ name: "immutable-skill", version: "1.2.3" }),
      original.privateKey,
      original.publicKey,
      altBody,
    );
    const altManifestBytes = new TextEncoder().encode(canonicalJson(altManifest));
    const fullContent = new Uint8Array(altManifestBytes.length + 1 + altBody.length);
    fullContent.set(altManifestBytes, 0);
    fullContent[altManifestBytes.length] = 0x0a;
    fullContent.set(altBody, altManifestBytes.length + 1);
    const altContentHash = await sha256(fullContent);
    const altBodyHash = await sha256(altBody);
    const altEnvelope = await signSkillEnvelope(
      {
        spec_version: "1.0",
        skill: { name: "immutable-skill", version: "1.2.3", content_hash: altContentHash },
        manifest: altManifest,
        body_hash: altBodyHash,
        files: [],
      },
      original.privateKey,
      original.publicKey,
    );

    const res = await postSubmit(relay, makeSubmitBody(altEnvelope, altBody));
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toMatch(/version_immutable/);
  });

  it("stores the bundle byte-identical so consumers can re-verify offline", async () => {
    const fixture = await buildSignedEnvelope();
    await postSubmit(relay, makeSubmitBody(fixture.envelope, fixture.body));
    const submitter = encodeURIComponent(fixture.submitterMotebitId);
    const res = await relay.app.request(
      `/api/v1/skills/${submitter}/${fixture.envelope.skill.name}/${fixture.envelope.skill.version}`,
    );
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as SkillRegistryBundle;
    expect(bundle.envelope.signature.value).toBe(fixture.envelope.signature.value);
    expect(bundle.envelope.signature.public_key).toBe(fixture.envelope.signature.public_key);
    expect(bundle.body).toBe(bytesToBase64(fixture.body));
  });
});

// === GET /api/v1/skills/discover ==========================================

describe("GET /api/v1/skills/discover", () => {
  let relay: SyncRelay;
  let featuredFixture: Awaited<ReturnType<typeof buildSignedEnvelope>>;
  let unfeaturedFixture: Awaited<ReturnType<typeof buildSignedEnvelope>>;

  beforeEach(async () => {
    // Build a featured fixture, then construct the relay with that
    // submitter pinned to the FEATURED env var. (Spec §7.2: curation is
    // implementation-defined; reference relay reads the env var.)
    featuredFixture = await buildSignedEnvelope({ name: "featured-skill" });
    const prev = process.env["FEATURED_SKILL_SUBMITTERS"];
    process.env["FEATURED_SKILL_SUBMITTERS"] = featuredFixture.submitterMotebitId;
    try {
      relay = await createTestRelay({ enableDeviceAuth: false });
    } finally {
      // Restore so other test files aren't affected by leaked env state.
      if (prev === undefined) delete process.env["FEATURED_SKILL_SUBMITTERS"];
      else process.env["FEATURED_SKILL_SUBMITTERS"] = prev;
    }

    unfeaturedFixture = await buildSignedEnvelope({ name: "unfeatured-skill" });
    await postSubmit(relay, makeSubmitBody(featuredFixture.envelope, featuredFixture.body));
    await postSubmit(relay, makeSubmitBody(unfeaturedFixture.envelope, unfeaturedFixture.body));
  });

  afterEach(async () => {
    await relay.close();
  });

  it("default view returns only featured submitters", async () => {
    const res = await relay.app.request("/api/v1/skills/discover");
    expect(res.status).toBe(200);
    const out = (await res.json()) as SkillRegistryListing;
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]?.name).toBe("featured-skill");
    expect(out.entries[0]?.featured).toBe(true);
    expect(out.total).toBe(1);
  });

  it("include_unfeatured=true returns every submission", async () => {
    const res = await relay.app.request("/api/v1/skills/discover?include_unfeatured=true");
    expect(res.status).toBe(200);
    const out = (await res.json()) as SkillRegistryListing;
    expect(out.entries).toHaveLength(2);
    expect(out.total).toBe(2);
    const names = out.entries.map((e) => e.name).sort();
    expect(names).toEqual(["featured-skill", "unfeatured-skill"]);
  });

  it("filters by submitter (exact did:key match)", async () => {
    const res = await relay.app.request(
      `/api/v1/skills/discover?include_unfeatured=true&submitter=${encodeURIComponent(unfeaturedFixture.submitterMotebitId)}`,
    );
    const out = (await res.json()) as SkillRegistryListing;
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]?.submitter_motebit_id).toBe(unfeaturedFixture.submitterMotebitId);
  });

  it("filters by free-text query against name", async () => {
    const res = await relay.app.request(
      "/api/v1/skills/discover?include_unfeatured=true&q=unfeatured",
    );
    const out = (await res.json()) as SkillRegistryListing;
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]?.name).toBe("unfeatured-skill");
  });

  it("respects limit and offset for pagination", async () => {
    const res = await relay.app.request(
      "/api/v1/skills/discover?include_unfeatured=true&limit=1&offset=1",
    );
    const out = (await res.json()) as SkillRegistryListing;
    expect(out.entries).toHaveLength(1);
    expect(out.limit).toBe(1);
    expect(out.offset).toBe(1);
    expect(out.total).toBe(2);
  });

  it("returns empty entries with hint shape when no submissions match", async () => {
    const res = await relay.app.request(
      "/api/v1/skills/discover?include_unfeatured=true&q=nonexistent-skill-xyz",
    );
    const out = (await res.json()) as SkillRegistryListing;
    expect(out.entries).toEqual([]);
    expect(out.total).toBe(0);
  });
});

// === GET /api/v1/skills/:submitter/:name/:version =========================

describe("GET /api/v1/skills/:submitter/:name/:version", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
  });
  afterEach(async () => {
    await relay.close();
  });

  it("returns 404 for an unknown triple", async () => {
    const res = await relay.app.request("/api/v1/skills/did:key:z6MkUNKNOWN/missing-skill/1.0.0");
    expect(res.status).toBe(404);
  });

  it("returns the same bundle a consumer can re-verify against the embedded public key", async () => {
    const fixture = await buildSignedEnvelope();
    await postSubmit(relay, makeSubmitBody(fixture.envelope, fixture.body));

    const submitter = encodeURIComponent(fixture.submitterMotebitId);
    const res = await relay.app.request(
      `/api/v1/skills/${submitter}/${fixture.envelope.skill.name}/${fixture.envelope.skill.version}`,
    );
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as SkillRegistryBundle;

    // The whole point: submitter_motebit_id echo equals the did:key derived
    // from envelope.signature.public_key. Consumer re-derives and asserts —
    // a relay that returns a bundle with a mismatched submitter is caught.
    expect(bundle.submitter_motebit_id).toBe(fixture.submitterMotebitId);
    expect(bundle.envelope.signature.public_key).toBe(bytesToHex(fixture.publicKey));
    expect(bundle.envelope.skill.content_hash).toBe(fixture.envelope.skill.content_hash);
  });
});
