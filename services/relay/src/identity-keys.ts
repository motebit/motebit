/**
 * identity-keys — ONE holder and ONE resolver for "what is this identity's
 * key" (#703, docs/proposals/identity-key-state-v1.md §5).
 *
 * Until now the relay's knowledge of an identity's current key lived in
 * whichever table the door that proved it happened to write — `agent_registry`
 * (9 rows in production), `devices` (the rest), `relay_key_successions` (the
 * chain) — and three hand-rolled resolvers read them with two different
 * precedences (auth.ts device-first, verify-receipt registry-first,
 * `departureFrom` registry → chain → device). That is the class the #702
 * review rounds found twice: a predicate with an authority, re-derived
 * elsewhere.
 *
 * `identity_keys` is written by every door that PROVES a key — register,
 * bootstrap, register-self, a recorded succession, migration arrival — after
 * the door has done its proving under its own principal (they are the doors
 * `check-identity-authority-writers` already enumerates; this table joins
 * that registry with `recordIdentityKey` as its one writer). The migration
 * backfills it in the same precedence the resolver uses, and only where the
 * answer is unambiguous (D5: a wrong key served from a foundation-law route
 * is a planted binding; not knowing is honest, guessing is not). Production
 * on 2026-09-24: 50 of 50 identities unambiguous, 0 left unfilled.
 *
 * `identityKeyFor` is the resolver. Order: `identity_keys`, else the registry
 * key, else the recorded chain head, else the device rows — and the device
 * rung answers only when EVERY keyed device row agrees, because a device
 * linked without key transfer holds its own key, not the identity's. The
 * per-device question ("does THIS device's token verify") is a different
 * question and stays in auth.ts; this resolver is its FALLBACK for
 * service-mode callers, not its replacement.
 */

import type { DatabaseDriver } from "@motebit/persistence";

/** Which door proved the key that is on file. Closed set; a new door adds a name here. */
export const IDENTITY_KEY_SOURCES = [
  "register",
  "bootstrap",
  "register-self",
  "succession",
  "migration",
  "backfill:registry",
  "backfill:chain",
  "backfill:devices",
] as const;
export type IdentityKeySource = (typeof IDENTITY_KEY_SOURCES)[number];

export interface IdentityKey {
  publicKey: string;
  guardianPublicKey: string | null;
  /** Where the answer came from — the holder, or a fallback rung. */
  source: IdentityKeySource | "registry" | "chain" | "devices";
  /** When this relay first held a key for the identity (ms epoch), when known. */
  firstSeen: number | null;
}

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Record a key a door has just PROVED. Upsert: a later proof replaces the key;
 * the guardian is kept unless the door supplies one. The caller is a door
 * with a registered principal — this function proves nothing itself.
 */
export function recordIdentityKey(
  db: DatabaseDriver,
  input: {
    motebitId: string;
    publicKey: string;
    guardianPublicKey?: string | null;
    source: IdentityKeySource;
    now: number;
  },
): void {
  const key = input.publicKey.toLowerCase();
  if (!HEX_64.test(key)) {
    throw new Error(`recordIdentityKey: not a 32-byte hex public key (source ${input.source})`);
  }
  db.prepare(
    `INSERT INTO identity_keys (motebit_id, public_key, guardian_public_key, source, first_seen, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(motebit_id) DO UPDATE SET
       public_key = excluded.public_key,
       guardian_public_key = COALESCE(excluded.guardian_public_key, identity_keys.guardian_public_key),
       source = excluded.source,
       updated_at = excluded.updated_at`,
  ).run(input.motebitId, key, input.guardianPublicKey ?? null, input.source, input.now, input.now);
}

/** The ONE resolver. Null when the relay holds no unambiguous key for the identity. */
export function identityKeyFor(db: DatabaseDriver, motebitId: string): IdentityKey | null {
  const held = db
    .prepare(
      "SELECT public_key, guardian_public_key, source, first_seen FROM identity_keys WHERE motebit_id = ?",
    )
    .get(motebitId) as
    | {
        public_key: string;
        guardian_public_key: string | null;
        source: IdentityKeySource;
        first_seen: number | null;
      }
    | undefined;
  if (held) {
    return {
      publicKey: held.public_key,
      guardianPublicKey: held.guardian_public_key,
      source: held.source,
      firstSeen: held.first_seen,
    };
  }

  const reg = db
    .prepare(
      "SELECT public_key, guardian_public_key, registered_at FROM agent_registry WHERE motebit_id = ?",
    )
    .get(motebitId) as
    | { public_key: string | null; guardian_public_key: string | null; registered_at: number }
    | undefined;
  if (reg?.public_key != null && reg.public_key !== "") {
    return {
      publicKey: reg.public_key,
      guardianPublicKey: reg.guardian_public_key,
      source: "registry",
      firstSeen: reg.registered_at,
    };
  }

  const head = db
    .prepare(
      "SELECT new_public_key FROM relay_key_successions WHERE motebit_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(motebitId) as { new_public_key: string } | undefined;
  if (head) {
    return {
      publicKey: head.new_public_key,
      guardianPublicKey: reg?.guardian_public_key ?? null,
      source: "chain",
      firstSeen: reg?.registered_at ?? null,
    };
  }

  const devices = db
    .prepare("SELECT DISTINCT public_key FROM devices WHERE motebit_id = ? AND public_key != ''")
    .all(motebitId) as Array<{ public_key: string }>;
  if (devices.length === 1) {
    const first = db
      .prepare("SELECT MIN(registered_at) AS t FROM devices WHERE motebit_id = ?")
      .get(motebitId) as { t: number | null };
    return {
      publicKey: devices[0]!.public_key,
      guardianPublicKey: reg?.guardian_public_key ?? null,
      source: "devices",
      firstSeen: first.t,
    };
  }
  return null;
}

/**
 * The backfill, as SQL the migration runs once and a test can run against a
 * planted database: registry key, else chain head, else the one key every
 * keyed device row agrees on. Identities with none of these — or with
 * disagreeing device rows — are left for their next bootstrap or register.
 */
export const IDENTITY_KEYS_BACKFILL_SQL = `
  INSERT INTO identity_keys (motebit_id, public_key, guardian_public_key, source, first_seen, updated_at)
  SELECT p.motebit_id,
         COALESCE(p.reg, p.head, p.dev) AS public_key,
         p.guardian,
         CASE WHEN p.reg IS NOT NULL THEN 'backfill:registry'
              WHEN p.head IS NOT NULL THEN 'backfill:chain'
              ELSE 'backfill:devices' END AS source,
         COALESCE(p.registered_at, p.first_device, ?) AS first_seen,
         ? AS updated_at
  FROM (
    SELECT i.motebit_id,
      (SELECT r.public_key FROM agent_registry r WHERE r.motebit_id = i.motebit_id AND r.public_key != '') AS reg,
      (SELECT r.guardian_public_key FROM agent_registry r WHERE r.motebit_id = i.motebit_id) AS guardian,
      (SELECT r.registered_at FROM agent_registry r WHERE r.motebit_id = i.motebit_id) AS registered_at,
      (SELECT s.new_public_key FROM relay_key_successions s WHERE s.motebit_id = i.motebit_id ORDER BY s.id DESC LIMIT 1) AS head,
      (SELECT CASE WHEN COUNT(DISTINCT d.public_key) = 1 THEN MIN(d.public_key) END
         FROM devices d WHERE d.motebit_id = i.motebit_id AND d.public_key != '') AS dev,
      (SELECT MIN(d.registered_at) FROM devices d WHERE d.motebit_id = i.motebit_id) AS first_device
    FROM (
      SELECT motebit_id FROM agent_registry
      UNION SELECT motebit_id FROM devices
      UNION SELECT motebit_id FROM relay_key_successions
    ) i
  ) p
  WHERE COALESCE(p.reg, p.head, p.dev) IS NOT NULL
    AND p.motebit_id NOT IN (SELECT motebit_id FROM identity_keys)
`;
