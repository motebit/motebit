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
 * A sovereign `motebit_id` is a UUIDv8 (`deriveSovereignMotebitId`): the
 * version nibble is 8. Matched case-INSENSITIVELY on purpose — an upper-case
 * spelling of V's sovereign id is a distinct row that a case-insensitive
 * reader (`verifySovereignBinding`) would still read as V's, so it claims
 * sovereignty too (and, the commitment being lower-case, never equals one).
 * Legacy ids are UUIDv7 and never match.
 */
const SOVEREIGN_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Whether `motebitId` claims to be the sovereign commitment to some key. */
export function claimsSovereignId(motebitId: string): boolean {
  return SOVEREIGN_ID_SHAPE.test(motebitId) || motebitId.startsWith("did:key:");
}

/**
 * The keys that may stand as a SOVEREIGN-shaped identity's key (#875 review
 * F1), or `null` for an id that claims no sovereignty (any proven key may
 * stand — a legacy id is first-come by construction).
 *
 * For a sovereign id a key is the identity's only when the id commits to it
 * (`proveSovereignFirstKey` — the genesis), or it is reached from a key that
 * stands by a link this relay RECORDED (each link's signatures were verified
 * from the departing key before it was recorded, `applySuccession`), or it is
 * a holder whose evidence was itself sovereign: E-sov (`register`,
 * `register-self` — the arithmetic, re-checked here anyway) or E-mig (an
 * arrival whose sovereign binding, possibly through a chain this relay never
 * saw, verified) — and, after an E-mig, the holder E-link moved on from it.
 * Proof of possession is NOT standing: before #875 any presenter could plant
 * its own key K_X under V's `deriveSovereignMotebitId(K_V)`, and a bearer that
 * planted row verifies proves only that K_X is X's. Every other key on file —
 * a device row, the registry column, a recorded evidence row, an E-main
 * (`backfill:registry`) or E-op holder, a chain rooted anywhere else — is a
 * squat for a sovereign id, never served and never an owner.
 *
 * `presented` adds a candidate genesis the caller is about to write.
 */
export async function sovereignLineage(
  db: DatabaseDriver,
  motebitId: string,
  presented?: string,
): Promise<Set<string> | null> {
  if (!claimsSovereignId(motebitId)) return null;
  const links = db
    .prepare(
      "SELECT old_public_key, new_public_key FROM relay_key_successions WHERE motebit_id = ?",
    )
    .all(motebitId) as Array<{ old_public_key: string; new_public_key: string }>;
  const candidates = new Set<string>(keysHeldBy(db, motebitId));
  for (const l of links) {
    candidates.add(l.old_public_key);
    candidates.add(l.new_public_key);
  }
  if (presented !== undefined && presented !== "") candidates.add(presented);

  const lineage = new Set<string>();
  for (const k of candidates) {
    if ((await proveSovereignFirstKey(motebitId, k)) !== null) lineage.add(k);
  }
  const held = readHolder(db, motebitId);
  if (held && (held.source === "migration" || held.source === "succession")) {
    // E-mig roots a chain this relay may never have seen; E-link moved the
    // holder only from the key it held. A succession holder stands when its
    // chain is rooted at a standing key (walked below) OR the identity
    // arrived by migration here (the arrival's key then E-linked onward).
    const arrived =
      held.source === "migration" ||
      db
        .prepare("SELECT 1 FROM relay_accepted_migrations WHERE motebit_id = ? LIMIT 1")
        .get(motebitId) != null;
    if (arrived) lineage.add(held.public_key);
  }
  // Forward over recorded links from every standing key.
  let grew = true;
  while (grew) {
    grew = false;
    for (const l of links) {
      if (lineage.has(l.old_public_key) && !lineage.has(l.new_public_key)) {
        lineage.add(l.new_public_key);
        grew = true;
      }
    }
  }
  return lineage;
}

/** Whether `key` may stand as `motebitId`'s key (`sovereignLineage`; always true for a non-sovereign id). */
export async function keyStandsFor(
  db: DatabaseDriver,
  motebitId: string,
  key: string,
): Promise<boolean> {
  const lineage = await sovereignLineage(db, motebitId, key);
  return lineage === null || lineage.has(key);
}

/** A served candidate stands: present, and in the lineage when the id is sovereign. */
function standsIn(lineage: Set<string> | null, k: string | null): k is string {
  return k !== null && (lineage === null || lineage.has(k));
}

/**
 * The key a relay route SERVES as this identity's (#875 review round 3): the
 * proven holder; else a registry key some request proved; else a key on file
 * that the id is the sovereign commitment to (arithmetic, true whoever wrote
 * the row); else null. Never the bare registry column, which a relay before
 * #875 wrote without proof, and never an arbitrary device row, which
 * `/pairing/claim` writes unsigned. Every route that hands an identity's key
 * to a third party — discover, the agent record, capabilities, the A2A card,
 * a relay-issued credential's subject — reads it here, so they cannot
 * disagree.
 *
 * For a SOVEREIGN-shaped id every candidate must also stand
 * (`sovereignLineage`, #875 review F1): a pre-#875 squat that a post-#875
 * request "proved" (X's own key, verified by X's own planted row) is never
 * served as V's. This is the one place the served key is decided, so an
 * evidence row — whoever wrote it, whenever — cannot serve a squat.
 */
export async function servedIdentityKey(
  db: DatabaseDriver,
  motebitId: string,
): Promise<string | null> {
  const lineage = await sovereignLineage(db, motebitId);
  // 1. The proven holder.
  const holder = holderKeyOf(db, motebitId);
  if (standsIn(lineage, holder)) return holder;
  // 2. A registry key some request PROVED (round 4): a legacy id registering
  //    with its own proven key after #875 is served it — serving ≠ binding,
  //    no holder is written. Served only while the registry still equals it.
  const proven = provenRegistryKeyOf(db, motebitId);
  if (standsIn(lineage, proven)) return proven;
  // 3. The sovereign commitment — only for an identity that has NEVER
  //    rotated. After a rotation the genesis key a device row may still carry
  //    is stale; a rotated identity is served its holder or proven registry
  //    key, else nothing (round 4, C2). A sovereign id's rotation is a link
  //    departing from its lineage; a chain a squatter rooted at its own key
  //    is no rotation of the identity (F1).
  if (lineage === null) return null;
  const rotated = (
    db
      .prepare("SELECT old_public_key FROM relay_key_successions WHERE motebit_id = ?")
      .all(motebitId) as Array<{ old_public_key: string }>
  ).some((l) => lineage.has(l.old_public_key));
  if (rotated) return null;
  for (const key of keysHeldBy(db, motebitId)) {
    if ((await proveSovereignFirstKey(motebitId, key)) !== null) return key;
  }
  return null;
}

/**
 * Park a pre-#875 squat of a SOVEREIGN id (#875 review F1) — called by a
 * public door (bootstrap, register-self) that has just proven CURRENT
 * possession of `provenKey` AND that `provenKey` stands for the id
 * (`keyStandsFor`), while the identity has no standing key on file. Every
 * key on file then is a squat (none can be the identity's), so, in one
 * transaction: the keyed device rows that do not stand are removed (each one
 * verified tokens AS the identity), a registry key that does not stand is
 * cleared and the listing delisted (its endpoint is the squatter's), its
 * evidence row dropped, and a holder that does not stand (an E-main or E-op
 * transplant of the squat) is removed. Returns what it parked, for the
 * caller's log and socket reconcile. Writes nothing for a non-sovereign id.
 */
export interface ParkedSquat {
  devices: Array<{ device_id: string; public_key: string }>;
  registryKey: string | null;
  holderKey: string | null;
}

export async function parkSovereignSquat(
  db: DatabaseDriver,
  motebitId: string,
  provenKey: string,
  now: number,
): Promise<ParkedSquat | null> {
  const lineage = await sovereignLineage(db, motebitId, provenKey);
  if (lineage === null || !lineage.has(provenKey)) return null;
  // Compared case-insensitively, as the door's held-key guard compares: a
  // legacy UPPER(K) row of the owner's own key is the owner's, never parked.
  const standing = new Set([...lineage].map((k) => k.toLowerCase()));
  return db.transaction(() => {
    // Re-read inside the transaction: park only while no standing key is on
    // file (a concurrent owner write makes this a no-op).
    for (const k of keysHeldBy(db, motebitId)) {
      if (standing.has(k.toLowerCase())) return null;
    }
    const devices = (
      db
        .prepare(
          "SELECT device_id, public_key FROM devices WHERE motebit_id = ? AND public_key != ''",
        )
        .all(motebitId) as Array<{ device_id: string; public_key: string }>
    ).filter((d) => !standing.has(d.public_key.toLowerCase()));
    for (const d of devices) {
      db.prepare("DELETE FROM devices WHERE device_id = ? AND motebit_id = ?").run(
        d.device_id,
        motebitId,
      );
    }
    const reg = registryKeyOf(db, motebitId);
    const registryKey = reg !== null && !standing.has(reg.toLowerCase()) ? reg : null;
    if (registryKey !== null) {
      db.prepare(
        "UPDATE agent_registry SET public_key = '', delisted_at = COALESCE(delisted_at, ?), endpoint_url = '', capabilities = '[]' WHERE motebit_id = ?",
      ).run(now, motebitId);
      db.prepare("DELETE FROM relay_registry_key_evidence WHERE motebit_id = ?").run(motebitId);
    }
    const holder = holderKeyOf(db, motebitId);
    const holderKey = holder !== null && !standing.has(holder.toLowerCase()) ? holder : null;
    if (holderKey !== null) {
      db.prepare("DELETE FROM identity_keys WHERE motebit_id = ?").run(motebitId);
    }
    if (devices.length === 0 && registryKey === null && holderKey === null) return null;
    return { devices, registryKey, holderKey };
  });
}

/** The evidence that proved a registry key (closed set; migration v58). */
export const REGISTRY_KEY_EVIDENCE = [
  "bearer",
  "holder",
  "key_proof",
  "succession",
  "sovereign",
  "operator",
  "receipt_signature",
] as const;
export type RegistryKeyEvidence = (typeof REGISTRY_KEY_EVIDENCE)[number];

/**
 * Record that `publicKey` was written to the registry on `evidence` a request
 * carried (#875 review round 4). The caller holds the evidence; this proves
 * nothing itself. Upsert: the latest proven registry key per identity.
 */
export function recordRegistryKeyEvidence(
  db: DatabaseDriver,
  input: { motebitId: string; publicKey: string; evidence: RegistryKeyEvidence; now: number },
): void {
  if (!HEX_64_ANY_CASE.test(input.publicKey)) {
    throw new Error(`recordRegistryKeyEvidence: not a 32-byte hex public key (${input.evidence})`);
  }
  db.prepare(
    `INSERT INTO relay_registry_key_evidence (motebit_id, public_key, evidence, recorded_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(motebit_id) DO UPDATE SET
       public_key = excluded.public_key,
       evidence = excluded.evidence,
       recorded_at = excluded.recorded_at`,
  ).run(input.motebitId, input.publicKey, input.evidence, input.now);
}

/**
 * The registry key, when a request PROVED it and the registry still holds
 * exactly that key; else null. A pre-#875 row, or one a later unproven write
 * moved, has no matching evidence.
 */
export function provenRegistryKeyOf(db: DatabaseDriver, motebitId: string): string | null {
  const row = db
    .prepare(
      `SELECT e.public_key AS k FROM relay_registry_key_evidence e
         JOIN agent_registry r ON r.motebit_id = e.motebit_id
        WHERE e.motebit_id = ? AND r.public_key = e.public_key`,
    )
    .get(motebitId) as { k: string } | undefined;
  return keyOrNull(row?.k);
}

/**
 * A discovery listing's rows with `public_key` (and `did`) replaced by the
 * SERVED key (`servedIdentityKey`) — the listing is assembled from registry
 * rows, whose column a relay before #875 wrote without proof. An identity
 * with no served key lists `''` and no `did`.
 */
export async function withServedKeys<
  T extends { motebit_id: string; public_key: string; did?: string },
>(db: DatabaseDriver, agents: T[], toDid: (publicKeyHex: string) => string): Promise<T[]> {
  const out: T[] = [];
  for (const a of agents) {
    const served = (await servedIdentityKey(db, a.motebit_id)) ?? "";
    let did: string | undefined;
    try {
      if (served !== "") did = toDid(served);
    } catch {
      did = undefined;
    }
    out.push({ ...a, public_key: served, did });
  }
  return out;
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
 * — or whose keyed device rows name a DIFFERENT key (HEAL-F) — stays
 * unfilled until E-sov, E-link, E-mig or E-op; `departureFrom`'s device
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
    -- Only where no keyed device row holds a DIFFERENT key (#758 review,
    -- HEAL-F): with rows that disagree the relay cannot tell whose key the
    -- registry names — a paired device may have captured it — and a
    -- transplant would freeze that capture as the identity's authority where
    -- main's receipt heal would take it back. Unfilled ⇒ main's rule exactly.
    AND NOT EXISTS (
      SELECT 1 FROM devices d
       WHERE d.motebit_id = p.motebit_id AND d.public_key != ''
         AND lower(d.public_key) != lower(p.reg)
    )
    AND p.motebit_id NOT IN (SELECT motebit_id FROM identity_keys)
`;
