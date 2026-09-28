/**
 * #875 review round 2 — a device row is never evidence of an identity's key.
 *
 * `/pairing/claim` takes any canonical key without a signature, and the
 * approving device's approval writes it as a device row. Such a row may
 * verify only that device's own tokens and signatures. It must never become
 * what the relay records, serves, binds or attributes as the IDENTITY's key:
 * the registry value, a served `public_key`/`did`, a credential subject or
 * issuer, or a departure authority beyond that row itself. The relay laundered
 * a stranger's key through both the keyed and the keyless `/agents/register`,
 * through the capabilities route, through the relay-issued reputation
 * subject, and through revoke-credential's issuer check.
 *
 * This is a structural inventory, in the shape of
 * `check-identity-authority-writers`: every read of the `devices` table in
 * relay source is registered here, per file, with the verdict that justifies
 * it. A NEW read fails until it is classified, which is the point: a reader
 * that takes "the first keyed device row" as the identity's key must be
 * written against evidence (`callerVerifiedKey`, `holderKeyOf`) instead.
 * Structure only — the behaviour is proven in
 * `key-proof-of-possession-875.test.ts`, each law tampered and seen red.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");

/** What counts as a read of a device row (and so possibly of its key). */
const DEVICE_ROW_READ =
  /listDevices\(|loadDeviceById\(|getDevice\(|FROM\s+devices\b|JOIN\s+devices\b|readDeviceKeys\(|relay_devices\b/g;

/**
 * Every device-row read in relay source, per file, with its verdict. Keep
 * the count exact; add a file only with a reason a reviewer can check.
 */
const DEVICE_ROW_READS: Record<string, { count: number; verdict: string }> = {
  "auth.ts": {
    count: 1,
    verdict:
      "PER-DEVICE: verifySignedTokenForDevice verifies a token against the row its own `did` names",
  },
  "index.ts": {
    count: 1,
    verdict: "PER-DEVICE: the WS verifier's synchronous twin — the row for the token's `did`",
  },
  "agents.ts": {
    count: 3,
    verdict:
      "capabilities: the per-device hardware-attestation LIST (rows as rows; the served identity key is holder ?? registry); verify-receipt: signature reader, the receipt's own device row else main's first keyed row (DB3, public verdict kept); /agents/register: the bearer's own device row (callerDeviceKey, per-device)",
  },
  "tasks.ts": {
    count: 4,
    verdict:
      "signature readers (receipt ingest, two sub-receipt checks): verify a signature under a row's key — acceptance needs that key's own signature; receipt heal: moves the registry only to an embedded key whose signature over THIS receipt verifies (request-carried proof)",
  },
  "federation-callbacks.ts": {
    count: 1,
    verdict: "signature reader: a forwarded result's inner receipt, verified under a row's key",
  },
  "migration.ts": {
    count: 1,
    verdict: "signature reader: a balance waiver's signature (legacy `relay_devices` read)",
  },
  "device-registration-guard.ts": {
    count: 1,
    verdict: "PER-DEVICE: conflict check on the claimed device_id's own row",
  },
  "pairing.ts": {
    count: 2,
    verdict:
      "PER-DEVICE: the approver's own row (approverKeyMatches); update-key's target device row",
  },
  "sync-routes.ts": {
    count: 2,
    verdict:
      "PER-DEVICE: register-self's own device row; hardware-attestation verified under that device's own row",
  },
  "succession-apply.ts": {
    count: 1,
    verdict:
      "departure device rung (#736, main's rule): a rotation signed by that row's key departs that row only; never the holder",
  },
  "identity-keys.ts": {
    count: 9,
    verdict:
      "keysHeldBy / admitKey / E-op / E-main predicates and the v42 backfill: guard SETS and spelling continuity that BLOCK or admit an already-held key; never a value written as authority",
  },
  "identity-revocation.ts": {
    count: 1,
    verdict: "existence only: does the relay know this identity at all",
  },
  "health-summary.ts": {
    count: 2,
    verdict: "operator metrics: counts, no key used",
  },
  "state-export.ts": {
    count: 1,
    verdict: "signed export of the device LIST as rows, not an identity key",
  },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...sourceFiles(p));
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

describe("a device row is never evidence of the identity's key — every read is classified (#875)", () => {
  it("each file's device-row reads equal its registered, justified count", () => {
    const files = sourceFiles(SRC);
    const found: Record<string, number> = {};
    for (const f of files) {
      const n = (readFileSync(f, "utf8").match(DEVICE_ROW_READ) ?? []).length;
      if (n > 0) found[relative(SRC, f)] = n;
    }
    const problems: string[] = [];
    for (const [file, n] of Object.entries(found)) {
      const reg = DEVICE_ROW_READS[file];
      if (reg === undefined || reg.count !== n) {
        problems.push(
          `${file}: ${n} device-row read(s), registered ${reg?.count ?? 0}. A device row is never evidence of the identity's key (#875: /pairing/claim writes unproven rows). Use the bearer's verified key (c.get("callerVerifiedKey")) or the proven holder (holderKeyOf) — or, if this read verifies only that device's own token/signature, register it in DEVICE_ROW_READS with its verdict.`,
        );
      }
    }
    for (const file of Object.keys(DEVICE_ROW_READS)) {
      if (found[file] === undefined) {
        problems.push(`${file}: registered but has no device-row read — remove the stale entry.`);
      }
    }
    // Aperture: what was examined.
    console.log(
      `device-row reads: ${files.length} relay source file(s) scanned (excluding __tests__), ${Object.values(found).reduce((a, b) => a + b, 0)} read(s) in ${Object.keys(found).length} file(s), all classified`,
    );
    expect(problems).toEqual([]);
  });
});
