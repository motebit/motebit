/**
 * identity-keys — the holder and the resolvers for "this identity's key"
 * (#703, docs/proposals/identity-key-state-v1.md §5, §5a, §5b).
 *
 * Until now the relay's knowledge of an identity's current key lived in
 * whichever table the door that proved it happened to write — `agent_registry`
 * (9 rows in production), `devices` (the rest), `relay_key_successions` (the
 * chain) — and three hand-rolled resolvers read them with two different
 * precedences. The first build of this module was withdrawn (#747) after two
 * review rounds found the same defect eight times: a door moved to the holder
 * while a sibling kept reasoning from the old tables. The cause was that the
 * relay asks THREE different questions about a key and had one function for
 * them (§5b):
 *
 *  - Q-current — what is THE identity's key?               `identityKeyFor`
 *  - Q-held    — which keys does this identity answer to?   `keysHeldBy`
 *  - Q-device  — does THIS device's key verify this token?  auth.ts, per `did`
 *
 * `identity_keys` is the holder. It is written by every door that PROVES a
 * key, after the door has done its proving under its own principal (the doors
 * `check-identity-authority-writers` enumerates), through the two writers
 * here: `recordIdentityKey` (unconditional — a verified succession, a migration
 * arrival, an authenticated registration) and `recordFirstIdentityKey` (the
 * public doors — only when nothing is proven yet and no device row disagrees).
 * The migration backfills it in the resolver's own precedence and only where
 * the answer is unambiguous (D5: a wrong key served from a foundation-law route
 * is a planted binding; not knowing is honest, guessing is not).
 *
 * `provenIdentityKey` is the AUTHORITY: holder, else registry, else chain head
 * — never a device row (§5a A4: a paired device holds its own key, and a
 * rotation or registration must not be forced to depart from a key the
 * identity never held). `identityKeyFor` is the READER: the authority, else the
 * one key every keyed device row agrees on — for the doors that would
 * otherwise answer nothing. One precedence list; the reader is the authority
 * plus one rung.
 *
 * This module is the only one that reads any of the four tables for a key;
 * Part B's `check-identity-key-resolver` locks that.
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

/** Which rung answered. `holder` is the only rung a door wrote on purpose. */
export type IdentityKeyRung = "holder" | "registry" | "chain" | "devices";
/** The rungs a door may treat as the identity's key on file — never `devices` (§5a A4). */
export type ProvenRung = Exclude<IdentityKeyRung, "devices">;
export type ProvenIdentityKey = Omit<IdentityKey, "rung"> & { rung: ProvenRung };

export interface IdentityKey {
  publicKey: string;
  /** The one guardian truth (`identityGuardianFor`), whichever rung answered. */
  guardianPublicKey: string | null;
  rung: IdentityKeyRung;
  /** The door that recorded the holder's key; null when a fallback rung answered. */
  source: IdentityKeySource | null;
  /** When this relay first held a key for the identity (ms epoch). */
  firstSeen: number;
}

const HEX_64 = /^[0-9a-f]{64}$/i;

/** `''` is not a key on file (§5a A5): a legacy row with an empty key reads as none. */
const keyOrNull = (k: string | null | undefined): string | null => (k != null && k !== "" ? k : null);

// ── The raw reads. Each rung has ONE reader; the resolvers compose them. ──

function readHolder(db: DatabaseDriver, motebitId: string) {
  return db
    .prepare(
      "SELECT public_key, guardian_public_key, source, COALESCE(first_seen, updated_at) AS first_seen FROM identity_keys WHERE motebit_id = ?",
    )
    .get(motebitId) as
    | {
        public_key: string;
        guardian_public_key: string | null;
        source: IdentityKeySource;
        first_seen: number;
      }
    | undefined;
}

function readRegistry(db: DatabaseDriver, motebitId: string) {
  return db
    .prepare(
      "SELECT public_key, guardian_public_key, registered_at FROM agent_registry WHERE motebit_id = ?",
    )
    .get(motebitId) as
    | { public_key: string | null; guardian_public_key: string | null; registered_at: number }
    | undefined;
}

function readChainHead(db: DatabaseDriver, motebitId: string) {
  return db
    .prepare(
      "SELECT new_public_key, (SELECT MIN(timestamp) FROM relay_key_successions WHERE motebit_id = ?) AS first_link FROM relay_key_successions WHERE motebit_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(motebitId, motebitId) as { new_public_key: string; first_link: number } | undefined;
}

function readDeviceKeys(db: DatabaseDriver, motebitId: string): string[] {
  return (
    db
      .prepare("SELECT DISTINCT public_key FROM devices WHERE motebit_id = ? AND public_key != ''")
      .all(motebitId) as Array<{ public_key: string }>
  ).map((r) => r.public_key);
}

/** The registry's key as a key on file — `''` is none. For reporting a rung, never for precedence. */
export function registryKeyOf(db: DatabaseDriver, motebitId: string): string | null {
  return keyOrNull(readRegistry(db, motebitId)?.public_key);
}

/** The newest recorded link's `new_public_key`, by insertion order. */
export function chainHeadOf(db: DatabaseDriver, motebitId: string): string | null {
  return readChainHead(db, motebitId)?.new_public_key ?? null;
}

/** The holder's key, when a door has recorded one. */
export function holderKeyOf(db: DatabaseDriver, motebitId: string): string | null {
  return readHolder(db, motebitId)?.public_key ?? null;
}

// ── The resolvers. ──

/**
 * The one guardian truth (§5a A3): the holder's guardian, else the registry's
 * (the pre-holder copy the backfill already folded in). Every door that proves
 * a guardian writes the holder; every reader asks here.
 */
export function identityGuardianFor(db: DatabaseDriver, motebitId: string): string | null {
  return (
    keyOrNull(readHolder(db, motebitId)?.guardian_public_key) ??
    keyOrNull(readRegistry(db, motebitId)?.guardian_public_key)
  );
}

/**
 * The AUTHORITY — the key a rotation may depart from and a registration is
 * compared against. Holder, else registry, else chain head; never a device
 * row (§5a A4). Null when the identity has proven no key to this relay.
 */
export function provenIdentityKey(db: DatabaseDriver, motebitId: string): ProvenIdentityKey | null {
  const held = readHolder(db, motebitId);
  if (held) {
    return {
      publicKey: held.public_key,
      guardianPublicKey: identityGuardianFor(db, motebitId),
      rung: "holder",
      source: held.source,
      firstSeen: held.first_seen,
    };
  }
  const reg = readRegistry(db, motebitId);
  const registryKey = keyOrNull(reg?.public_key);
  if (registryKey !== null) {
    return {
      publicKey: registryKey,
      guardianPublicKey: identityGuardianFor(db, motebitId),
      rung: "registry",
      source: null,
      firstSeen: reg!.registered_at,
    };
  }
  const head = readChainHead(db, motebitId);
  if (head) {
    return {
      publicKey: head.new_public_key,
      guardianPublicKey: identityGuardianFor(db, motebitId),
      rung: "chain",
      source: null,
      firstSeen: reg?.registered_at ?? head.first_link,
    };
  }
  return null;
}

/**
 * The READER — what the relay serves as the identity's current key. The
 * authority, else the one key EVERY keyed device row agrees on (a device
 * linked without key transfer holds its own key, so disagreeing rows answer
 * nothing — D5). Null when the relay holds no unambiguous key.
 */
export function identityKeyFor(db: DatabaseDriver, motebitId: string): IdentityKey | null {
  const proven = provenIdentityKey(db, motebitId);
  if (proven) return proven;
  const devices = readDeviceKeys(db, motebitId);
  if (devices.length !== 1) return null;
  const first = db
    .prepare("SELECT MIN(registered_at) AS t FROM devices WHERE motebit_id = ?")
    .get(motebitId) as { t: number };
  return {
    publicKey: devices[0]!,
    guardianPublicKey: identityGuardianFor(db, motebitId),
    rung: "devices",
    source: null,
    firstSeen: first.t,
  };
}

/**
 * Q-held — every key this identity answers to, lower-cased for comparison
 * the way the public-door guard compares: the holder's key, the registry's,
 * the recorded chain head's, and every keyed device row's. The guard's law
 * (§5b L1): this set contains whatever `identityKeyFor` answers, so a key
 * auth would verify against is a key the guard already counts as held. The
 * chain head is here because L1 said so — the first draft left it out, and a
 * deregistered daemon that had rotated (chain only) would have admitted a
 * stranger's device while auth verified its tokens against that head.
 * Empty means "no owner yet".
 */
export function keysHeldBy(db: DatabaseDriver, motebitId: string): Set<string> {
  const held = new Set<string>();
  const add = (k: string | null | undefined) => {
    const key = keyOrNull(k);
    if (key !== null) held.add(key.toLowerCase());
  };
  add(holderKeyOf(db, motebitId));
  add(registryKeyOf(db, motebitId));
  add(chainHeadOf(db, motebitId));
  for (const k of readDeviceKeys(db, motebitId)) add(k);
  return held;
}

// ── The writers. ──

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
  // Stored as given, never normalized: every sibling store keeps the caller's
  // spelling and rule 21's comparisons are EXACT, so a lowercased holder would
  // refuse an uppercase registrant's own rotation.
  const key = input.publicKey;
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

/**
 * The public doors' writer (`/agents/bootstrap`, `/devices/register-self`).
 * They verified a signature by `publicKey` over the request, so the key is
 * proven — but it is THE IDENTITY's key only when the identity has proven
 * nothing yet (§5a A2: "new" means `provenIdentityKey === null`, never "no
 * identities row") and no keyed device row holds another key (a paired
 * device's own key passes the guard and is not the identity's — D5). Returns
 * whether it wrote. Called unconditionally after the guard; a second machine
 * after key transfer, or a restore from seed, is a no-op here.
 */
export function recordFirstIdentityKey(
  db: DatabaseDriver,
  input: { motebitId: string; publicKey: string; source: "bootstrap" | "register-self"; now: number },
): boolean {
  if (provenIdentityKey(db, input.motebitId) !== null) return false;
  const key = input.publicKey.toLowerCase();
  for (const held of keysHeldBy(db, input.motebitId)) {
    if (held !== key) return false;
  }
  recordIdentityKey(db, input);
  return true;
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
