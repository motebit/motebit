/**
 * identity-keys — the holder of "this identity's key", written by EVIDENCE,
 * never by doors (#703; docs/proposals/identity-key-state-v1.md §5e, §5f).
 *
 * Two builds were withdrawn (#747, #750) because a door that merely passed
 * a guard wrote the identity's key: a paired device's own key, an unsigned
 * bootstrap, an unbound body key, an alternate spelling. §5f's founder
 * decision: the holder is the ONLY authority, and only evidence writes it —
 *
 *  - E-sov   the id is the sovereign commitment to K (exact id, DA3) AND the
 *            request proves CURRENT possession of K (DB1) — `proveSovereignFirstKey`
 *            + `recordFirstIdentityKey`, as a first key only;
 *  - E-link  a succession link verified by the HELD key (`applySuccession`);
 *  - E-mig   a migration arrival's verified sovereign binding;
 *  - E-main  the v42 backfill's one-time transplant of main's registry key;
 *  - E-op    an operator registration of a SERVICE identity with no holder, no
 *            device row and no chain — the one case main already trusts the
 *            operator for, and one no device can contest (§5f, build-time).
 *
 * Two kinds of question, never conflated:
 *
 *  - AUTHORITY    — `identityKey`: the holder, else null. What the relay
 *                   serves (§7.6 bundle, identity log, /succession), what a
 *                   rotation departs from, what a registration is checked
 *                   against. The registry key and the chain head are NOT
 *                   authority: anything may write them, so nothing reads
 *                   them as the identity's key (G1).
 *  - VERIFICATION — `verificationKeyFor`: the holder, else exactly what that
 *                   reader reads on main. Unfilled identities verify
 *                   byte-identically to main; filled ones against the proven key.
 *
 * The public-door guard asks a third, per-SET question: `keysHeldBy`.
 */

import { deriveSovereignMotebitId, verifySovereignBinding } from "@motebit/crypto";
import type { DatabaseDriver } from "@motebit/persistence";

/** Which evidence recorded the key on file. Closed set; new evidence adds a name here. */
export const IDENTITY_KEY_SOURCES = [
  "register",
  "register-self",
  "operator",
  "succession",
  "migration",
  "backfill:registry",
] as const;
export type IdentityKeySource = (typeof IDENTITY_KEY_SOURCES)[number];

export interface IdentityKey {
  publicKey: string;
  /** The one guardian truth (`identityGuardianFor`). */
  guardianPublicKey: string | null;
  /** The evidence that recorded this key. */
  source: IdentityKeySource;
  /** When this relay first held a key for the identity (ms epoch). */
  firstSeen: number;
}

/** A key's shape as the writer stores it (spelling preserved — DA10). */
const HEX_64_ANY_CASE = /^[0-9a-f]{64}$/i;
/** The canonical spelling a NEW key must arrive in (DA1). */
const HEX_64_CANONICAL = /^[0-9a-f]{64}$/;

/** `''` is not a key on file (§5a A5). */
const keyOrNull = (k: string | null | undefined): string | null =>
  k != null && k !== "" ? k : null;

// ── The raw reads. ──

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

function readDeviceKeys(db: DatabaseDriver, motebitId: string): string[] {
  return (
    db
      .prepare("SELECT DISTINCT public_key FROM devices WHERE motebit_id = ? AND public_key != ''")
      .all(motebitId) as Array<{ public_key: string }>
  ).map((r) => r.public_key);
}

/** The registry's key — discovery's copy, NOT authority (§5f). `''` is none. */
export function registryKeyOf(db: DatabaseDriver, motebitId: string): string | null {
  return keyOrNull(readRegistry(db, motebitId)?.public_key);
}

/** The newest recorded link's `new_public_key`, by insertion order — a record, NOT authority (§5f). */
export function chainHeadOf(db: DatabaseDriver, motebitId: string): string | null {
  return (
    (
      db
        .prepare(
          "SELECT new_public_key FROM relay_key_successions WHERE motebit_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(motebitId) as { new_public_key: string } | undefined
    )?.new_public_key ?? null
  );
}

/** The holder's key, when evidence has recorded one. */
export function holderKeyOf(db: DatabaseDriver, motebitId: string): string | null {
  return readHolder(db, motebitId)?.public_key ?? null;
}

// ── The questions. ──

/**
 * The one guardian truth (§5a A3): the holder's guardian, else the registry's.
 * Every verified attestation writes the holder (DA6); every reader asks here.
 */
export function identityGuardianFor(db: DatabaseDriver, motebitId: string): string | null {
  return (
    keyOrNull(readHolder(db, motebitId)?.guardian_public_key) ??
    keyOrNull(readRegistry(db, motebitId)?.guardian_public_key)
  );
}

/**
 * AUTHORITY (§5f) — the holder, else null. Never the registry, the chain head
 * or a device row: each of those can be written without evidence, and reading
 * one as the identity's key is how an unproven write became authority (G1).
 */
export function identityKey(db: DatabaseDriver, motebitId: string): IdentityKey | null {
  const held = readHolder(db, motebitId);
  if (!held) return null;
  return {
    publicKey: held.public_key,
    guardianPublicKey: identityGuardianFor(db, motebitId),
    source: held.source,
    firstSeen: held.first_seen,
  };
}

/**
 * VERIFICATION (§5f) — the key a signature reader verifies against: the
 * holder, else `mainRead` — exactly what that reader read before the holder
 * existed. An unfilled identity therefore verifies byte-identically to main;
 * a filled one against its proven key. `''` / null / undefined read as none.
 */
export function verificationKeyFor(
  db: DatabaseDriver,
  motebitId: string,
  mainRead: string | null | undefined,
): string | null {
  return holderKeyOf(db, motebitId) ?? keyOrNull(mainRead);
}

/**
 * The public-door guard's SET — every key this identity answers to: the
 * holder, the registry's, and every keyed device row's, compared EXACTLY
 * (DA1/DB4 — a case-folding guard let `UPPER(K)` join as an extra device a
 * rotation would miss). L1 holds by construction: every key auth or
 * `verificationKeyFor` can verify a token against is in this set. Empty means
 * "no owner yet".
 */
export function keysHeldBy(db: DatabaseDriver, motebitId: string): Set<string> {
  const held = new Set<string>();
  const add = (k: string | null | undefined) => {
    const key = keyOrNull(k);
    if (key !== null) held.add(key);
  };
  add(holderKeyOf(db, motebitId));
  add(registryKeyOf(db, motebitId));
  for (const k of readDeviceKeys(db, motebitId)) add(k);
  return held;
}

/**
 * DA1/DB4 — may this key ENTER through a door? Canonical lowercase hex, or a
 * key that EXACTLY equals one already on file for the identity (holder,
 * registry, chain head, a device row) — continuity, so a legacy identity
 * whose stored spelling predates the rule keeps working. `hexToBytes` is
 * lenient (`"a!"` reads as `0x0a`), so lowercasing is not canonicalization:
 * anything else is refused, never normalized.
 */
export function admitKey(db: DatabaseDriver, motebitId: string, key: string): boolean {
  if (HEX_64_CANONICAL.test(key)) return true;
  if (key === "") return false;
  return (
    key === holderKeyOf(db, motebitId) ||
    key === registryKeyOf(db, motebitId) ||
    key === chainHeadOf(db, motebitId) ||
    readDeviceKeys(db, motebitId).includes(key)
  );
}

/** A NEW key with no identity context (a key that has never been on file): canonical only. */
export function isCanonicalKey(key: string): boolean {
  return HEX_64_CANONICAL.test(key);
}

// ── The writers. ──

/**
 * Record a key evidence has just PROVED (E-link, E-mig, or through
 * `recordFirstIdentityKey`). Upsert; the guardian is kept unless given one.
 * The caller holds the evidence — this function proves nothing itself.
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
  // Stored as given: spelling is part of signed chains and anchored leaves
  // (DA10), and every comparison is exact.
  const key = input.publicKey;
  if (!HEX_64_ANY_CASE.test(key)) {
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

declare const sovereignFirstKey: unique symbol;
/**
 * E-sov's arithmetic half, as a value only `proveSovereignFirstKey` can make:
 * the id is EXACTLY the sovereign commitment to the key (DA3 — a case-folded
 * id would mint an alias). The door supplies the other half — CURRENT
 * possession of the key (DB1): register-self's signature by it, or a bearer
 * token verified by the device row that holds it.
 */
export type SovereignFirstKey = {
  readonly motebitId: string;
  readonly publicKey: string;
  readonly [sovereignFirstKey]: true;
};

export async function proveSovereignFirstKey(
  motebitId: string,
  publicKey: string,
): Promise<SovereignFirstKey | null> {
  if (!HEX_64_CANONICAL.test(publicKey)) return null;
  if (motebitId.startsWith("did:key:")) {
    if (!(await verifySovereignBinding(motebitId, publicKey))) return null;
  } else if (motebitId !== (await deriveSovereignMotebitId(publicKey))) {
    return null;
  }
  return { motebitId, publicKey } as SovereignFirstKey;
}

/**
 * E-sov's write (DA2): ONE synchronous transaction that re-reads and writes —
 * only when the identity has no holder, no recorded chain, no registry key
 * other than this one (absent, `''`, or equal), and every key it answers to
 * IS this one. A rotation that
 * lands while the door was hashing makes this a no-op; a leftover genesis row
 * beside a paired device's own key leaves the identity unfilled. Returns
 * whether it wrote. The door must have proven CURRENT possession (DB1).
 */
export function recordFirstIdentityKey(
  db: DatabaseDriver,
  proof: SovereignFirstKey,
  input: { source: "register" | "register-self"; guardianPublicKey?: string | null; now: number },
): boolean {
  return db.transaction(() => {
    const id = proof.motebitId;
    if (holderKeyOf(db, id) !== null) return false;
    if (chainHeadOf(db, id) !== null) return false;
    // A registry key that DIFFERS blocks the write (it may be main's authority,
    // transplanted or not); one equal to this key is discovery's copy of the
    // same answer (§5f build-time amendment — a keyless daemon registration
    // publishes it before the holder is filled).
    const reg = registryKeyOf(db, id);
    if (reg !== null && reg !== proof.publicKey) return false;
    for (const held of keysHeldBy(db, id)) {
      if (held !== proof.publicKey) return false;
    }
    recordIdentityKey(db, {
      motebitId: id,
      publicKey: proof.publicKey,
      guardianPublicKey: input.guardianPublicKey ?? null,
      source: input.source,
      now: input.now,
    });
    return true;
  });
}

/**
 * E-op's write (§5f, found while building): an operator-bearer registration
 * of a SERVICE identity — no holder, no device row, no recorded chain. Main
 * trusts the operator's registry key as this identity's authority; without
 * this, an operator-registered service identity first seen after v42 could
 * never rotate or recover through its guardian (§8(b)). It cannot recreate
 * G1, which needs device rows. One synchronous transaction, re-reading.
 */
export function recordOperatorServiceKey(
  db: DatabaseDriver,
  input: { motebitId: string; publicKey: string; guardianPublicKey?: string | null; now: number },
): boolean {
  return db.transaction(() => {
    const id = input.motebitId;
    if (holderKeyOf(db, id) !== null) return false;
    if (chainHeadOf(db, id) !== null) return false;
    if (readDeviceKeys(db, id).length > 0) return false;
    if (db.prepare("SELECT 1 FROM devices WHERE motebit_id = ? LIMIT 1").get(id) != null) {
      return false;
    }
    recordIdentityKey(db, {
      motebitId: id,
      publicKey: input.publicKey,
      guardianPublicKey: input.guardianPublicKey ?? null,
      source: "operator",
      now: input.now,
    });
    return true;
  });
}

/**
 * The key a keyless `/agents/register` publishes to discovery (DA5): the
 * holder, else the one key every keyed device row agrees on, else `''`. A
 * discovery copy, NOT authority (§5f) — never written to the holder.
 */
export function discoveryKeyFor(db: DatabaseDriver, motebitId: string): string {
  const held = holderKeyOf(db, motebitId);
  if (held !== null) return held;
  const devices = readDeviceKeys(db, motebitId);
  return devices.length === 1 ? devices[0]! : "";
}

/**
 * A verified guardian attestation, on the holder the identity already has
 * (DA6 — every verified attestation, whatever the key evidence). No holder ⇒
 * nothing to update: the registry's guardian is then the one truth. The door
 * format-checks the guardian BEFORE any write (DB4).
 */
export function recordIdentityGuardian(
  db: DatabaseDriver,
  input: { motebitId: string; guardianPublicKey: string; now: number },
): void {
  if (!HEX_64_ANY_CASE.test(input.guardianPublicKey)) {
    throw new Error("recordIdentityGuardian: guardian must be a 64-hex Ed25519 public key");
  }
  db.prepare(
    "UPDATE identity_keys SET guardian_public_key = ?, updated_at = ? WHERE motebit_id = ?",
  ).run(input.guardianPublicKey, input.now, input.motebitId);
}

/**
 * The backfill (E-main), as SQL the migration runs once and a test can run
 * against a planted database: main's registry key, and NOTHING else — the
 * one time the registry is read as authority, a transplant of what main
 * already served (spelling as-is, DA10). Never a device row (R4: a lone
 * paired device's own key is indistinguishable in SQL from the identity's).
 * Never the chain head: a device-rung rotation appends a link from a paired
 * device's own key, so the head can be a key the identity never proved, and
 * main never served it (#753 review item 1). An identity with no registry key
 * stays unfilled until E-sov, E-link, E-mig or E-op; `departureFrom`'s device
 * rung lets it rotate meanwhile.
 */
export const IDENTITY_KEYS_BACKFILL_SQL = `
  INSERT INTO identity_keys (motebit_id, public_key, guardian_public_key, source, first_seen, updated_at)
  SELECT p.motebit_id,
         p.reg AS public_key,
         p.guardian,
         'backfill:registry' AS source,
         COALESCE(p.registered_at, p.first_device, ?) AS first_seen,
         ? AS updated_at
  FROM (
    SELECT i.motebit_id,
      (SELECT r.public_key FROM agent_registry r WHERE r.motebit_id = i.motebit_id AND r.public_key != '') AS reg,
      (SELECT r.guardian_public_key FROM agent_registry r WHERE r.motebit_id = i.motebit_id) AS guardian,
      (SELECT r.registered_at FROM agent_registry r WHERE r.motebit_id = i.motebit_id) AS registered_at,
      (SELECT MIN(d.registered_at) FROM devices d WHERE d.motebit_id = i.motebit_id) AS first_device
    FROM (
      SELECT motebit_id FROM agent_registry
      UNION SELECT motebit_id FROM devices
      UNION SELECT motebit_id FROM relay_key_successions
    ) i
  ) p
  WHERE p.reg IS NOT NULL
    AND p.motebit_id NOT IN (SELECT motebit_id FROM identity_keys)
`;
