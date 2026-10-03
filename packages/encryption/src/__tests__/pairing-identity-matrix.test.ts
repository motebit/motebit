/**
 * Pairing identity matrix — the exhaustive, table-driven harness for the
 * question Device B answers when it completes a pairing: may it adopt the
 * relay-supplied `motebit_id` together with the identity key the transfer
 * carried?
 *
 * Real crypto end to end: Device A builds a real key transfer
 * (`buildKeyTransferPayload`), the relay stores and serves it (and serves the
 * identity's `GET /succession` chain) according to its behaviour, and Device B
 * runs the one shared acceptance path every surface calls.
 *
 * Dimensions:
 *   identity kind × where the chain travels (key transfer from Device A / relay
 *   GET /succession / both / neither) × relay behaviour (honest / withholds /
 *   errors / serves forged / serves a foreign identity's chain)
 * plus an attack table (the relay names an id the transferred key is not) and
 * a malformed-id table.
 *
 * Expected, in one sentence: every legitimately held identity pairs (binding
 * level reported honestly), every forged / foreign / unrelated key is refused
 * with no seed handed back, and a malformed id is refused — only a canonical
 * lowercase UUIDv7 is accepted at `unverified`; a UUIDv8 or `did:key` must bind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeySuccessionRecord, KeyTransferPayload } from "@motebit/protocol";
import {
  generateKeypair,
  generateX25519Keypair,
  buildKeyTransferPayload,
  deriveSovereignMotebitId,
  signKeySuccession,
  signGuardianRecoverySuccession,
  hexPublicKeyToDidKey,
  bytesToHex,
  hexToBytes,
  encrypt,
  x25519SharedSecret,
  deriveKeyTransferKey,
  openPairingKeyTransfer,
} from "../index.js";

// ── Fixtures ────────────────────────────────────────────────────────────

interface Keys {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  hex: string;
}

async function keys(): Promise<Keys> {
  const kp = await generateKeypair();
  return { ...kp, hex: bytesToHex(kp.publicKey) };
}

function uuidV7(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const ms = Date.now();
  for (let i = 0; i < 6; i++) b[i] = Math.floor(ms / 2 ** (8 * (5 - i))) & 0xff;
  b[6] = 0x70 | (b[6]! & 0x0f);
  b[8] = 0x80 | (b[8]! & 0x3f);
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Strict temporal order is part of the succession law; rotations minted in
// one tick would share a timestamp, so the clock advances per mint.
let clock = 1_800_000_000_000;
beforeEach(() => {
  vi.spyOn(Date, "now").mockImplementation(() => (clock += 1000));
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function rotate(from: Keys, to: Keys): Promise<KeySuccessionRecord> {
  return signKeySuccession(from.privateKey, to.privateKey, to.publicKey, from.publicKey);
}

/** A record claiming `from → to` that `from` never signed (the attacker holds only `to`). */
async function forgeLink(fromHex: string, to: Keys): Promise<KeySuccessionRecord> {
  const stranger = await keys();
  const real = await signKeySuccession(
    stranger.privateKey,
    to.privateKey,
    to.publicKey,
    stranger.publicKey,
  );
  return { ...real, old_public_key: fromHex };
}

type Kind =
  | "legacy-v7"
  | "v8-never-rotated"
  | "v8-rotated-once-online"
  | "v8-rotated-twice-online"
  | "v8-rotated-once-offline"
  | "v8-rotated-twice-offline"
  | "v8-online-then-offline"
  | "did:key-never-rotated"
  | "did:key-rotated-offline"
  | "guardian-recovered";

interface Identity {
  kind: Kind;
  motebitId: string;
  current: Keys;
  /** Every link the holder (Device A) has, oldest → newest. */
  heldChain: KeySuccessionRecord[];
  /** The links the relay recorded (an offline rotation uploads nothing). */
  relayChain: KeySuccessionRecord[];
  guardian?: Keys;
}

async function identity(kind: Kind): Promise<Identity> {
  const g = await keys();
  const k1 = await keys();
  const k2 = await keys();
  const v8 = await deriveSovereignMotebitId(g.hex);
  switch (kind) {
    case "legacy-v7":
      return { kind, motebitId: uuidV7(), current: g, heldChain: [], relayChain: [] };
    case "v8-never-rotated":
      return { kind, motebitId: v8, current: g, heldChain: [], relayChain: [] };
    case "v8-rotated-once-online": {
      const c = [await rotate(g, k1)];
      return { kind, motebitId: v8, current: k1, heldChain: c, relayChain: c };
    }
    case "v8-rotated-twice-online": {
      const c = [await rotate(g, k1), await rotate(k1, k2)];
      return { kind, motebitId: v8, current: k2, heldChain: c, relayChain: c };
    }
    case "v8-rotated-once-offline":
      return { kind, motebitId: v8, current: k1, heldChain: [await rotate(g, k1)], relayChain: [] };
    case "v8-rotated-twice-offline": {
      const c = [await rotate(g, k1), await rotate(k1, k2)];
      return { kind, motebitId: v8, current: k2, heldChain: c, relayChain: [] };
    }
    case "v8-online-then-offline": {
      const c = [await rotate(g, k1), await rotate(k1, k2)];
      return { kind, motebitId: v8, current: k2, heldChain: c, relayChain: [c[0]!] };
    }
    case "did:key-never-rotated":
      return {
        kind,
        motebitId: hexPublicKeyToDidKey(g.hex),
        current: g,
        heldChain: [],
        relayChain: [],
      };
    case "did:key-rotated-offline":
      return {
        kind,
        motebitId: hexPublicKeyToDidKey(g.hex),
        current: k1,
        heldChain: [await rotate(g, k1)],
        relayChain: [],
      };
    case "guardian-recovered": {
      const guardian = await keys();
      const c = [
        await signGuardianRecoverySuccession(
          guardian.privateKey,
          k1.privateKey,
          g.publicKey,
          k1.publicKey,
        ),
      ];
      return { kind, motebitId: v8, current: k1, heldChain: c, relayChain: c, guardian };
    }
  }
}

// ── The three parties ───────────────────────────────────────────────────

type Relay = "honest" | "withholds" | "errors" | "forged" | "foreign";

/** The relay's `GET /api/v1/agents/:id/succession`, by behaviour. */
async function relaySuccession(
  who: Identity,
  behaviour: Relay,
): Promise<() => Promise<readonly unknown[]>> {
  switch (behaviour) {
    case "honest":
      return () => Promise.resolve(who.relayChain);
    case "withholds":
      return () => Promise.resolve([]);
    case "errors":
      return () => Promise.reject(new Error("503"));
    case "forged": {
      const forged = [
        await forgeLink(who.heldChain[0]?.old_public_key ?? who.current.hex, who.current),
      ];
      return () => Promise.resolve(forged);
    }
    case "foreign": {
      const f = await identity("v8-rotated-twice-online");
      return () => Promise.resolve(f.relayChain);
    }
  }
}

/** Device A: the key transfer it posts with its approval. */
async function deviceA(
  holder: Keys,
  chainInTransfer: readonly KeySuccessionRecord[] | undefined,
  claimX25519: Uint8Array,
  code: string,
): Promise<KeyTransferPayload> {
  return buildKeyTransferPayload(
    holder.privateKey,
    holder.hex,
    claimX25519,
    code,
    chainInTransfer !== undefined ? { successionRecords: chainInTransfer } : undefined,
  );
}

interface Outcome {
  accepted: boolean;
  binding?: string;
  reason?: string;
  seedHex?: string;
}

/**
 * Device B — the one acceptance path every surface's `completePairing` calls
 * (`openPairingKeyTransfer`). At 96a5e9ee each surface ran the sequence
 * inline: decrypt, then `verifyPairingIdentityBinding` with the relay's
 * /succession as the only chain source.
 */
async function deviceB(input: {
  motebitId: string;
  keyTransfer: KeyTransferPayload;
  ephemeralPrivateKey: Uint8Array;
  pairingCode: string;
  relay: () => Promise<readonly unknown[]>;
  guardianKey?: string;
}): Promise<Outcome> {
  try {
    const opened = await openPairingKeyTransfer({
      motebitId: input.motebitId,
      keyTransfer: input.keyTransfer,
      ephemeralPrivateKey: input.ephemeralPrivateKey,
      pairingCode: input.pairingCode,
      fetchSuccessionChain: input.relay,
      ...(input.guardianKey !== undefined ? { guardianKey: input.guardianKey } : {}),
    });
    return {
      accepted: true,
      binding: opened.identityBinding,
      seedHex: bytesToHex(opened.identitySeed),
    };
  } catch (err) {
    return { accepted: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function pair(opts: {
  motebitId: string;
  holder: Keys;
  chainInTransfer: readonly KeySuccessionRecord[] | undefined;
  relay: () => Promise<readonly unknown[]>;
  guardianKey?: string;
}): Promise<Outcome> {
  const code = "K7Q2ZP";
  const b = generateX25519Keypair();
  const keyTransfer = await deviceA(opts.holder, opts.chainInTransfer, b.publicKey, code);
  return deviceB({
    motebitId: opts.motebitId,
    keyTransfer,
    ephemeralPrivateKey: b.privateKey,
    pairingCode: code,
    relay: opts.relay,
    ...(opts.guardianKey !== undefined ? { guardianKey: opts.guardianKey } : {}),
  });
}

// ── Table 1: legitimate identities ──────────────────────────────────────

const KINDS: Kind[] = [
  "legacy-v7",
  "v8-never-rotated",
  "v8-rotated-once-online",
  "v8-rotated-twice-online",
  "v8-rotated-once-offline",
  "v8-rotated-twice-offline",
  "v8-online-then-offline",
  "did:key-never-rotated",
  "did:key-rotated-offline",
  "guardian-recovered",
];
type Carry = "transfer" | "relay-only" | "neither";
const CARRIES: Carry[] = ["transfer", "relay-only", "neither"];
const RELAYS: Relay[] = ["honest", "withholds", "errors", "forged", "foreign"];

function expectedFor(
  who: Identity,
  carry: Carry,
  relay: Relay,
): { accepted: boolean; binding?: string; reasonMatch?: RegExp } {
  if (who.kind === "guardian-recovered") {
    // Refused by design (no guardian key pinned on Device B). When the
    // recovery link reaches Device B the refusal says why and what to do;
    // when it never arrives, Device B cannot know and refuses generically.
    const linkSeen = carry === "transfer" || (carry === "relay-only" && relay === "honest");
    return {
      accepted: false,
      reasonMatch: linkSeen
        ? /guardian.*motebit\.md and its current recovery seed/i
        : /does not bind/,
    };
  }
  if (who.kind === "legacy-v7") return { accepted: true, binding: "unverified" };
  if (who.heldChain.length === 0) return { accepted: true, binding: "sovereign" };
  // A rotated self-certifying identity binds through a verified chain: the
  // one Device A carried in the transfer, else the relay's (when it is whole).
  if (carry === "transfer") return { accepted: true, binding: "sovereign" };
  const relayWhole = relay === "honest" && who.relayChain.length === who.heldChain.length;
  return relayWhole ? { accepted: true, binding: "sovereign" } : { accepted: false };
}

describe("pairing identity matrix — legitimate identities", () => {
  for (const kind of KINDS) {
    for (const carry of CARRIES) {
      for (const relay of RELAYS) {
        it(`${kind} · chain via ${carry} · relay ${relay}`, async () => {
          const who = await identity(kind);
          const out = await pair({
            motebitId: who.motebitId,
            holder: who.current,
            // "relay-only" and "neither" model a Device A that sends no chain
            // (an older client): only the relay can supply it.
            chainInTransfer: carry === "transfer" ? who.heldChain : undefined,
            relay:
              carry === "neither" ? () => Promise.resolve([]) : await relaySuccession(who, relay),
          });
          const want = expectedFor(who, carry === "neither" ? "neither" : carry, relay);
          if (
            carry === "neither" &&
            who.heldChain.length > 0 &&
            who.kind !== "guardian-recovered"
          ) {
            want.accepted = false;
            delete want.binding;
          }
          expect({ accepted: out.accepted, binding: out.binding }).toEqual({
            accepted: want.accepted,
            binding: want.binding,
          });
          if (out.accepted) {
            expect(out.seedHex).toBe(bytesToHex(who.current.privateKey));
          } else {
            expect(out.seedHex).toBeUndefined();
            expect(out.reason).toMatch(/^Pairing refused: /);
            if (want.reasonMatch) expect(out.reason).toMatch(want.reasonMatch);
          }
        });
      }
    }
  }

  it("guardian-recovered · guardian key pinned on Device B → accepted (sovereign)", async () => {
    const who = await identity("guardian-recovered");
    const out = await pair({
      motebitId: who.motebitId,
      holder: who.current,
      chainInTransfer: who.heldChain,
      relay: () => Promise.resolve([]),
      guardianKey: who.guardian!.hex,
    });
    expect({ accepted: out.accepted, binding: out.binding }).toEqual({
      accepted: true,
      binding: "sovereign",
    });
  });

  it("guardian-recovered · a different pinned guardian → refused", async () => {
    const who = await identity("guardian-recovered");
    const other = await keys();
    const out = await pair({
      motebitId: who.motebitId,
      holder: who.current,
      chainInTransfer: who.heldChain,
      relay: () => Promise.resolve(who.relayChain),
      guardianKey: other.hex,
    });
    expect(out.accepted).toBe(false);
  });

  it("a stale Device A whose key was rotated on elsewhere: its own verified chain roots the key it holds → accepted", async () => {
    // The relay is a fallback only, never consulted once the transfer roots
    // the key — so a later rotation the relay knows of does not refuse here.
    // Not a forgery (the key is one this identity verifiably held); the
    // roster, not pairing, reports a superseded key (held_key_superseded).
    const g = await keys();
    const k1 = await keys();
    const k2 = await keys();
    const r1 = await rotate(g, k1);
    const r2 = await rotate(k1, k2);
    const out = await pair({
      motebitId: await deriveSovereignMotebitId(g.hex),
      holder: k1,
      chainInTransfer: [r1],
      relay: () => Promise.resolve([r1, r2]),
    });
    expect(out.binding).toBe("sovereign");
  });
});

// ── Table 2: the relay names an id the transferred key is not ───────────

type Attack =
  | "no-chain"
  | "forged-link-from-victim-genesis"
  | "foreign-identity-chain"
  | "victim-real-chain-replayed";

const ATTACKS: Attack[] = [
  "no-chain",
  "forged-link-from-victim-genesis",
  "foreign-identity-chain",
  "victim-real-chain-replayed",
];
const VICTIMS: Kind[] = [
  "v8-never-rotated",
  "v8-rotated-once-online",
  "v8-rotated-twice-offline",
  "did:key-never-rotated",
  "guardian-recovered",
];

describe("pairing identity matrix — forged / foreign / unrelated keys", () => {
  for (const victimKind of VICTIMS) {
    for (const attack of ATTACKS) {
      for (const relay of ["honest", "withholds", "forged", "foreign"] as const) {
        it(`victim ${victimKind} · transfer ${attack} · relay ${relay} → refused`, async () => {
          const victim = await identity(victimKind);
          const attacker = await keys();
          const genesis = victim.heldChain[0]?.old_public_key ?? victim.current.hex;
          let chain: KeySuccessionRecord[] | undefined;
          switch (attack) {
            case "no-chain":
              chain = undefined;
              break;
            case "forged-link-from-victim-genesis":
              chain = [await forgeLink(genesis, attacker)];
              break;
            case "foreign-identity-chain": {
              const a0 = await keys();
              chain = [await rotate(a0, attacker)];
              break;
            }
            case "victim-real-chain-replayed":
              chain = victim.heldChain;
              break;
          }
          const relayFn =
            relay === "forged"
              ? () => forgeLink(genesis, attacker).then((r) => [r])
              : await relaySuccession(victim, relay);
          const out = await pair({
            motebitId: victim.motebitId,
            holder: attacker,
            chainInTransfer: chain,
            relay: relayFn,
            ...(victim.guardian ? { guardianKey: victim.guardian.hex } : {}),
          });
          expect(out.accepted).toBe(false);
          expect(out.seedHex).toBeUndefined();
        });
      }
    }
  }

  it("legacy UUIDv7: the relay can name one for any key — accepted only at `unverified` (stated residual)", async () => {
    const attacker = await keys();
    const out = await pair({
      motebitId: uuidV7(),
      holder: attacker,
      chainInTransfer: undefined,
      relay: () => Promise.resolve([]),
    });
    expect({ accepted: out.accepted, binding: out.binding }).toEqual({
      accepted: true,
      binding: "unverified",
    });
  });
});

// ── Table 3: malformed ids ──────────────────────────────────────────────

describe("pairing identity matrix — malformed ids are refused", () => {
  const variants: Array<[string, (id: string) => string, Kind]> = [
    ["empty", () => "", "v8-never-rotated"],
    ["urn:uuid: prefix", (id) => `urn:uuid:${id}`, "v8-never-rotated"],
    ["trailing space", (id) => `${id} `, "v8-never-rotated"],
    ["leading space", (id) => ` ${id}`, "v8-never-rotated"],
    ["braced", (id) => `{${id}}`, "v8-never-rotated"],
    ["uppercase UUIDv8", (id) => id.toUpperCase(), "v8-never-rotated"],
    ["hyphenless UUIDv8", (id) => id.replace(/-/g, ""), "v8-never-rotated"],
    [
      "uppercase DID:key prefix",
      (id) => id.replace(/^did:key:/, "DID:key:"),
      "did:key-never-rotated",
    ],
    ["did:KEY prefix", (id) => id.replace(/^did:key:/, "did:KEY:"), "did:key-never-rotated"],
    ["did:key with trailing newline", (id) => `${id}\n`, "did:key-never-rotated"],
    ["uppercase UUIDv7", (id) => id.toUpperCase(), "legacy-v7"],
    ["hyphenless UUIDv7", (id) => id.replace(/-/g, ""), "legacy-v7"],
    ["UUIDv7 trailing space", (id) => `${id} `, "legacy-v7"],
    ["urn:uuid: UUIDv7", (id) => `urn:uuid:${id}`, "legacy-v7"],
    ["UUIDv4 (not a minted form)", () => "3f1c2a9e-5b7d-4e21-9c0a-6d8e2f4b1a37", "legacy-v7"],
    ["free text", () => "agent-alice", "legacy-v7"],
  ];
  for (const [label, mangle, kind] of variants) {
    for (const carry of ["transfer", "relay-only"] as const) {
      it(`${label} (${kind}) · chain via ${carry} → refused`, async () => {
        const who = await identity(kind);
        const out = await pair({
          motebitId: mangle(who.motebitId),
          holder: who.current,
          chainInTransfer: carry === "transfer" ? who.heldChain : undefined,
          relay: () => Promise.resolve(who.relayChain),
        });
        expect(out.accepted).toBe(false);
        expect(out.seedHex).toBeUndefined();
      });
    }
  }
});

// ── Table 4: transfer integrity ─────────────────────────────────────────

describe("pairing identity matrix — the transfer itself", () => {
  it("a transfer whose succession ciphertext was tampered → falls back to the relay, never accepts on it", async () => {
    const who = await identity("v8-rotated-once-offline");
    const code = "K7Q2ZP";
    const b = generateX25519Keypair();
    const kt = await deviceA(who.current, who.heldChain, b.publicKey, code);
    const tampered = { ...kt } as KeyTransferPayload & Record<string, unknown>;
    for (const k of Object.keys(tampered)) {
      if (k.startsWith("encrypted_succession")) {
        const v = tampered[k] as string;
        tampered[k] = (v[0] === "0" ? "1" : "0") + v.slice(1);
      }
    }
    const out = await deviceB({
      motebitId: who.motebitId,
      keyTransfer: tampered,
      ephemeralPrivateKey: b.privateKey,
      pairingCode: code,
      relay: () => Promise.resolve([]),
    });
    expect(out.accepted).toBe(false);
  });

  it("an old Device A (no succession fields) still pairs a never-rotated identity", async () => {
    const who = await identity("v8-never-rotated");
    const out = await pair({
      motebitId: who.motebitId,
      holder: who.current,
      chainInTransfer: undefined,
      relay: () => Promise.reject(new Error("must not be needed")),
    });
    expect(out.binding).toBe("sovereign");
  });

  it("a wrong pairing code → refused", async () => {
    const who = await identity("v8-never-rotated");
    const b = generateX25519Keypair();
    const kt = await deviceA(who.current, undefined, b.publicKey, "K7Q2ZP");
    const out = await deviceB({
      motebitId: who.motebitId,
      keyTransfer: kt,
      ephemeralPrivateKey: b.privateKey,
      pairingCode: "WRONG1",
      relay: () => Promise.resolve([]),
    });
    expect(out.accepted).toBe(false);
  });
});

// ── Table 5: the shared path's edges ────────────────────────────────────

describe("openPairingKeyTransfer — edges", () => {
  it("no key transfer at all → refused", async () => {
    const who = await identity("v8-never-rotated");
    await expect(
      openPairingKeyTransfer({
        motebitId: who.motebitId,
        keyTransfer: null,
        ephemeralPrivateKey: generateX25519Keypair().privateKey,
        pairingCode: "K7Q2ZP",
      }),
    ).rejects.toThrow(/^Pairing refused: the approval carried no identity key transfer/);
  });

  it("no relay fallback configured: a rotated identity binds only through the transfer", async () => {
    const who = await identity("v8-rotated-once-offline");
    const code = "K7Q2ZP";
    for (const carried of [who.heldChain, undefined]) {
      const b = generateX25519Keypair();
      const keyTransfer = await deviceA(who.current, carried, b.publicKey, code);
      const run = openPairingKeyTransfer({
        motebitId: who.motebitId,
        keyTransfer,
        ephemeralPrivateKey: b.privateKey,
        pairingCode: code,
      });
      if (carried) await expect(run).resolves.toMatchObject({ identityBinding: "sovereign" });
      else await expect(run).rejects.toThrow(/does not bind/);
    }
  });

  it("a sealed succession that is not a JSON array, or only some of the three fields, is ignored", async () => {
    const who = await identity("v8-rotated-once-offline");
    const code = "K7Q2ZP";
    const b = generateX25519Keypair();
    const kt = await deviceA(who.current, who.heldChain, b.publicKey, code);
    // Re-seal a JSON object (not an array) under the same transfer key.
    const shared = x25519SharedSecret(b.privateKey, hexToBytes(kt.x25519_pubkey));
    const key = await deriveKeyTransferKey(shared, code);
    const sealed = await encrypt(new TextEncoder().encode('{"not":"an array"}'), key);
    const notArray: KeyTransferPayload = {
      ...kt,
      encrypted_succession: bytesToHex(sealed.ciphertext),
      succession_nonce: bytesToHex(sealed.nonce),
      succession_tag: bytesToHex(sealed.tag),
    };
    const partial: KeyTransferPayload = { ...kt };
    delete partial.succession_tag;
    for (const keyTransfer of [notArray, partial]) {
      await expect(
        openPairingKeyTransfer({
          motebitId: who.motebitId,
          keyTransfer,
          ephemeralPrivateKey: b.privateKey,
          pairingCode: code,
          fetchSuccessionChain: () => Promise.resolve([]),
        }),
      ).rejects.toThrow(/does not bind/);
    }
    // The untouched transfer binds, so the refusals above are the fields'.
    await expect(
      openPairingKeyTransfer({
        motebitId: who.motebitId,
        keyTransfer: kt,
        ephemeralPrivateKey: b.privateKey,
        pairingCode: code,
      }),
    ).resolves.toMatchObject({ identityBinding: "sovereign" });
  });

  it("an empty chain sends no succession fields (the earlier payload shape)", async () => {
    const who = await identity("v8-never-rotated");
    const kt = await deviceA(who.current, [], generateX25519Keypair().publicKey, "K7Q2ZP");
    expect(Object.keys(kt).sort()).toEqual(
      ["encrypted_seed", "identity_pubkey_check", "nonce", "tag", "x25519_pubkey"].sort(),
    );
  });
});
