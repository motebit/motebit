/**
 * #875 review — a device row is never evidence of an identity's key.
 *
 * `/pairing/claim` takes any canonical key without a signature, and the
 * approving device's approval writes it as a device row. Such a row verifies
 * only that device's own tokens and signatures. It must never become what the
 * relay records, serves, binds or attributes as the IDENTITY's key: the
 * registry value, a served `public_key`/`did`, a credential subject or
 * issuer. The review laundered a stranger's key through the keyed and keyless
 * `/agents/register`, the capabilities route, the relay-issued reputation
 * subject and revoke-credential's issuer check.
 *
 * This is a structural inventory, in the shape of
 * `check-identity-authority-writers`. Every read of a device row in relay
 * source is registered here as a SITE, with the verdict that justifies it.
 * A read counts as: a core-identity device loader, raw SQL over `devices`
 * (any case), or an identity-keys helper that returns device-row keys. A
 * site is identified by file, enclosing function and the normalized line,
 * so an unsafe read swapped in for a sanctioned one in the same file is a
 * new site and goes red, as does a stale entry. Structure only; the
 * behaviour is proven in `key-proof-of-possession-875.test.ts`, each law
 * tampered and seen red.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { scanDeviceRowSites, type DeviceRowSite } from "./device-row-sites.js";

const SRC = join(__dirname, "..");

type Registered = DeviceRowSite & { verdict: string };

/** Every device-row read site in relay source, with its verdict. */
const DEVICE_ROW_SITES: Registered[] = [
  {
    file: "agents.ts",
    fn: "/agent/:motebitId/capabilities",
    snippet: "const devices = await identityManager.listDevices(motebitId);",
    verdict:
      "ROWS AS ROWS: the per-device hardware-attestation list; the served identity key is servedIdentityKey",
  },
  {
    file: "agents.ts",
    fn: "/agent/:motebitId/verify-receipt",
    snippet: "const devices = await identityManager.listDevices(motebitId);",
    verdict:
      "SIGNATURE READER: the receipt's own device row, else main's first keyed row (DB3) — acceptance needs that key's own signature",
  },
  {
    file: "agents.ts",
    fn: "/api/v1/agents/register",
    snippet: "const signer = await identityManager.loadDeviceById(bearerClaims.did, motebitId);",
    verdict:
      "PER-DEVICE / GUARD: the bearer's own device row (callerDeviceKey, E-sov possession); keysHeldBy only decides whether the identity holds NO key (the sovereign-squat check) — never an exemption",
  },
  {
    file: "agents.ts",
    fn: "/api/v1/agents/register",
    snippet:
      "const heldBefore = new Set([...keysHeldBy(moteDb.db, motebitId)].map((k) => k.toLowerCase()));",
    verdict:
      "PER-DEVICE / GUARD: the bearer's own device row (callerDeviceKey, E-sov possession); keysHeldBy only decides whether the identity holds NO key (the sovereign-squat check) — never an exemption",
  },
  {
    file: "auth.ts",
    fn: "verifySignedTokenForDevice",
    snippet: "const device = await identityManager.loadDeviceById(claims.did, motebitId);",
    verdict: "PER-DEVICE: a token verified against the row its own `did` names",
  },
  {
    file: "device-registration-guard.ts",
    fn: "refusePublicDeviceRegistration",
    snippet: "const holder = await deps.identityManager.getDevice(req.deviceId);",
    verdict: "GUARD: conflict on the claimed device_id's own row; the held-key SET only blocks",
  },
  {
    file: "device-registration-guard.ts",
    fn: "refusePublicDeviceRegistration",
    snippet:
      "const held = new Set([...keysHeldBy(deps.db, req.motebitId)].map((k) => k.toLowerCase()));",
    verdict: "GUARD: conflict on the claimed device_id's own row; the held-key SET only blocks",
  },
  {
    file: "health-summary.ts",
    fn: "identityKeyPopulation",
    snippet: "UNION SELECT motebit_id FROM devices",
    verdict: "METRICS: counts, no key used",
  },
  {
    file: "health-summary.ts",
    fn: "identityKeyPopulation",
    snippet: "(SELECT COUNT(DISTINCT d.public_key) FROM devices d",
    verdict: "METRICS: counts, no key used",
  },
  {
    file: "identity-binding.ts",
    fn: "bindByDelegationRevocation",
    snippet:
      "![...keysHeldBy(db, revocation.delegator_id)].some((k) => k.toLowerCase() === signer)",
    verdict:
      "SIGNATURE READER: a revocation must verify under a key the relay holds for its delegator — acceptance needs that key's signature",
  },
  {
    file: "identity-keys.ts",
    fn: "readDeviceKeys",
    snippet: "function readDeviceKeys(db: DatabaseDriver, motebitId: string): string[] {",
    verdict: "DEFINITION: the raw read behind keysHeldBy / admitKey / E-op",
  },
  {
    file: "identity-keys.ts",
    fn: "readDeviceKeys",
    snippet:
      ".prepare(\"SELECT DISTINCT public_key FROM devices WHERE motebit_id = ? AND public_key != ''\")",
    verdict: "DEFINITION: the raw read behind keysHeldBy / admitKey / E-op",
  },
  {
    file: "identity-keys.ts",
    fn: "keysHeldBy",
    snippet: "export function keysHeldBy(db: DatabaseDriver, motebitId: string): Set<string> {",
    verdict: "DEFINITION: the guard SET (holder ∪ registry ∪ device rows)",
  },
  {
    file: "identity-keys.ts",
    fn: "add",
    snippet: "for (const k of readDeviceKeys(db, motebitId)) add(k);",
    verdict: "DEFINITION: keysHeldBy's device-row members",
  },
  {
    file: "identity-keys.ts",
    fn: "servedIdentityKey",
    snippet: "for (const key of keysHeldBy(db, motebitId)) {",
    verdict:
      "SERVED KEY: a key on file is served only when the id is its sovereign commitment (arithmetic), never as a row's word",
  },
  {
    file: "identity-keys.ts",
    fn: "admitKey",
    snippet: "readDeviceKeys(db, motebitId).includes(key)",
    verdict: "SPELLING CONTINUITY: admits an already-stored exact spelling; returns a boolean",
  },
  {
    file: "identity-keys.ts",
    fn: "recordFirstIdentityKey",
    snippet: "for (const held of keysHeldBy(db, id)) {",
    verdict: "GUARD: E-sov's predicate — any other held key BLOCKS the write",
  },
  {
    file: "identity-keys.ts",
    fn: "recordOperatorServiceKey",
    snippet: "if (readDeviceKeys(db, id).length > 0) return false;",
    verdict: "GUARD: E-op's predicate — any device row BLOCKS the write",
  },
  {
    file: "identity-keys.ts",
    fn: "recordOperatorServiceKey",
    snippet:
      'if (db.prepare("SELECT 1 FROM devices WHERE motebit_id = ? LIMIT 1").get(id) != null) {',
    verdict: "GUARD: E-op's predicate — any device row BLOCKS the write",
  },
  {
    file: "identity-keys.ts",
    fn: "IDENTITY_KEYS_BACKFILL_SQL",
    snippet:
      "(SELECT MIN(d.registered_at) FROM devices d WHERE d.motebit_id = i.motebit_id) AS first_device",
    verdict:
      "GUARD / TIMESTAMP: the one-time v42 transplant — device rows only BLOCK (HEAL-F) or date it",
  },
  {
    file: "identity-keys.ts",
    fn: "IDENTITY_KEYS_BACKFILL_SQL",
    snippet: "UNION SELECT motebit_id FROM devices",
    verdict:
      "GUARD / TIMESTAMP: the one-time v42 transplant — device rows only BLOCK (HEAL-F) or date it",
  },
  {
    file: "identity-keys.ts",
    fn: "IDENTITY_KEYS_BACKFILL_SQL",
    snippet: "SELECT 1 FROM devices d",
    verdict:
      "GUARD / TIMESTAMP: the one-time v42 transplant — device rows only BLOCK (HEAL-F) or date it",
  },
  {
    file: "identity-revocation.ts",
    fn: "isKnownIdentity",
    snippet: "UNION ALL SELECT 1 FROM devices WHERE motebit_id = ?",
    verdict: "EXISTENCE: does the relay know this identity at all",
  },
  {
    file: "index.ts",
    fn: "keyThatVerifiesNow",
    snippet: '.prepare("SELECT public_key FROM devices WHERE device_id = ? AND motebit_id = ?")',
    verdict: "PER-DEVICE: the WS verifier's twin — the row for the token's `did`",
  },
  {
    file: "migration.ts",
    fn: "/api/v1/agents/:motebitId/migrate/depart",
    snippet:
      '"SELECT public_key FROM relay_devices WHERE motebit_id = ? AND public_key IS NOT NULL LIMIT 1",',
    verdict: "SIGNATURE READER: a balance waiver's signature (legacy `relay_devices` read)",
  },
  {
    file: "p2p-payer.ts",
    fn: "add",
    snippet: "for (const k of keysHeldBy(db, caller.submitter)) add(k);",
    verdict:
      "GUARD / OPERATOR-ASSERTED: only under the master token acting for a body submitted_by — the operator is the authority asserting the submitter; the set only admits a payer whose key-derived wallet signed the on-chain transfer, and nothing is served, bound or attributed from it",
  },
  {
    file: "pairing.ts",
    fn: "approverKeyMatches",
    snippet: "const row = await identityManager.loadDeviceById(deviceId, motebitId);",
    verdict: "PER-DEVICE: the approver's own row",
  },
  {
    file: "pairing.ts",
    fn: "/pairing/:pairingId/update-key",
    snippet: "const device = await identityManager.getDevice(deviceId);",
    verdict: "PER-DEVICE: update-key's target device row",
  },
  {
    file: "state-export.ts",
    fn: "/api/v1/devices/:motebitId",
    snippet: "const devices = await identityManager.listDevices(motebitId);",
    verdict: "ROWS AS ROWS: signed export of the device list",
  },
  {
    file: "succession-apply.ts",
    fn: "departureFrom",
    snippet: '.prepare("SELECT 1 FROM devices WHERE motebit_id = ? AND public_key = ? LIMIT 1")',
    verdict:
      "DEPARTURE DEVICE RUNG (#736, main's rule): a rotation signed by that row's key departs that row only; never the holder",
  },
  {
    file: "sync-routes.ts",
    fn: "/api/v1/devices/register-self",
    snippet:
      "const existingDevice = await identityManager.loadDeviceById(body.device_id, body.motebit_id);",
    verdict: "PER-DEVICE: register-self's own device row",
  },
  {
    file: "sync-routes.ts",
    fn: "/api/v1/agents/:motebitId/devices/:deviceId/hardware-attestation",
    snippet: "const device = await identityManager.loadDeviceById(deviceId, motebitId);",
    verdict: "PER-DEVICE: hardware attestation verified under that device's own row",
  },
  {
    file: "task-answer.ts",
    fn: "verifySignature",
    snippet: "const devices = await identityManager.listDevices(asMotebitId(receipt.motebit_id));",
    verdict:
      "SIGNATURE READER / RECEIPT HEAL: receipt and sub-receipt keys — acceptance needs that key's signature; the heal moves the registry only to an embedded key whose signature over THIS receipt verifies",
  },
  {
    file: "task-answer.ts",
    fn: "verifySignature",
    snippet: "const devices = await identityManager.listDevices(asMotebitId(receipt.motebit_id));",
    verdict:
      "SIGNATURE READER / RECEIPT HEAL: receipt and sub-receipt keys — acceptance needs that key's signature; the heal moves the registry only to an embedded key whose signature over THIS receipt verifies",
  },
  {
    file: "tasks.ts",
    fn: "settleLocalAnswer",
    snippet: "const subDevices = await identityManager.listDevices(asMotebitId(sub.motebit_id));",
    verdict:
      "SIGNATURE READER: a sub-receipt verified under the delegated agent's row key only when it has no holder or registry key — acceptance needs that key's own signature",
  },
];

const key = (s: DeviceRowSite): string => `${s.file} | ${s.fn} | ${s.snippet}`;

function multiset(keys: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

/** The problems the inventory reports for `found` sites against the registry. */
export function deviceRowProblems(found: DeviceRowSite[]): string[] {
  const have = multiset(found.map(key));
  const want = multiset(DEVICE_ROW_SITES.map(key));
  const problems: string[] = [];
  for (const [k, n] of have) {
    const w = want.get(k) ?? 0;
    if (n > w) {
      problems.push(
        `UNCLASSIFIED device-row read: ${k}. A device row is never evidence of the identity's key (#875: /pairing/claim writes unproven rows). Use the bearer's verified key (c.get("callerVerifiedKey")), the proven holder (holderKeyOf) or the served key (servedIdentityKey); if this read verifies only that device's own token/signature, or is a guard that blocks, register it in DEVICE_ROW_SITES with its verdict.`,
      );
    }
  }
  for (const [k, w] of want) {
    if ((have.get(k) ?? 0) < w) {
      problems.push(`STALE entry: ${k} — no such read any more; remove or update the entry.`);
    }
  }
  return problems;
}

describe("a device row is never evidence of the identity's key — every read site is classified (#875)", () => {
  it("the device-row read sites equal the registered, justified sites", () => {
    const { files, sites } = scanDeviceRowSites(SRC);
    // Aperture: what was examined.
    console.log(
      `device-row reads: ${files} relay source file(s) scanned (excluding __tests__), ${sites.length} read site(s), ${DEVICE_ROW_SITES.length} registered`,
    );
    expect(deviceRowProblems(sites)).toEqual([]);
  });

  it("bites: a lowercase SELECT, a loadDevice(…)?.public_key, a [...keysHeldBy()][0], and a same-file swap are each unclassified", () => {
    const { sites } = scanDeviceRowSites(SRC);
    const plant = (file: string, fn: string, line: string): DeviceRowSite[] => [
      ...sites,
      { file, fn, snippet: line },
    ];
    // Each tamper is a line the scanner would find (the regex is exercised).
    const tampers = [
      'const k = db.prepare("select public_key from devices where motebit_id = ?").get(id);',
      "const k = (await identityManager.loadDevice(d))?.public_key;",
      "const k = [...keysHeldBy(db, motebitId)][0];",
    ];
    for (const t of tampers) {
      expect(scanLine(t), t).toBe(true);
      expect(
        deviceRowProblems(plant("credentials.ts", "/api/v1/credentials/:motebitId/reputation", t))
          .length,
      ).toBe(1);
    }
    // A same-file swap: the capabilities route's sanctioned list read replaced
    // by a first-row key read — the sanctioned site goes stale AND the new one
    // is unclassified.
    const swapped = sites.map((s) =>
      s.file === "agents.ts" && s.fn === "/agent/:motebitId/capabilities"
        ? {
            ...s,
            snippet:
              'const publicKey = (await identityManager.listDevices(motebitId))[0]?.public_key ?? "";',
          }
        : s,
    );
    expect(deviceRowProblems(swapped).length).toBe(2);
  });
});

import { DEVICE_ROW_READ } from "./device-row-sites.js";
function scanLine(line: string): boolean {
  return DEVICE_ROW_READ.test(line);
}
