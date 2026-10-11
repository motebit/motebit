/**
 * ProvenKey lineage model — a `ProvenKey` is minted only from a key whose
 * lineage is ROOTED IN EVIDENCE (docs/design/identity-authority-writers.md
 * §3.2, D1/D2; the Inc 2 cold review's F1 and F2).
 *
 * The law, as a model this file enumerates exhaustively up to depth 3:
 *
 *   a key K mints a ProvenKey  ⇔  K is the identity's chain head, its lineage
 *   is rooted in E-sov (the id is K₀'s sovereign commitment), E-mig (a
 *   verified migration arrival) or E-op (the operator's bare service
 *   identity), and EVERY link from that root to K carries evidence.
 *
 * Roots: E-sov, E-mig, E-op, `backfill:registry` (main's registry key
 * transplanted — not evidence, D2), a paired-device key (a device row only),
 * none (no key on file at all).
 *
 * Links (each applied through the real `/rotate-key` route, so a shape the
 * relay refuses is counted unreachable, never invented):
 *
 *   - `rot` — an ordinary rotation signed by the chain head. It carries the
 *     predecessor's evidence and never creates any: from an evidence-rooted
 *     head it is "a rotation signed by an evidence-rooted predecessor"; from
 *     any other head it is "a self-signed rotation by the holder", which
 *     upgrades nothing (F2).
 *   - `rec_ev` — a guardian recovery whose guardian has a
 *     `relay_guardian_evidence` row set under the THEN-head (seeded directly,
 *     so the cell exists even where no door could have written it: the rule
 *     must not lean on door gating). It carries evidence iff that head did.
 *   - `rec_plant` — a guardian recovery under a guardian set by an UNPROVEN
 *     registration (a planted guardian, no evidence row). Never carries (F1).
 *
 * For each cell: the chain head mints iff the model says so (proveCurrentKey,
 * and the money door with the header: 200 vs 401); every retired key never
 * mints; and — whatever the verdict — the same write WITHOUT a header still
 * succeeds and is shadow-recorded exactly once (Inc 2 refuses nothing new).
 * F1 and F2 are also driven end to end as named cells, exactly as reported.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bytesToHex,
  canonicalJson,
  deriveSovereignMotebitId,
  ed25519Sign,
  encodeAuthorityHeader,
  generateKeypair,
  mintAudienceToken,
  signAuthorityRequest,
  signGuardianRecoverySuccession,
  signKeySuccession,
  type KeyPair,
} from "@motebit/crypto";
import type { TokenAudience } from "@motebit/protocol";
import type { SyncRelay } from "../index.js";
import { AUTHORITY_SHADOW_KIND, proveCurrentKey } from "../identity-authority.js";
import {
  IDENTITY_KEYS_BACKFILL_SQL,
  recordGuardianEvidence,
  recordIdentityKey,
} from "../identity-keys.js";
import { AUTH_HEADER, JSON_AUTH, createTestRelay } from "./test-helpers.js";

const ROOTS = ["e_sov", "e_mig", "e_op", "backfill", "paired", "none"] as const;
const LINKS = ["rot", "rec_ev", "rec_plant"] as const;
type Root = (typeof ROOTS)[number];
type Link = (typeof LINKS)[number];
const EVIDENCE_ROOTS: ReadonlySet<Root> = new Set(["e_sov", "e_mig", "e_op"]);
const MAX_DEPTH = 3;

/** THE MODEL: minted iff the root is evidence and every link carries it. */
function modelMints(root: Root, links: readonly Link[]): boolean {
  return EVIDENCE_ROOTS.has(root) && links.every((l) => l !== "rec_plant");
}

let relay: SyncRelay;
beforeAll(async () => {
  relay = await createTestRelay();
});
afterAll(async () => {
  await relay.close();
});

const db = () => relay.moteDb.db;
const relayId = () => relay.relayIdentity.relayMotebitId;
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);
const ENDPOINT = "http://127.0.0.1:9999/mcp";

/** Each request from its own client address: the per-IP rate limiter is not under test. */
let clientIp = 0;
function req(path: string, init: RequestInit): Response | Promise<Response> {
  const n = ++clientIp;
  const headers = new Headers(init.headers);
  headers.set("x-forwarded-for", `198.51.${(n >> 8) & 255}.${n & 255}`);
  return relay.app.request(path, { ...init, headers });
}
const SWEEP = { sweep_threshold: 3_000_000 };

async function deviceToken(
  mid: string,
  did: string,
  kp: KeyPair,
  aud: TokenAudience,
): Promise<string> {
  return (await mintAudienceToken({ mid, did, aud }, kp.privateKey)).token;
}

function insertDevice(mid: string, did: string, key: string): void {
  db()
    .prepare(
      "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(did, mid, `tok-${crypto.randomUUID()}`, key, Date.now());
}

async function operatorRegister(mid: string, publicKey?: string): Promise<number> {
  const res = await req("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: mid,
      endpoint_url: ENDPOINT,
      capabilities: [],
      ...(publicKey !== undefined ? { public_key: publicKey } : {}),
    }),
  });
  return res.status;
}

async function guardianFields(mid: string, guardian: KeyPair) {
  return {
    guardian_public_key: hex(guardian),
    guardian_attestation: bytesToHex(
      await ed25519Sign(
        new TextEncoder().encode(
          canonicalJson({
            action: "guardian_attestation",
            guardian_public_key: hex(guardian),
            motebit_id: mid,
          }),
        ),
        guardian.privateKey,
      ),
    ),
  };
}

/** An UNPROVEN registration (no X-Motebit-Authority) that sets `guardian`, by device `did`. */
async function setGuardianUnproven(
  mid: string,
  did: string,
  kp: KeyPair,
  guardian: KeyPair,
): Promise<number> {
  const res = await req("/api/v1/agents/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await deviceToken(mid, did, kp, "admin:query")}`,
    },
    body: JSON.stringify({
      endpoint_url: ENDPOINT,
      capabilities: [],
      ...(await guardianFields(mid, guardian)),
    }),
  });
  return res.status;
}

async function rotateKey(
  mid: string,
  did: string,
  kp: KeyPair,
  record: unknown,
): Promise<{ status: number; text: string }> {
  const res = await req(`/api/v1/agents/${mid}/rotate-key`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await deviceToken(mid, did, kp, "rotate-key")}`,
    },
    body: JSON.stringify(record),
  });
  return { status: res.status, text: await res.text() };
}

async function authorityHeader(mid: string, kp: KeyPair, value: unknown): Promise<string> {
  return encodeAuthorityHeader(
    await signAuthorityRequest({
      motebitId: mid,
      field: "sweep_config",
      value,
      relayId: relayId(),
      privateKey: kp.privateKey,
    }),
  );
}

const lastEventId = (): number =>
  (db().prepare("SELECT COALESCE(MAX(id), 0) AS n FROM relay_auth_events").get() as { n: number })
    .n;
const shadowEventsSince = (id: number, mid: string): number =>
  (
    db()
      .prepare(
        "SELECT COUNT(*) AS n FROM relay_auth_events WHERE id > ? AND kind = ? AND motebit_id = ?",
      )
      .get(id, AUTHORITY_SHADOW_KIND, mid) as { n: number }
  ).n;

/** PATCH sweep-config; `bearer` null = the operator's master token. */
async function sweep(
  mid: string,
  bearer: { did: string; kp: KeyPair } | null,
  authority: string | null,
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(bearer === null
      ? AUTH_HEADER
      : {
          Authorization: `Bearer ${await deviceToken(mid, bearer.did, bearer.kp, "admin:query")}`,
        }),
  };
  if (authority !== null) headers["X-Motebit-Authority"] = authority;
  const res = await req(`/api/v1/agents/${mid}/sweep-config`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(SWEEP),
  });
  return { status: res.status, text: await res.text() };
}

interface Identity {
  mid: string;
  /** The device whose row follows the chain head (null for `none`: no device row). */
  device: string | null;
}

/** Stand up an identity whose key history starts at `k0` with the given root. */
async function seedRoot(root: Root, k0: KeyPair): Promise<Identity> {
  const now = Date.now();
  switch (root) {
    case "e_sov": {
      const mid = await deriveSovereignMotebitId(hex(k0));
      const boot = await req("/api/v1/agents/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motebit_id: mid, device_id: `d0-${mid}`, public_key: hex(k0) }),
      });
      expect(boot.status).toBe(201);
      expect(await operatorRegister(mid)).toBe(200);
      return { mid, device: `d0-${mid}` };
    }
    case "e_mig": {
      // What accept-migration leaves (migration.ts: the holder by E-mig and
      // the acceptance row), seeded directly: the arrival's own verification
      // is migration.ts's harness, not this one's.
      const mid = crypto.randomUUID();
      recordIdentityKey(db(), { motebitId: mid, publicKey: hex(k0), source: "migration", now });
      db()
        .prepare(
          "INSERT INTO relay_accepted_migrations (token_id, motebit_id, source_relay_id, accepted_at) VALUES (?, ?, ?, ?)",
        )
        .run(crypto.randomUUID(), mid, "source-relay", now);
      insertDevice(mid, `d0-${mid}`, hex(k0));
      expect(await operatorRegister(mid)).toBe(200);
      return { mid, device: `d0-${mid}` };
    }
    case "e_op": {
      // The operator registers a bare keyed service identity (E-op).
      const mid = crypto.randomUUID();
      expect(await operatorRegister(mid, hex(k0))).toBe(200);
      const held = db()
        .prepare("SELECT source FROM identity_keys WHERE motebit_id = ?")
        .get(mid) as { source: string } | undefined;
      expect(held?.source).toBe("operator");
      insertDevice(mid, `d0-${mid}`, hex(k0));
      return { mid, device: `d0-${mid}` };
    }
    case "backfill": {
      // main's registry key, transplanted by v42 (E-main) — not evidence (D2).
      const mid = crypto.randomUUID();
      insertDevice(mid, `d0-${mid}`, hex(k0));
      expect(await operatorRegister(mid)).toBe(200);
      db().prepare(IDENTITY_KEYS_BACKFILL_SQL).run(now, now);
      const held = db()
        .prepare("SELECT source FROM identity_keys WHERE motebit_id = ?")
        .get(mid) as { source: string } | undefined;
      expect(held?.source).toBe("backfill:registry");
      return { mid, device: `d0-${mid}` };
    }
    case "paired": {
      // A device row only: no holder, an empty registry key.
      const mid = crypto.randomUUID();
      expect(await operatorRegister(mid)).toBe(200);
      insertDevice(mid, `d0-${mid}`, hex(k0));
      return { mid, device: `d0-${mid}` };
    }
    case "none": {
      const mid = crypto.randomUUID();
      expect(await operatorRegister(mid)).toBe(200);
      return { mid, device: null };
    }
  }
}

/**
 * Apply one link from the head `from` to a fresh key through the real doors.
 * Returns the new head, or the refusal when the relay does not admit it.
 */
async function applyLink(
  id: Identity,
  link: Link,
  from: KeyPair,
): Promise<{ ok: true; next: KeyPair } | { ok: false; status: number; text: string }> {
  const next = await generateKeypair();
  // A device row to carry the request: the identity's own (it follows the
  // head) — or, for `none`, a stranger's row planted beside it (a key that is
  // never on the chain), so the link is attempted and the relay decides.
  let did = id.device;
  let carrier = from;
  if (did === null) {
    did = `carrier-${id.mid}`;
    carrier = await generateKeypair();
    db().prepare("DELETE FROM devices WHERE device_id = ?").run(did);
    insertDevice(id.mid, did, hex(carrier));
  }
  if (link === "rot") {
    const rec = await signKeySuccession(
      from.privateKey,
      next.privateKey,
      next.publicKey,
      from.publicKey,
    );
    const r = await rotateKey(id.mid, did, carrier, rec);
    return r.status === 200 ? { ok: true, next } : { ok: false, ...r };
  }
  const guardian = await generateKeypair();
  const g = await setGuardianUnproven(id.mid, did, carrier, guardian);
  if (g !== 200) return { ok: false, status: g, text: "guardian registration refused" };
  if (link === "rec_ev") {
    recordGuardianEvidence(db(), {
      motebitId: id.mid,
      guardianPublicKey: hex(guardian),
      setUnderKey: hex(from),
      evidence: "key_proof",
      now: Date.now(),
    });
  }
  const rec = await signGuardianRecoverySuccession(
    guardian.privateKey,
    next.privateKey,
    from.publicKey,
    next.publicKey,
  );
  const r = await rotateKey(id.mid, did, carrier, rec);
  return r.status === 200 ? { ok: true, next } : { ok: false, ...r };
}

function sequences(depth: number): Link[][] {
  if (depth === 0) return [[]];
  return sequences(depth - 1).flatMap((s) => LINKS.map((l) => [...s, l]));
}

const cells: Array<{ root: Root; links: Link[] }> = [];
for (const root of ROOTS)
  for (let d = 0; d <= MAX_DEPTH; d++)
    for (const links of sequences(d)) cells.push({ root, links });

const tally = { explored: 0, reachable: 0, unreachable: 0, minted: 0, notMinted: 0 };

describe("ProvenKey is minted iff the chain head's lineage is rooted in evidence and every link carries it", () => {
  afterAll(() => {
    // The aperture of this harness (gate-repair-instructions: a passing
    // scanning test states what it examined).
    console.log(
      `[proven-key-lineage-model] explored ${tally.explored} cells (${ROOTS.length} roots × link sequences ≤ ${MAX_DEPTH} over ${LINKS.length} link kinds): ` +
        `${tally.reachable} reachable (${tally.minted} mint, ${tally.notMinted} do not), ${tally.unreachable} refused by the relay`,
    );
  });

  for (const cell of cells) {
    const name = `${cell.root}${cell.links.length ? " → " + cell.links.join(" → ") : ""}`;
    it(name, async () => {
      tally.explored++;
      const k0 = await generateKeypair();
      const id = await seedRoot(cell.root, k0);
      const keys: KeyPair[] = [k0];
      for (const link of cell.links) {
        const step = await applyLink(id, link, keys[keys.length - 1]!);
        if (!step.ok) {
          // Only a root with no key on file is refused a link here (it has
          // nothing to depart from) — anything else would be a harness bug.
          expect(cell.root).toBe("none");
          expect(step.status).toBeGreaterThanOrEqual(400);
          tally.unreachable++;
          return;
        }
        keys.push(step.next);
      }
      tally.reachable++;
      const head = keys[keys.length - 1]!;
      const expected = modelMints(cell.root, cell.links);
      if (expected) tally.minted++;
      else tally.notMinted++;

      // 1. The verifier: the head mints iff the model says so.
      const proven = await proveCurrentKey(db(), {
        header: await authorityHeader(id.mid, head, SWEEP),
        field: "sweep_config",
        motebitId: id.mid,
        value: SWEEP,
        relayId: relayId(),
      });
      expect(
        { cell: name, minted: proven.ok },
        `reason: ${proven.ok ? "minted" : proven.reason}`,
      ).toEqual({ cell: name, minted: expected });

      // 2. A retired key never mints.
      for (const retired of keys.slice(0, -1)) {
        const r = await proveCurrentKey(db(), {
          header: await authorityHeader(id.mid, retired, SWEEP),
          field: "sweep_config",
          motebitId: id.mid,
          value: SWEEP,
          relayId: relayId(),
        });
        expect(r.ok, `${name}: a retired key minted`).toBe(false);
      }

      // 3. The door WITH the head's header: 200 and no shadow event iff minted, else 401.
      const bearer = id.device === null ? null : { did: id.device, kp: head };
      let before = lastEventId();
      const withHeader = await sweep(id.mid, bearer, await authorityHeader(id.mid, head, SWEEP));
      if (expected) {
        expect(withHeader.status, withHeader.text).toBe(200);
        expect(shadowEventsSince(before, id.mid)).toBe(0);
      } else {
        expect(withHeader.status, withHeader.text).toBe(401);
        expect(withHeader.text).toMatch(/X-Motebit-Authority refused/);
      }

      // 4. The same write WITHOUT a header: still succeeds, recorded once.
      before = lastEventId();
      const bare = await sweep(id.mid, bearer, null);
      expect(bare.status, bare.text).toBe(200);
      expect(shadowEventsSince(before, id.mid)).toBe(1);
    });
  }

  it("covers every cell of the model (roots × all link sequences ≤ depth 3)", () => {
    let n = 0;
    for (let d = 0; d <= MAX_DEPTH; d++) n += LINKS.length ** d;
    expect(cells.length).toBe(ROOTS.length * n);
  });
});

// ── The cold review's two findings, end to end, exactly as reported ──────

describe("named cells — the Inc 2 cold review's findings", () => {
  it("F1: a guardian planted by a paired device recovers a sovereign id to K_att — K_att never mints", async () => {
    const k0 = await generateKeypair();
    const kp = await generateKeypair();
    const att = await generateKeypair();
    const g = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k0));
    const boot = await req("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ motebit_id: mid, device_id: `owner-${mid}`, public_key: hex(k0) }),
    });
    expect(boot.status).toBe(201);
    // The owner registers V.
    const reg = await req("/api/v1/agents/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await deviceToken(mid, `owner-${mid}`, k0, "admin:query")}`,
      },
      body: JSON.stringify({ endpoint_url: ENDPOINT, capabilities: [] }),
    });
    expect(reg.status).toBe(200);
    // A paired-device row P registers with guardian G (P controls G; self-made attestation).
    insertDevice(mid, `paired-${mid}`, hex(kp));
    expect(await setGuardianUnproven(mid, `paired-${mid}`, kp, g)).toBe(200);
    // G recovers V from K0 to K_att, carried by P's token.
    const recovery = await signGuardianRecoverySuccession(
      g.privateKey,
      att.privateKey,
      k0.publicKey,
      att.publicKey,
    );
    const rot = await rotateKey(mid, `paired-${mid}`, kp, recovery);
    expect(rot.status, rot.text).toBe(200);
    // K_att's authority header: never a ProvenKey.
    let before = lastEventId();
    const withHeader = await sweep(
      mid,
      { did: `paired-${mid}`, kp },
      await authorityHeader(mid, att, SWEEP),
    );
    expect(withHeader.status, withHeader.text).toBe(401);
    expect(withHeader.text).toMatch(/no_current_key/);
    // The write itself still lands header-less (Inc 2), and is recorded.
    before = lastEventId();
    const bare = await sweep(mid, { did: `paired-${mid}`, kp }, null);
    expect(bare.status).toBe(200);
    expect(shadowEventsSince(before, mid)).toBe(1);
  });

  it("F2: a backfill:registry holder that rotates itself never upgrades to evidence", async () => {
    const k = await generateKeypair();
    const k2 = await generateKeypair();
    const id = await seedRoot("backfill", k);
    let r = await sweep(
      id.mid,
      { did: id.device!, kp: k },
      await authorityHeader(id.mid, k, SWEEP),
    );
    expect(r.status, r.text).toBe(401);
    expect(r.text).toMatch(/no_current_key/);
    const rec = await signKeySuccession(k.privateKey, k2.privateKey, k2.publicKey, k.publicKey);
    const rot = await rotateKey(id.mid, id.device!, k, rec);
    expect(rot.status, rot.text).toBe(200);
    r = await sweep(id.mid, { did: id.device!, kp: k2 }, await authorityHeader(id.mid, k2, SWEEP));
    expect(r.status, r.text).toBe(401);
    expect(r.text).toMatch(/no_current_key/);
    const before = lastEventId();
    const bare = await sweep(id.mid, { did: id.device!, kp: k2 }, null);
    expect(bare.status).toBe(200);
    expect(shadowEventsSince(before, id.mid)).toBe(1);
  });
});
