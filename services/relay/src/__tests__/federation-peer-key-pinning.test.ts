/**
 * relay-federation@1.5 §3.1 — a known peer's key is never replaced by a
 * propose (identity-authority invariant I1 applied to peers; see
 * docs/design/identity-authority-writers.md, Inc 1 note on peer key pinning).
 *
 * Before this, `POST /federation/v1/peer/propose` for a relay_id whose row was
 * `suspended` or `removed` overwrote that row's `public_key`, and the handshake
 * then confirmed under the NEW key: anyone could take over a known peer
 * identity. 1.5 moves un-upgraded peers to `suspended` (D4), which widened
 * that window.
 *
 * What must hold, for each prior state of the row (pending, active,
 * suspended, removed):
 *   - a propose naming a DIFFERENT key is refused, the row is byte-identical
 *     before and after, and the stored key still verifies the real peer;
 *   - a propose naming the SAME key is refused 409 "already exists" when the
 *     row is active, and otherwise opens a re-handshake that writes nothing
 *     to the row until its confirm verifies under the stored key (the
 *     exhaustive form is federation-peer-row-authority.test.ts).
 * And end to end: an attacker cannot take over a suspended peer's relay_id,
 * neither directly nor by first spending a same-key propose and a failed
 * confirm to erase the row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToHex, generateKeypair, hexToBytes, sign, verify } from "@motebit/encryption";

import type { SyncRelay } from "../index.js";
import { initRelayIdentity, type RelayIdentity } from "../federation.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";
import { operatorConfirm, signedConfirm } from "./federation-messages.js";

const URLS = {
  a: "http://relay-a.pin.test:3000",
  b: "http://relay-b.pin.test:3001",
} as const;
type Name = keyof typeof URLS;
const ATTACKER_URL = "http://attacker.pin.test:3666";

const rand = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

let relays: Record<Name, SyncRelay>;
let ids: Record<Name, RelayIdentity>;
let attacker: { publicKey: Uint8Array; privateKey: Uint8Array; publicKeyHex: string };

function routeFetch(): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    for (const n of Object.keys(URLS) as Name[]) {
      if (url.startsWith(URLS[n])) {
        return relays[n].app.request(url.slice(URLS[n].length), {
          method: init?.method ?? "GET",
          headers: init?.headers as Record<string, string>,
          body: init?.body as string,
        });
      }
    }
    throw new Error(`unrouted fetch: ${url}`);
  });
}

let ipSeq = 0;
async function post(n: Name, path: string, body: unknown): Promise<Response> {
  ipSeq++;
  return relays[n].app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": `203.0.${ipSeq >> 8}.${ipSeq & 255}`,
    },
    body: JSON.stringify(body),
  });
}

async function propose(at: Name, of: Name, publicKeyHex: string, endpoint: string) {
  return post(at, "/federation/v1/peer/propose", {
    relay_id: ids[of].relayMotebitId,
    public_key: publicKeyHex,
    endpoint_url: endpoint,
    nonce: rand(),
  });
}

/** The real 1.5 handshake, both directions. */
async function peer(x: Name, y: Name): Promise<void> {
  const nonceAtY = (
    (await (await propose(y, x, ids[x].publicKeyHex, URLS[x])).json()) as {
      nonce: string;
    }
  ).nonce;
  const nonceAtX = (
    (await (await propose(x, y, ids[y].publicKeyHex, URLS[y])).json()) as {
      nonce: string;
    }
  ).nonce;
  const atY = await post(y, "/federation/v1/peer/confirm", {
    relay_id: ids[x].relayMotebitId,
    ...(await operatorConfirm(relays[x], nonceAtY, AUTH_HEADER, {
      id: ids[y].relayMotebitId,
      publicKey: ids[y].publicKeyHex,
    })),
  });
  const atX = await post(x, "/federation/v1/peer/confirm", {
    relay_id: ids[y].relayMotebitId,
    ...(await operatorConfirm(relays[y], nonceAtX, AUTH_HEADER, {
      id: ids[x].relayMotebitId,
      publicKey: ids[x].publicKeyHex,
    })),
  });
  expect([atY.status, atX.status]).toEqual([200, 200]);
}

/** A's row at B, byte for byte. */
function rowOfA(): Record<string, unknown> | undefined {
  return relays.b.moteDb.db
    .prepare("SELECT * FROM relay_peers WHERE peer_relay_id = ?")
    .get(ids.a.relayMotebitId) as Record<string, unknown> | undefined;
}

/** Put A's row at B into `state`; removed rows are past the re-peer cooldown. */
function setStateOfA(state: string): void {
  relays.b.moteDb.db
    .prepare(
      "UPDATE relay_peers SET state = ?, nonce = ?, last_heartbeat_at = 1 WHERE peer_relay_id = ?",
    )
    .run(state, state === "pending" ? rand() : null, ids.a.relayMotebitId);
}

/** The key B holds for A still verifies a fresh signature by the real A. */
async function storedKeyStillVerifiesA(): Promise<void> {
  const row = rowOfA();
  expect(row?.public_key).toBe(ids.a.publicKeyHex);
  const msg = new TextEncoder().encode(`probe:${rand()}`);
  const sig = await sign(msg, ids.a.privateKey);
  expect(await verify(sig, msg, hexToBytes(row!.public_key as string))).toBe(true);
}

beforeEach(async () => {
  relays = {} as Record<Name, SyncRelay>;
  ids = {} as Record<Name, RelayIdentity>;
  for (const n of Object.keys(URLS) as Name[]) {
    relays[n] = await createTestRelay({
      enableDeviceAuth: false,
      federation: { endpointUrl: URLS[n], displayName: `Relay ${n}` },
    });
    ids[n] = await initRelayIdentity(relays[n].moteDb.db);
  }
  const kp = await generateKeypair();
  attacker = { ...kp, publicKeyHex: bytesToHex(kp.publicKey) };
  routeFetch();
  await peer("a", "b");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const r of Object.values(relays)) await r.close();
});

const STATES = ["pending", "active", "suspended", "removed"] as const;

describe("a propose naming a different key for a known relay_id is refused", () => {
  for (const state of STATES) {
    it(`prior state ${state}: refused, row byte-identical, old key still verifies`, async () => {
      setStateOfA(state);
      const before = rowOfA();
      expect(before).toBeDefined();

      const res = await propose("b", "a", attacker.publicKeyHex, ATTACKER_URL);
      expect(res.status).toBe(409);
      expect(await res.text()).toMatch(/key on record/);

      expect(rowOfA()).toEqual(before);
      await storedKeyStillVerifiesA();
    });
  }
});

describe("a propose naming the same key", () => {
  it("prior state active: 409 already exists, row unchanged", async () => {
    setStateOfA("active");
    const before = rowOfA();
    const res = await propose("b", "a", ids.a.publicKeyHex, URLS.a);
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/already exists/);
    expect(rowOfA()).toEqual(before);
  });
  // A confirmed peer re-handshakes beside its row (§3.1, peer row authority):
  // the propose writes nothing; the confirm, verified under the stored key,
  // moves the row to active.
  for (const state of ["pending", "suspended", "removed"] as const) {
    it(`prior state ${state}: re-handshake leaves the row until the confirm, then active`, async () => {
      setStateOfA(state);
      const before = rowOfA();
      const res = await propose("b", "a", ids.a.publicKeyHex, URLS.a);
      expect(res.status).toBe(200);
      const { nonce } = (await res.json()) as { nonce: string };
      expect(rowOfA()).toEqual(before);
      const confirm = await post("b", "/federation/v1/peer/confirm", {
        relay_id: ids.a.relayMotebitId,
        ...(await operatorConfirm(relays.a, nonce, AUTH_HEADER, {
          id: ids.b.relayMotebitId,
          publicKey: ids.b.publicKeyHex,
        })),
      });
      expect(confirm.status).toBe(200);
      expect(rowOfA()?.state).toBe("active");
      await storedKeyStillVerifiesA();
    });
  }
});

describe("two-relay takeover attempt on a suspended peer", () => {
  it("an attacker proposing A's relay_id with its own key cannot complete confirm", async () => {
    setStateOfA("suspended");
    const before = rowOfA();

    const res = await propose("b", "a", attacker.publicKeyHex, ATTACKER_URL);
    expect(res.status).toBe(409);
    // Even holding whatever nonce the row carries, a confirm under the
    // attacker's key cannot land: there is no pending row bound to its key.
    const nonce = (rowOfA()?.nonce as string | null) ?? rand();
    const forged = await signedConfirm({
      sender: ids.a.relayMotebitId,
      recipient: ids.b.relayMotebitId,
      recipientPublicKey: ids.b.publicKeyHex,
      nonce,
      endpointUrl: ATTACKER_URL,
      privateKey: attacker.privateKey,
    });
    const confirm = await post("b", "/federation/v1/peer/confirm", forged);
    expect(confirm.status).toBe(403);

    expect(rowOfA()).toEqual(before);
    await storedKeyStillVerifiesA();
  });

  it("a same-key propose followed by a failed confirm does not erase the known key", async () => {
    setStateOfA("suspended");

    // Anyone can send a propose naming A's real key (it is public).
    const res = await propose("b", "a", ids.a.publicKeyHex, ATTACKER_URL);
    expect(res.status).toBe(200);
    const { nonce } = (await res.json()) as { nonce: string };
    // The attacker cannot sign under A's key, so its confirm fails.
    const forged = await signedConfirm({
      sender: ids.a.relayMotebitId,
      recipient: ids.b.relayMotebitId,
      recipientPublicKey: ids.b.publicKeyHex,
      nonce,
      endpointUrl: ATTACKER_URL,
      privateKey: attacker.privateKey,
    });
    const confirm = await post("b", "/federation/v1/peer/confirm", forged);
    expect(confirm.status).toBe(403);

    // The known key survives the failed confirm, so a follow-up propose
    // under the attacker's key is still refused.
    await storedKeyStillVerifiesA();
    const second = await propose("b", "a", attacker.publicKeyHex, ATTACKER_URL);
    expect(second.status).toBe(409);
    await storedKeyStillVerifiesA();
    expect(rowOfA()?.state).not.toBe("active");
  });
});
