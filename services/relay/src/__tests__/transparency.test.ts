/**
 * Operator transparency tests.
 *
 * Three invariants:
 *   1. The signed declaration verifies against the relay's public key.
 *   2. The committed PRIVACY.md matches `renderMarkdown()` exactly. Any
 *      drift between the two artifacts is a sibling-boundary violation —
 *      this test is the defense.
 *   3. Hash and signature cover the canonical JSON of the unsigned payload.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import {
  generateKeypair,
  bytesToHex,
  canonicalJson,
  sha256,
  verify as verifyEd25519,
} from "@motebit/encryption";
import { buildSignedDeclaration, renderMarkdown, DECLARATION_CONTENT } from "../transparency.js";
import type { RelayIdentity } from "../federation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = resolve(__dirname, "..", "..");

let relayIdentity: RelayIdentity;

beforeAll(async () => {
  const keypair = await generateKeypair();
  relayIdentity = {
    relayMotebitId: `relay-${crypto.randomUUID()}`,
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    publicKeyHex: bytesToHex(keypair.publicKey),
    did: `did:key:z${bytesToHex(keypair.publicKey).slice(0, 16)}`,
  };
});

describe("operator transparency declaration", () => {
  it("signs the canonical payload verifiably against the relay public key", async () => {
    const declaration = await buildSignedDeclaration(relayIdentity, 1234567890);

    expect(declaration.spec).toBe("motebit-transparency/draft-2026-04-14");
    expect(declaration.suite).toBe("motebit-jcs-ed25519-hex-v1");
    expect(declaration.relay_id).toBe(relayIdentity.relayMotebitId);
    expect(declaration.relay_public_key).toBe(relayIdentity.publicKeyHex);
    expect(declaration.declared_at).toBe(1234567890);

    // Reconstruct the canonical payload and verify the signature
    const payload = {
      spec: declaration.spec,
      declared_at: declaration.declared_at,
      relay_id: declaration.relay_id,
      relay_public_key: declaration.relay_public_key,
      content: declaration.content,
    };
    const canonical = canonicalJson(payload);
    const canonicalBytes = new TextEncoder().encode(canonical);

    // Hash matches
    const hashBytes = await sha256(canonicalBytes);
    expect(declaration.hash).toBe(bytesToHex(hashBytes));

    // Signature verifies
    const sigBytes = Uint8Array.from(
      declaration.signature.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
    );
    const valid = await verifyEd25519(sigBytes, canonicalBytes, relayIdentity.publicKey);
    expect(valid).toBe(true);
  });

  it("declaration content references the canonical doctrine doc indirectly via shape", () => {
    // Sanity check that the content is the shape the doctrine describes.
    expect(DECLARATION_CONTENT.retention.presence).toBeDefined();
    expect(DECLARATION_CONTENT.retention.operational).toBeDefined();
    expect(DECLARATION_CONTENT.retention.content).toBeDefined();
    expect(DECLARATION_CONTENT.retention.ip_addresses).toBeDefined();
    expect(DECLARATION_CONTENT.third_party_processors.length).toBeGreaterThan(0);
    expect(DECLARATION_CONTENT.declared_collected_pii.length).toBeGreaterThan(0);
    expect(DECLARATION_CONTENT.declared_not_collected.length).toBeGreaterThan(0);

    // The honest_gaps field is the doctrine-mandated admission. If it's
    // empty, either every gap is closed (great) or someone removed the
    // honesty escape hatch (bad). Either way, force a deliberate review.
    expect(DECLARATION_CONTENT.honest_gaps).toBeDefined();
  });
});

describe("PRIVACY.md sibling-boundary", () => {
  it("matches the rendered markdown exactly", () => {
    const committed = readFileSync(resolve(SERVICE_ROOT, "PRIVACY.md"), "utf-8");
    const rendered = renderMarkdown();

    if (committed !== rendered) {
      // Helpful failure message — direct the dev to regenerate.
      const hint = `
PRIVACY.md is out of sync with services/relay/src/transparency.ts (renderMarkdown).

The committed file and the renderer must match exactly because the signed
JSON declaration and PRIVACY.md derive from the same DECLARATION_CONTENT
object. Drift between the two breaks the doctrine in
docs/doctrine/operator-transparency.md ("disagreement between the two
artifacts is a violation").

To regenerate PRIVACY.md from the current renderer, run:

  cd services/relay && pnpm build && \\
    node -e "import('./dist/transparency.js').then(({ renderMarkdown }) => process.stdout.write(renderMarkdown()))" \\
    > PRIVACY.md

Then re-run this test.
`;
      expect.fail(hint);
    }

    expect(committed).toBe(rendered);
  });
});
