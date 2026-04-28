#!/usr/bin/env tsx
/**
 * Capture-helper for the Apple App Attest real-ceremony test fixture.
 *
 * Sibling to the WebAuthn fixture (lifted from kanidm/webauthn-rs) and
 * the Android Keystore fixtures (lifted from Google's keyattestation
 * Apache-2.0 testdata). Apple does not publish a third-party reference
 * corpus — App Attest is per-team-account, so the fixture has to be
 * captured from a real iPhone running the motebit mobile app's mint
 * flow.
 *
 * Once the fixture lands, `packages/crypto-appattest/src/__tests__/
 * verify-real-ceremony.test.ts` runs automatically, validating against
 * the production-pinned `APPLE_APPATTEST_ROOT_PEM` with no test-only
 * `rootPem` override.
 *
 * ─────────────────────────────────────────────────────────────────────
 * HOW TO CAPTURE FROM A REAL IPHONE
 * ─────────────────────────────────────────────────────────────────────
 *
 * App Attest requires real hardware (the Secure Enclave). The iOS
 * simulator returns a "feature unavailable" error path; only a physical
 * iPhone produces a valid attestation.
 *
 *   1. Open the mobile app on a real iPhone (not simulator), built and
 *      installed via the existing Expo dev / EAS build pipeline.
 *
 *   2. Trigger the hardware-attestation mint. The current path is
 *      `apps/mobile/src/mint-hardware-credential.ts` — reachable from
 *      Settings → Identity → Mint Hardware Credential, or whatever the
 *      surface naming is at the time of capture.
 *
 *   3. The mint produces a signed `AgentTrustCredential`. Its
 *      `credentialSubject.hardware_attestation.attestation_receipt`
 *      field carries the three-segment string this script consumes:
 *
 *          {attestationObjectB64url}.{keyIdB64url}.{clientDataHashB64url}
 *
 *      Copy that single string to your clipboard. Note your bundle ID
 *      (typically `com.motebit.app` or whatever ships in
 *      `apps/mobile/app.json`'s `ios.bundleIdentifier`).
 *
 *   4. Run this script:
 *
 *          npx tsx scripts/capture-app-attest-fixture.ts \
 *            --receipt "<paste-the-three-segment-string>" \
 *            --bundle-id com.motebit.app
 *
 *      It splits the receipt into the fixture JSON shape, pins the
 *      verify-as-of clock to the moment of capture (so chain validity
 *      checks have a clock inside the leaf cert's notBefore..notAfter
 *      window), records provenance, and writes the fixture in place.
 *
 *   5. Run the test suite to confirm the verifier agrees with the real
 *      bytes against the production-pinned root:
 *
 *          pnpm --filter @motebit/crypto-appattest test verify-real-ceremony
 *
 *      The suite skips before capture (placeholder bytes); after
 *      capture it runs three tests covering chain validity, bundle-ID
 *      rejection, and root-pinning load-bearing checks.
 *
 *   6. Commit the fixture.
 *
 *      `packages/crypto-appattest/src/__tests__/fixtures/
 *      iphone-appattest-real.json`
 *
 *      Apple App Attest receipts are device-and-team-scoped — they do
 *      NOT leak the user's personal data. The receipt names the bundle
 *      ID, an attestation key ID (a per-device-per-app handle, not a
 *      stable hardware identifier), and the cert chain. Same privacy
 *      surface as the YubiKey fixture in `crypto-webauthn`.
 *
 * ─────────────────────────────────────────────────────────────────────
 *
 * Exit codes:
 *   0  fixture written
 *   1  invalid arguments or receipt shape
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE_PATH = resolve(
  ROOT,
  "packages/crypto-appattest/src/__tests__/fixtures/iphone-appattest-real.json",
);

interface Args {
  receipt: string;
  bundleId: string;
  verifyAsOfIso: string;
  provenance: string;
}

function parseArgs(argv: string[]): Args {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag?.startsWith("--")) {
      const value = argv[i + 1];
      if (value && !value.startsWith("--")) {
        args.set(flag.slice(2), value);
        i++;
      } else {
        args.set(flag.slice(2), "");
      }
    }
  }

  const receipt = args.get("receipt");
  const bundleId = args.get("bundle-id");
  if (!receipt || !bundleId) {
    process.stderr.write(
      "usage: capture-app-attest-fixture.ts --receipt <b64.b64.b64> --bundle-id <id> [--verify-as-of <iso>] [--provenance <text>]\n",
    );
    process.exit(1);
  }

  return {
    receipt,
    bundleId,
    verifyAsOfIso: args.get("verify-as-of") ?? new Date().toISOString(),
    provenance:
      args.get("provenance") ??
      `Captured from a motebit-team iPhone via apps/mobile mint flow on ${new Date().toISOString()}.`,
  };
}

function isLikelyBase64Url(segment: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(segment) && segment.length > 0;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const segments = args.receipt.split(".");
  if (segments.length !== 3) {
    process.stderr.write(
      `✗ receipt does not split into three base64url segments separated by ".": got ${segments.length} segment(s).\n` +
        `  expected shape: {attestationObjectB64url}.{keyIdB64url}.{clientDataHashB64url}\n`,
    );
    process.exit(1);
  }

  const [attestationObject, keyId, clientDataHash] = segments as [string, string, string];
  for (const [name, segment] of [
    ["attestation_object_base64url", attestationObject],
    ["key_id_base64url", keyId],
    ["client_data_hash_base64url", clientDataHash],
  ] as const) {
    if (!isLikelyBase64Url(segment)) {
      process.stderr.write(`✗ ${name} is not a non-empty base64url segment: "${segment}"\n`);
      process.exit(1);
    }
  }

  if (attestationObject.length < 100) {
    process.stderr.write(
      `⚠ attestation_object_base64url is suspiciously short (${attestationObject.length} chars). ` +
        `A real CBOR attestation object is typically ~1.5 KB after base64url. ` +
        `Confirm the capture came from a real iPhone, not the simulator.\n`,
    );
  }

  const fixture = {
    attestation_object_base64url: attestationObject,
    key_id_base64url: keyId,
    client_data_hash_base64url: clientDataHash,
    bundle_id: args.bundleId,
    verify_as_of_iso: args.verifyAsOfIso,
    provenance: args.provenance,
  };

  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + "\n", "utf-8");

  process.stderr.write(
    `✓ wrote ${FIXTURE_PATH}\n` +
      `  bundle_id        : ${args.bundleId}\n` +
      `  verify_as_of_iso : ${args.verifyAsOfIso}\n` +
      `  attestation_object: ${attestationObject.length} chars\n` +
      `  key_id            : ${keyId.length} chars\n` +
      `  client_data_hash  : ${clientDataHash.length} chars\n` +
      `\n` +
      `Next: pnpm --filter @motebit/crypto-appattest test verify-real-ceremony\n`,
  );
}

main();
