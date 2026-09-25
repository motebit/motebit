/**
 * Key rotation, end to end: the REAL `performRotation` against an in-process
 * relay with the relay half applied — one case per row of the state table in
 * `docs/proposals/key-rotation-client-v1.md` §7. The relay is reached through
 * its Hono app (fetch-compatible), so nothing between the client and the
 * route is stubbed; a link severed anywhere in between goes red here
 * (`docs/doctrine/composition-preserves-enforcement.md`).
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import { generate, verify } from "@motebit/identity-file";
import { generateKeypair, bytesToHex, signKeySuccession } from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";

import type { FullConfig } from "../config.js";
import { encryptPrivateKey, decryptPrivateKey } from "../identity.js";
import {
  clearPendingRotation,
  loadAnyPendingRotation,
  loadPendingRotation,
  pendingRotationPath,
  savePendingRotation,
} from "../pending-rotation.js";
import { registerWithRelay } from "../relay-registration.js";
import {
  performRotation,
  RotationUnlockError,
  type RotationDeps,
  type RotationOutcome,
} from "../rotation.js";

const PASS = "correct horse";
const SYNC_URL = "http://relay.test";
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

let relay: SyncRelay;
let dir: string;
let config: FullConfig;
let posts: number;

/** The relay reached through its app — fetch-compatible, no server, nothing stubbed. */
const viaRelay: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if ((init?.method ?? "GET").toUpperCase() === "POST" && url.endsWith("/rotate-key")) posts++;
  return relay.app.request(url, init);
};

beforeEach(async () => {
  relay = await createSyncRelay({
    apiToken: "test-token",
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
    drainGraceMs: 10,
    allowPrivateEndpoints: true,
  });
  dir = mkdtempSync(join(tmpdir(), "motebit-rotation-activation-"));
  posts = 0;
});
afterEach(async () => {
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  mid: string;
  deviceId: string;
  a: KeyPair;
  identityPath: string;
}

/** A local identity: motebit.md + config with the key encrypted under PASS. */
async function localIdentity(): Promise<Fixture> {
  const mid = crypto.randomUUID();
  const a = await generateKeypair();
  const identityPath = join(dir, "motebit.md");
  writeFileSync(
    identityPath,
    await generate({ motebitId: mid, ownerId: "owner", publicKeyHex: hex(a) }, a.privateKey),
  );
  const deviceId = `${mid}-laptop`;
  config = {
    motebit_id: mid,
    device_id: deviceId,
    device_public_key: hex(a),
    cli_encrypted_key: (await encryptPrivateKey(bytesToHex(a.privateKey), PASS))!,
  } as FullConfig;
  return { mid, deviceId, a, identityPath };
}

/** The same identity known to the relay, the way `motebit up` makes it known. */
async function registered(): Promise<Fixture> {
  const f = await localIdentity();
  const handle = await registerWithRelay({
    syncUrl: SYNC_URL,
    identity: {
      motebitId: f.mid,
      deviceId: f.deviceId,
      publicKeyHex: hex(f.a),
      privateKey: f.a.privateKey,
    },
    registration: { endpoint_url: "http://127.0.0.1:9999/mcp", capabilities: [] },
    toolNames: [],
    description: "rotation activation",
    log: () => {},
    heartbeatMs: 24 * 60 * 60 * 1000,
    fetchImpl: viaRelay,
  });
  handle.stop();
  expect(handle.registered).toBe(true);
  return f;
}

function deps(f: Fixture, over: Partial<RotationDeps> = {}): RotationDeps {
  return {
    identityPath: f.identityPath,
    loadConfig: () => ({ ...config }),
    saveConfig: (c) => {
      config = c;
    },
    pending: {
      load: (mid, key) => loadPendingRotation(mid, key, dir),
      loadAny: () => loadAnyPendingRotation(dir),
      save: (p) => savePendingRotation(p, dir),
      clear: () => clearPendingRotation(dir),
      path: pendingRotationPath(dir),
    },
    passphrase: PASS,
    syncUrl: SYNC_URL,
    fetchImpl: viaRelay,
    ...over,
  };
}

const relayKey = (mid: string): string | undefined =>
  (
    relay.moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(mid) as { public_key: string } | undefined
  )?.public_key;
const deviceKey = (did: string): string | undefined =>
  (
    relay.moteDb.db.prepare("SELECT public_key FROM devices WHERE device_id = ?").get(did) as
      { public_key: string } | undefined
  )?.public_key;
const chainLength = (mid: string): number =>
  (
    relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_key_successions WHERE motebit_id = ?")
      .get(mid) as { n: number }
  ).n;

/** What this machine holds now: the key the re-signed file names, and proof the config opens to it. */
async function localKey(
  f: Fixture,
  passphrase: string = PASS,
): Promise<{ publicKeyHex: string; privateKeyHex: string }> {
  const v = await verify(readFileSync(f.identityPath, "utf-8"), { expectedType: "identity" });
  expect(v.valid).toBe(true);
  if (v.type !== "identity" || !v.identity) throw new Error("not an identity file");
  return {
    publicKeyHex: v.identity.identity.public_key,
    privateKeyHex: await decryptPrivateKey(config.cli_encrypted_key!, passphrase),
  };
}

function rotated(o: RotationOutcome): Extract<RotationOutcome, { kind: "rotated" }> {
  expect(o.kind).toBe("rotated");
  return o as Extract<RotationOutcome, { kind: "rotated" }>;
}

describe("S0 → S2: a registered identity rotates, relay first, local second", () => {
  it("records the link, moves every relay row, and only then moves local state", async () => {
    const f = await registered();
    const o = rotated(await performRotation(deps(f)));
    expect(o.relay).toBe("recorded");
    expect(o.rotations).toBe(1);
    // Relay: chain grew, registry and device row on B.
    expect(chainLength(f.mid)).toBe(1);
    expect(relayKey(f.mid)).toBe(o.newPublicKeyHex);
    expect(deviceKey(f.deviceId)).toBe(o.newPublicKeyHex);
    // Local: identity file re-signed under B, config holds B, write-ahead gone.
    const local = await localKey(f);
    expect(local.publicKeyHex).toBe(o.newPublicKeyHex);
    expect(config.device_public_key).toBe(o.newPublicKeyHex);
    expect(loadPendingRotation(f.mid, hex(f.a), dir)).toBeNull();
    expect(posts).toBe(1);
  });

  it("and can rotate again from the real head", async () => {
    const f = await registered();
    const first = rotated(await performRotation(deps(f)));
    const second = rotated(await performRotation(deps(f)));
    expect(second.rotations).toBe(2);
    expect(second.relayKeyBefore).toBe(first.newPublicKeyHex);
    expect(chainLength(f.mid)).toBe(2);
    expect(relayKey(f.mid)).toBe(second.newPublicKeyHex);
  });
});

describe("S1: the response was lost after the relay committed", () => {
  it("the next run READS that the relay holds B, commits from the write-ahead, and sends nothing", async () => {
    const f = await registered();
    // The relay processes the POST; the client never sees the answer.
    const lossy: typeof fetch = async (input, init) => {
      const res = await viaRelay(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/rotate-key")) throw new Error("socket hang up");
      return res;
    };
    const first = await performRotation(deps(f, { fetchImpl: lossy }));
    expect(first.kind).toBe("held");
    // Relay applied it; local did not move; the write-ahead holds B.
    expect(chainLength(f.mid)).toBe(1);
    const read = loadPendingRotation(f.mid, hex(f.a), dir);
    if (read == null || read === "unreadable") throw new Error("expected a readable write-ahead");
    const held = read;
    expect(relayKey(f.mid)).toBe(held.new_public_key);
    expect((await localKey(f)).publicKeyHex).toBe(hex(f.a));

    posts = 0;
    const second = rotated(await performRotation(deps(f)));
    expect(second.relay).toBe("already-held");
    expect(second.newPublicKeyHex).toBe(held.new_public_key);
    expect(posts).toBe(0); // read, never re-signed, never replayed
    expect(chainLength(f.mid)).toBe(1);
    expect((await localKey(f)).publicKeyHex).toBe(held.new_public_key);
    expect(loadPendingRotation(f.mid, hex(f.a), dir)).toBeNull();
  });

  it("if the write-ahead will not open under this passphrase, it stops and names guardian recovery — never mints a third key", async () => {
    const f = await registered();
    const lossy: typeof fetch = async (input, init) => {
      const res = await viaRelay(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/rotate-key")) throw new Error("socket hang up");
      return res;
    };
    expect((await performRotation(deps(f, { fetchImpl: lossy }))).kind).toBe("held");
    // The passphrase changed between attempts; the identity key was re-encrypted, the write-ahead was not.
    config.cli_encrypted_key = (await encryptPrivateKey(
      bytesToHex(f.a.privateKey),
      "new passphrase",
    ))!;
    const o = await performRotation(deps(f, { passphrase: "new passphrase" }));
    expect(o).toMatchObject({ kind: "stopped", state: "held-unopenable" });
    expect((o as { message: string }).message).toContain("guardian");
    expect(chainLength(f.mid)).toBe(1);
    expect((await localKey(f, "new passphrase")).publicKeyHex).toBe(hex(f.a));
  });

  it("a write-ahead that cannot be READ stops the rotation and is left exactly where it is", async () => {
    // Damage is not absence: an unparseable write-ahead may be the only copy
    // of a key the relay already accepted. Reading it as "nothing held" would
    // let the kit mint a fresh rotation and clear it.
    const f = await registered();
    const torn = '{ "motebit_id": "' + f.mid + '", "encrypted_new_key": { "ciph';
    writeFileSync(pendingRotationPath(dir), torn);
    const o = await performRotation(deps(f));
    expect(o).toMatchObject({ kind: "stopped", state: "held-unopenable" });
    expect(readFileSync(pendingRotationPath(dir), "utf-8")).toBe(torn);
    expect(chainLength(f.mid)).toBe(0);
    expect((await localKey(f)).publicKeyHex).toBe(hex(f.a));
  });
});

describe("S0 with a stale write-ahead: the relay never applied it", () => {
  it("mints a fresh record; the held key is discarded unused and never appears anywhere", async () => {
    const f = await registered();
    const ghost = await generateKeypair();
    savePendingRotation(
      {
        motebit_id: f.mid,
        old_public_key: hex(f.a),
        new_public_key: hex(ghost),
        record: await signKeySuccession(
          f.a.privateKey,
          ghost.privateKey,
          ghost.publicKey,
          f.a.publicKey,
        ),
        encrypted_new_key: (await encryptPrivateKey(bytesToHex(ghost.privateKey), PASS))!,
        written_at: Date.now() - 16 * 60_000,
      },
      dir,
    );
    const o = rotated(await performRotation(deps(f)));
    expect(o.relay).toBe("recorded");
    expect(o.newPublicKeyHex).not.toBe(hex(ghost));
    // Its age is said, not silently swallowed.
    const note = o.notes.find((n) => n.kind === "write-ahead-discarded");
    expect(note).toBeDefined();
    expect((note as { ageMs: number }).ageMs).toBeGreaterThanOrEqual(16 * 60_000);
    expect(relayKey(f.mid)).toBe(o.newPublicKeyHex);
    const chain = relay.moteDb.db
      .prepare("SELECT new_public_key FROM relay_key_successions WHERE motebit_id = ?")
      .all(f.mid) as Array<{ new_public_key: string }>;
    expect(chain.map((r) => r.new_public_key)).not.toContain(hex(ghost));
    expect(loadPendingRotation(f.mid, hex(f.a), dir)).toBeNull();
  });
});

describe("refusal: the relay answered and said no", () => {
  it("leaves the old key working, nothing local changed, and no write-ahead behind", async () => {
    const f = await registered();
    // A relay DECISION, distinct from an unreachable relay: the route answers 4xx.
    const refusing: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/rotate-key")) return new Response("not from current key", { status: 400 });
      return viaRelay(input, init);
    };
    const o = await performRotation(deps(f, { fetchImpl: refusing }));
    expect(o).toMatchObject({ kind: "stopped", state: "refused" });
    expect(chainLength(f.mid)).toBe(0);
    expect((await localKey(f)).publicKeyHex).toBe(hex(f.a));
    expect(loadPendingRotation(f.mid, hex(f.a), dir)).toBeNull();
  });
});

describe("S4: the relay holds nothing for this identity", () => {
  it("rotates locally and says the relay had nothing to record — read, not declared", async () => {
    const f = await localIdentity();
    const o = rotated(await performRotation(deps(f)));
    expect(o.relay).toBe("none");
    expect(o.relayKeyBefore).toBeNull();
    expect((await localKey(f)).publicKeyHex).toBe(o.newPublicKeyHex);
    expect(chainLength(f.mid)).toBe(0);
    expect(posts).toBe(0);
  });
});

describe("S5: the relay holds some other key", () => {
  it("stops, names the key and guardian recovery, and changes nothing", async () => {
    const f = await registered();
    // Someone with A rotated first.
    const c = await generateKeypair();
    const record = await signKeySuccession(
      f.a.privateKey,
      c.privateKey,
      c.publicKey,
      f.a.publicKey,
    );
    relay.moteDb.db
      .prepare("UPDATE agent_registry SET public_key = ? WHERE motebit_id = ?")
      .run(hex(c), f.mid);
    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_key_successions (motebit_id, old_public_key, new_public_key, timestamp, new_key_signature) VALUES (?, ?, ?, ?, ?)",
      )
      .run(f.mid, hex(f.a), hex(c), record.timestamp, record.new_key_signature);
    const o = await performRotation(deps(f));
    expect(o).toMatchObject({ kind: "stopped", state: "diverged", relayKey: hex(c) });
    expect((o as { message: string }).message).toContain("guardian");
    expect((await localKey(f)).publicKeyHex).toBe(hex(f.a));
    expect(posts).toBe(0);
    expect(loadPendingRotation(f.mid, hex(f.a), dir)).toBeNull();
  });
});

describe("S6: the relay is unreachable", () => {
  it("stops with the old key intact and writes nothing — not even a write-ahead", async () => {
    const f = await registered();
    const down: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const o = await performRotation(deps(f, { fetchImpl: down }));
    expect(o).toMatchObject({ kind: "stopped", state: "unreachable" });
    expect((await localKey(f)).publicKeyHex).toBe(hex(f.a));
    expect(loadPendingRotation(f.mid, hex(f.a), dir)).toBeNull();
    expect(chainLength(f.mid)).toBe(0);
  });
});

describe("a daemon that shut down before ever rotating", () => {
  it("still rotates: deregister dropped the registry row, the key lives only on a device row, and the relay says so", async () => {
    // The state a client that re-derived "held" from chain + registry read
    // as UNREGISTERED and rotated locally into the split — while the relay
    // would have accepted the rotation all along. Now the relay is asked.
    const f = await registered();
    relay.moteDb.db.prepare("DELETE FROM agent_registry WHERE motebit_id = ?").run(f.mid);
    const o = rotated(await performRotation(deps(f)));
    expect(o.relay).toBe("recorded");
    expect(chainLength(f.mid)).toBe(1);
    expect(deviceKey(f.deviceId)).toBe(o.newPublicKeyHex);
    expect((await localKey(f)).publicKeyHex).toBe(o.newPublicKeyHex);
  });
});

describe("a commit interrupted between its two local writes", () => {
  async function interrupted(f: Fixture): Promise<{
    before: string;
    configA: FullConfig;
    o: Extract<RotationOutcome, { kind: "rotated" }>;
  }> {
    const before = readFileSync(f.identityPath, "utf-8");
    const configA = { ...config };
    const o = rotated(await performRotation(deps(f)));
    return { before, configA, o };
  }

  it("config on B, file still on A: the next run re-signs the file from the write-ahead and finishes", async () => {
    const f = await registered();
    const { before, o } = await interrupted(f);
    const held = loadAnyPendingRotation(dir); // gone after a clean commit
    expect(held).toBeNull();
    // Reconstruct: file write did not land, write-ahead still there.
    writeFileSync(f.identityPath, before);
    savePendingRotation(
      {
        motebit_id: f.mid,
        old_public_key: hex(f.a),
        new_public_key: o.newPublicKeyHex,
        // The record that introduced B — read back off the relay's chain.
        record: (() => {
          const row = relay.moteDb.db
            .prepare(
              "SELECT old_public_key, new_public_key, timestamp, old_key_signature, new_key_signature FROM relay_key_successions WHERE motebit_id = ?",
            )
            .get(f.mid) as {
            old_public_key: string;
            new_public_key: string;
            timestamp: number;
            old_key_signature: string;
            new_key_signature: string;
          };
          return { ...row, suite: "motebit-jcs-ed25519-hex-v1" as const };
        })(),
        encrypted_new_key: config.cli_encrypted_key!,
        written_at: Date.now(),
      },
      dir,
    );
    const again = rotated(await performRotation(deps(f)));
    expect(again.notes).toContainEqual({
      kind: "interrupted-commit-finished",
      newPublicKeyHex: o.newPublicKeyHex,
    });
    expect((await localKey(f)).publicKeyHex).toBe(o.newPublicKeyHex);
    expect(chainLength(f.mid)).toBe(1); // nothing was sent
    expect(loadAnyPendingRotation(dir)).toBeNull();
  });

  it("file on B, config still on A: the next run re-encrypts B into the config from the write-ahead and finishes", async () => {
    const f = await registered();
    const { configA, o } = await interrupted(f);
    const configB = { ...config };
    // Reconstruct: config write did not land (file is on B), write-ahead present with enc(B).
    config = configA;
    savePendingRotation(
      {
        motebit_id: f.mid,
        old_public_key: hex(f.a),
        new_public_key: o.newPublicKeyHex,
        record: {
          old_public_key: hex(f.a),
          new_public_key: o.newPublicKeyHex,
          timestamp: 1,
          suite: "motebit-jcs-ed25519-hex-v1",
          new_key_signature: "00",
        },
        encrypted_new_key: configB.cli_encrypted_key!,
        written_at: Date.now(),
      },
      dir,
    );
    const again = rotated(await performRotation(deps(f)));
    expect(again.notes).toContainEqual({
      kind: "interrupted-commit-finished",
      newPublicKeyHex: o.newPublicKeyHex,
    });
    expect((await localKey(f)).publicKeyHex).toBe(o.newPublicKeyHex);
    expect(config.device_public_key).toBe(o.newPublicKeyHex);
    expect(chainLength(f.mid)).toBe(1);
    expect(loadAnyPendingRotation(dir)).toBeNull();
  });

  it("file and config disagree with no write-ahead to bridge them: refuse to guess", async () => {
    const f = await registered();
    const { before } = await interrupted(f);
    writeFileSync(f.identityPath, before);
    await expect(performRotation(deps(f))).rejects.toThrow(/no write-ahead bridges them/);
  });
});

describe("a write-ahead that is not this machine's", () => {
  it("is said and cleared, never finished, never left to block a passphrase change", async () => {
    const f = await registered();
    const other = await generateKeypair();
    savePendingRotation(
      {
        motebit_id: "someone-else",
        old_public_key: hex(other),
        new_public_key: hex(other),
        record: {
          old_public_key: hex(other),
          new_public_key: hex(other),
          timestamp: 1,
          suite: "motebit-jcs-ed25519-hex-v1",
          new_key_signature: "00",
        },
        encrypted_new_key: config.cli_encrypted_key!,
        written_at: 1,
      },
      dir,
    );
    const o = rotated(await performRotation(deps(f)));
    expect(o.notes).toContainEqual({
      kind: "stale-write-ahead-cleared",
      motebitId: "someone-else",
      oldPublicKey: hex(other),
    });
    expect(loadAnyPendingRotation(dir)).toBeNull();
  });
});

describe("the passphrase", () => {
  it("failing to open the key is a typed error, not a message to pattern-match", async () => {
    const f = await registered();
    await expect(performRotation(deps(f, { passphrase: "wrong" }))).rejects.toBeInstanceOf(
      RotationUnlockError,
    );
    expect((await localKey(f)).publicKeyHex).toBe(hex(f.a));
    expect(chainLength(f.mid)).toBe(0);
  });
});

describe("the bearer the relay sees", () => {
  it("is signed by the RETIRING key under the rotate-key audience — the relay half's own tests refuse anything else", async () => {
    // Composition: if the client signed with B, or under another audience,
    // the relay half's middleware would 401 and this would not be `rotated`.
    const f = await registered();
    const o = rotated(await performRotation(deps(f)));
    expect(o.relay).toBe("recorded");
  });
});
