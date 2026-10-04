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
 * plus a fork table: the relay's served chain extends / equals / is a prefix of
 * / conflicts with / is unreachable vs the chain the transfer carries.
 *
 * Expected, in one sentence: every legitimately held, CURRENT identity key
 * pairs (binding level reported honestly), every forged / foreign / unrelated
 * or superseded key is refused with no seed handed back, a fork the relay's
 * verified chain proves is refused, and a malformed id is refused — only a
 * canonical lowercase UUIDv7 or UUIDv4 (the ids seed-only restore minted
 * 2026-05-15..22) is accepted at `unverified`; a UUIDv8 or `did:key` must bind.
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
  verifiedIdentityLineage,
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

/** What desktop/mobile seed-only restore minted from 4d19695e until 6c0c710c. */
function uuidV4(): string {
  return crypto.randomUUID();
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
  | "legacy-v4"
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
    case "legacy-v4":
      return { kind, motebitId: uuidV4(), current: g, heldChain: [], relayChain: [] };
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
  /** Whether the relay's served chain was checked for a fork. */
  relayCheck?: string;
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
  relay?: () => Promise<readonly unknown[]>;
  guardianKey?: string;
}): Promise<Outcome> {
  try {
    const opened = await openPairingKeyTransfer({
      motebitId: input.motebitId,
      keyTransfer: input.keyTransfer,
      ephemeralPrivateKey: input.ephemeralPrivateKey,
      pairingCode: input.pairingCode,
      ...(input.relay !== undefined ? { fetchSuccessionChain: input.relay } : {}),
      ...(input.guardianKey !== undefined ? { guardianKey: input.guardianKey } : {}),
    });
    return {
      accepted: true,
      binding: opened.identityBinding,
      relayCheck: (opened as { relayCheck?: string }).relayCheck,
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
  relay?: () => Promise<readonly unknown[]>;
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
    ...(opts.relay !== undefined ? { relay: opts.relay } : {}),
    ...(opts.guardianKey !== undefined ? { guardianKey: opts.guardianKey } : {}),
  });
}

// ── Table 1: legitimate identities ──────────────────────────────────────

const KINDS: Kind[] = [
  "legacy-v7",
  "legacy-v4",
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
  if (who.kind === "legacy-v7" || who.kind === "legacy-v4") {
    return { accepted: true, binding: "unverified" };
  }
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

  for (const [label, mint] of [
    ["UUIDv7", uuidV7],
    ["UUIDv4", uuidV4],
  ] as const) {
    it(`legacy ${label}: the relay can name one for any key — accepted only at \`unverified\` (stated residual)`, async () => {
      const attacker = await keys();
      const out = await pair({
        motebitId: mint(),
        holder: attacker,
        chainInTransfer: undefined,
        relay: () => Promise.resolve([]),
      });
      expect({ accepted: out.accepted, binding: out.binding }).toEqual({
        accepted: true,
        binding: "unverified",
      });
    });
  }
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
    ["uppercase UUIDv4", (id) => id.toUpperCase(), "legacy-v4"],
    ["hyphenless UUIDv4", (id) => id.replace(/-/g, ""), "legacy-v4"],
    ["UUIDv4 trailing space", (id) => `${id} `, "legacy-v4"],
    ["braced UUIDv4", (id) => `{${id}}`, "legacy-v4"],
    [
      "UUIDv4 with a non-RFC variant nibble",
      (id) => `${id.slice(0, 19)}c${id.slice(20)}`,
      "legacy-v4",
    ],
    ["UUIDv1 (never minted)", () => "3f1c2a9e-5b7d-1e21-9c0a-6d8e2f4b1a37", "legacy-v7"],
    ["UUIDv6 (never minted)", () => "3f1c2a9e-5b7d-6e21-9c0a-6d8e2f4b1a37", "legacy-v7"],
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
      relay: () => Promise.reject(new Error("503")),
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

// ── Table 6: the relay's served chain vs the transfer's ─────────────────

// The real history K0 → K1 → K2 is on the relay. Each cell is one device
// holding one key, what its transfer carries, and what the relay serves.
describe("pairing identity matrix — fork from a superseded key", () => {
  type Relation = "extends" | "equals" | "prefix" | "conflicts" | "unreachable";
  interface Cell {
    label: string;
    relation: Relation;
    idKind: "v8" | "did:key";
    build: (h: History) => Promise<{
      holder: Keys;
      transfer: KeySuccessionRecord[] | undefined;
      relay: (() => Promise<readonly unknown[]>) | undefined;
    }>;
    want: { accepted: true; relayCheck: string } | { accepted: false };
  }
  interface History {
    k0: Keys;
    k1: Keys;
    k2: Keys;
    r1: KeySuccessionRecord;
    r2: KeySuccessionRecord;
  }
  async function history(): Promise<History> {
    const k0 = await keys();
    const k1 = await keys();
    const k2 = await keys();
    return { k0, k1, k2, r1: await rotate(k0, k1), r2: await rotate(k1, k2) };
  }
  const serve = (records: readonly unknown[]) => () => Promise.resolve(records);
  const down = () => Promise.reject(new Error("ECONNREFUSED"));

  const cells: Cell[] = [];
  for (const idKind of ["v8", "did:key"] as const) {
    cells.push(
      {
        label: "relay extends: K1 holder, transfer [K0→K1], relay [K0→K1, K1→K2]",
        relation: "extends",
        idKind,
        build: async (h) => ({ holder: h.k1, transfer: [h.r1], relay: serve([h.r1, h.r2]) }),
        want: { accepted: false },
      },
      {
        label: "relay extends: K0 holder (genesis), no chain, relay [K0→K1, K1→K2]",
        relation: "extends",
        idKind,
        build: async (h) => ({ holder: h.k0, transfer: undefined, relay: serve([h.r1, h.r2]) }),
        want: { accepted: false },
      },
      {
        label: "relay equals: K2 holder, transfer [K0→K1, K1→K2], relay the same",
        relation: "equals",
        idKind,
        build: async (h) => ({ holder: h.k2, transfer: [h.r1, h.r2], relay: serve([h.r1, h.r2]) }),
        want: { accepted: true, relayCheck: "no_conflict" },
      },
      {
        label: "relay prefix: K2 holder, transfer [K0→K1, K1→K2], relay [K0→K1] (offline rotation)",
        relation: "prefix",
        idKind,
        build: async (h) => ({ holder: h.k2, transfer: [h.r1, h.r2], relay: serve([h.r1]) }),
        want: { accepted: true, relayCheck: "no_conflict" },
      },
      {
        label: "relay prefix: K2 holder, transfer [K0→K1, K1→K2], relay [] (nothing uploaded)",
        relation: "prefix",
        idKind,
        build: async (h) => ({ holder: h.k2, transfer: [h.r1, h.r2], relay: serve([]) }),
        want: { accepted: true, relayCheck: "no_conflict" },
      },
      {
        label: "relay conflicts: K0 holder signs K0→Kx, relay [K0→K1, K1→K2]",
        relation: "conflicts",
        idKind,
        build: async (h) => {
          const kx = await keys();
          return { holder: kx, transfer: [await rotate(h.k0, kx)], relay: serve([h.r1, h.r2]) };
        },
        want: { accepted: false },
      },
      {
        label: "relay conflicts: K0 holder signs K0→Kx, relay serves only [K0→K1]",
        relation: "conflicts",
        idKind,
        build: async (h) => {
          const kx = await keys();
          return { holder: kx, transfer: [await rotate(h.k0, kx)], relay: serve([h.r1]) };
        },
        want: { accepted: false },
      },
      {
        label: "relay conflicts: K1 holder signs K1→Kx, relay [K0→K1, K1→K2]",
        relation: "conflicts",
        idKind,
        build: async (h) => {
          const kx = await keys();
          return {
            holder: kx,
            transfer: [h.r1, await rotate(h.k1, kx)],
            relay: serve([h.r1, h.r2]),
          };
        },
        want: { accepted: false },
      },
      {
        label: "relay conflicts: the transfer itself carries both successors of K0",
        relation: "conflicts",
        idKind,
        build: async (h) => {
          const kx = await keys();
          return { holder: kx, transfer: [h.r1, await rotate(h.k0, kx)], relay: serve([]) };
        },
        want: { accepted: false },
      },
      {
        label: "relay serves a FORGED K0→Ky (not signed by K0): no proven fork",
        relation: "prefix",
        idKind,
        build: async (h) => ({
          holder: h.k2,
          transfer: [h.r1, h.r2],
          relay: serve([await forgeLink(h.k0.hex, await keys())]),
        }),
        want: { accepted: true, relayCheck: "no_conflict" },
      },
      {
        label: "relay unreachable: K0 holder's fork K0→Kx binds on the transfer (stated residual)",
        relation: "unreachable",
        idKind,
        build: async (h) => {
          const kx = await keys();
          return { holder: kx, transfer: [await rotate(h.k0, kx)], relay: down };
        },
        want: { accepted: true, relayCheck: "unreachable" },
      },
      {
        label: "no relay configured: binds on the transfer, the fork check not run",
        relation: "unreachable",
        idKind,
        build: async (h) => ({ holder: h.k2, transfer: [h.r1, h.r2], relay: undefined }),
        want: { accepted: true, relayCheck: "not_checked" },
      },
    );
  }

  for (const cell of cells) {
    it(`${cell.idKind} · ${cell.relation} · ${cell.label}`, async () => {
      const h = await history();
      const motebitId =
        cell.idKind === "v8"
          ? await deriveSovereignMotebitId(h.k0.hex)
          : hexPublicKeyToDidKey(h.k0.hex);
      const { holder, transfer, relay } = await cell.build(h);
      let relayCalls = 0;
      const out = await pair({
        motebitId,
        holder,
        chainInTransfer: transfer,
        ...(relay !== undefined
          ? {
              relay: () => {
                relayCalls++;
                return relay();
              },
            }
          : {}),
      });
      // Reachable or not, a configured relay is always asked.
      if (relay !== undefined) expect(relayCalls).toBeGreaterThanOrEqual(1);
      if (cell.want.accepted) {
        expect({
          accepted: out.accepted,
          binding: out.binding,
          relayCheck: out.relayCheck,
        }).toEqual({
          accepted: true,
          binding: "sovereign",
          relayCheck: cell.want.relayCheck,
        });
        expect(out.seedHex).toBe(bytesToHex(holder.privateKey));
      } else {
        expect(out.accepted).toBe(false);
        expect(out.seedHex).toBeUndefined();
        expect(out.reason).toMatch(/^Pairing refused: identity fork detected/);
      }
    });
  }

  it("a never-rotated identity with an unreachable relay still pairs, reported `unreachable`", async () => {
    const who = await identity("v8-never-rotated");
    const out = await pair({
      motebitId: who.motebitId,
      holder: who.current,
      chainInTransfer: undefined,
      relay: down,
    });
    expect({ binding: out.binding, relayCheck: out.relayCheck }).toEqual({
      binding: "sovereign",
      relayCheck: "unreachable",
    });
  });

  it("a legacy id is never checked against the relay (it commits to no key)", async () => {
    for (const motebitId of [uuidV7(), uuidV4()]) {
      const holder = await keys();
      let called = false;
      const out = await pair({
        motebitId,
        holder,
        chainInTransfer: undefined,
        relay: () => {
          called = true;
          return Promise.resolve([]);
        },
      });
      expect({ binding: out.binding, relayCheck: out.relayCheck, called }).toEqual({
        binding: "unverified",
        relayCheck: "not_checked",
        called: false,
      });
    }
  });
});

// ── Table 6: multi-hop — A → B, then B (as Device A) → C ────────────────
//
// Device B must be able to approve the NEXT pairing for the identity it just
// adopted. The relay may hold no chain (an offline rotation uploads nothing),
// so B's outgoing transfer can carry only what B itself persisted at
// acceptance. B's persistence is modelled the way every surface does it: the
// verified lineage `openPairingKeyTransfer` hands back, admitted through
// `verifiedIdentityLineage` (the gate the surface-kit helper applies), unioned
// into B's store; B's outgoing transfer is then built from that store.

const MULTI_HOP_KINDS: Kind[] = KINDS.filter((k) => k !== "guardian-recovered");

interface DeviceBState {
  seed: Uint8Array;
  publicKeyHex: string;
  /** What Device B persisted (its roster replica's succession). */
  store: KeySuccessionRecord[];
}

const recordKey = (r: KeySuccessionRecord): string =>
  `${r.old_public_key}>${r.new_public_key}>${r.new_key_signature}`;

/** Device B's persistence step, as the surfaces run it after acceptance. */
async function persistOnB(
  store: readonly KeySuccessionRecord[],
  motebitId: string,
  opened: { publicKeyHex: string; succession: readonly KeySuccessionRecord[] },
): Promise<KeySuccessionRecord[]> {
  const admitted = await verifiedIdentityLineage({
    motebitId,
    publicKeyHex: opened.publicKeyHex,
    records: opened.succession,
  });
  const out = new Map<string, KeySuccessionRecord>();
  for (const r of [...store, ...admitted]) if (!out.has(recordKey(r))) out.set(recordKey(r), r);
  return [...out.values()];
}

/** One pairing hop: `from` (holding `seed`) sends `chain`; the new device opens and persists. */
async function hop(opts: {
  motebitId: string;
  seed: Uint8Array;
  publicKeyHex: string;
  chain: readonly KeySuccessionRecord[];
  relay: () => Promise<readonly unknown[]>;
  priorStore?: KeySuccessionRecord[];
}): Promise<{ outcome: Outcome; state?: DeviceBState }> {
  const code = "M2HOP9";
  const claimer = generateX25519Keypair();
  const keyTransfer = await buildKeyTransferPayload(
    opts.seed,
    opts.publicKeyHex,
    claimer.publicKey,
    code,
    { successionRecords: opts.chain },
  );
  let opened: Awaited<ReturnType<typeof openPairingKeyTransfer>>;
  try {
    opened = await openPairingKeyTransfer({
      motebitId: opts.motebitId,
      keyTransfer,
      ephemeralPrivateKey: claimer.privateKey,
      pairingCode: code,
      fetchSuccessionChain: opts.relay,
    });
  } catch (err) {
    return {
      outcome: { accepted: false, reason: err instanceof Error ? err.message : String(err) },
    };
  }
  // Persistence runs only after acceptance — and is never mistaken for a refusal.
  const succession = (opened as { succession?: KeySuccessionRecord[] }).succession ?? [];
  const store = await persistOnB(opts.priorStore ?? [], opts.motebitId, {
    publicKeyHex: opened.publicKeyHex,
    succession,
  });
  return {
    outcome: {
      accepted: true,
      binding: opened.identityBinding,
      relayCheck: opened.relayCheck,
      seedHex: bytesToHex(opened.identitySeed),
    },
    state: {
      seed: new Uint8Array(opened.identitySeed),
      publicKeyHex: opened.publicKeyHex,
      store,
    },
  };
}

describe("pairing identity matrix — multi-hop A → B → C (B approves from what it persisted)", () => {
  const relayModes = ["honest", "errors"] as const;
  for (const kind of MULTI_HOP_KINDS) {
    for (const relayMode of relayModes) {
      it(`${kind} · relay ${relayMode} · A → B → C`, async () => {
        const who = await identity(kind);
        const relay =
          relayMode === "honest"
            ? () => Promise.resolve(who.relayChain)
            : () => Promise.reject(new Error("503"));
        const want =
          who.kind === "legacy-v7" || who.kind === "legacy-v4" ? "unverified" : "sovereign";

        // A → B: A seals the chain it holds.
        const ab = await hop({
          motebitId: who.motebitId,
          seed: who.current.privateKey,
          publicKeyHex: who.current.hex,
          chain: who.heldChain,
          relay,
        });
        expect({ accepted: ab.outcome.accepted, binding: ab.outcome.binding }).toEqual({
          accepted: true,
          binding: want,
        });
        const b = ab.state!;
        // B persisted exactly the verified lineage to the key it now holds.
        expect(b.store.map(recordKey)).toEqual(
          want === "sovereign" ? who.heldChain.map(recordKey) : [],
        );

        // B → C: B (now Device A) seals ONLY what it persisted.
        const bc = await hop({
          motebitId: who.motebitId,
          seed: b.seed,
          publicKeyHex: b.publicKeyHex,
          chain: b.store,
          relay,
        });
        expect({
          accepted: bc.outcome.accepted,
          binding: bc.outcome.binding,
          reason: bc.outcome.reason,
        }).toEqual({ accepted: true, binding: want, reason: undefined });
        expect(bc.outcome.seedHex).toBe(bytesToHex(who.current.privateKey));
        // And C can approve a fourth device the same way (the lineage keeps travelling).
        expect(bc.state!.store.map(recordKey)).toEqual(b.store.map(recordKey));
      });
    }
  }

  it("persisting the same lineage twice is idempotent", async () => {
    const who = await identity("v8-rotated-twice-offline");
    const relay = () => Promise.resolve([] as unknown[]);
    const first = await hop({
      motebitId: who.motebitId,
      seed: who.current.privateKey,
      publicKeyHex: who.current.hex,
      chain: who.heldChain,
      relay,
    });
    const again = await hop({
      motebitId: who.motebitId,
      seed: who.current.privateKey,
      publicKeyHex: who.current.hex,
      chain: who.heldChain,
      relay,
      priorStore: first.state!.store,
    });
    expect(again.state!.store.map(recordKey)).toEqual(who.heldChain.map(recordKey));
  });

  it("the persistence gate admits no unverified record (forged, foreign, or off-lineage)", async () => {
    const who = await identity("v8-rotated-once-offline");
    const foreign = await identity("v8-rotated-twice-online");
    const forged = await forgeLink(who.heldChain[0]!.old_public_key, await keys());
    const admitted = await verifiedIdentityLineage({
      motebitId: who.motebitId,
      publicKeyHex: who.current.hex,
      records: [...who.heldChain, forged, ...foreign.relayChain, { not: "a record" }],
    });
    expect(admitted.map(recordKey)).toEqual(who.heldChain.map(recordKey));
    // A chain that does not reach the held key admits nothing at all.
    expect(
      await verifiedIdentityLineage({
        motebitId: who.motebitId,
        publicKeyHex: (await keys()).hex,
        records: who.heldChain,
      }),
    ).toEqual([]);
    // A legacy id commits to no key: there is no lineage to persist.
    expect(
      await verifiedIdentityLineage({
        motebitId: uuidV7(),
        publicKeyHex: who.current.hex,
        records: who.heldChain,
      }),
    ).toEqual([]);
  });
});
