/**
 * The one OpenPGP shape the offline verifier accepts (spec/repo-change-v1.md
 * §9: the squash commit's committer time is accepted only when the commit's
 * signature verifies under a pinned set of the hosting operator's signing
 * keys). It reads exactly:
 *
 *   - a commit's `gpgsig` header (`gpgsig-sha256` in a sha256 repository),
 *     present once (one empty last continuation line, GitHub's form, read
 *     as the armor's trailing newline), holding one ASCII-armored `PGP
 *     SIGNATURE` whose CRC-24 is present and right, whose body is ONE v4
 *     signature packet with nothing after it: signature type 0x00 (binary document), public-key algorithm
 *     RSA (1), hash algorithm SHA-256 (8); a signature creation time (subpacket
 *     2) exactly once, in the hashed area; the issuer named by fingerprint
 *     (33, version 4) and/or key id (16), which must agree; no critical
 *     subpacket other than the creation time, and no signature-expiration
 *     subpacket (3);
 *   - the signed data: the commit object with that header and its
 *     continuation lines removed (git's own payload rule), followed by the
 *     v4 trailer (the hashed portion, then `0x04 0xFF` and its length as four
 *     big-endian bytes); the left 16 bits of the digest must match, then RSA
 *     PKCS#1 v1.5 over SHA-256 must verify (`node:crypto`).
 *
 * The pinned keys are one or more ASCII-armored `PGP PUBLIC KEY BLOCK`s
 * (`parsePinnedSigningKeys`) — the bytes an operator publishes, e.g.
 * GitHub's `web-flow.gpg`. Every PRIMARY key packet (tag 6) must be v4 RSA;
 * its fingerprint is computed here (SHA-1 over `0x99 ‖ length ‖ body`, RFC
 * 4880 §12.2), never taken from a label. User ID (13), signature (2), trust
 * (12) and subkey (14) packets are allowed and skipped: subkeys are never
 * candidates, and self-signatures are not checked, because the file itself
 * is the pin. Any other packet, a v3 or v5 key, or a non-RSA primary key is
 * refused.
 *
 * Nothing here is new cryptography: hashing and RSA verification are
 * `node:crypto`'s. This is byte layout (RFC 4880 §4–5, §6, §12.2).
 * Apache-2.0. Node built-ins only.
 */
import { createHash, createPublicKey, verify as cryptoVerify, constants } from "node:crypto";
import type { KeyObject } from "node:crypto";

/** One pinned signing key: a v4 RSA primary key. */
export interface PinnedSigningKey {
  /** Lowercase hex, 40 digits (v4 fingerprint). */
  readonly fingerprint: string;
  /** Lowercase hex, 16 digits (the fingerprint's low 64 bits). */
  readonly keyId: string;
  /** Key creation time, seconds since the epoch. */
  readonly createdAt: number;
  readonly key: KeyObject;
  /** Modulus length in bytes. */
  readonly modulusBytes: number;
}

/** A signature that was refused, with the reason. */
export type CommitSignatureCheck =
  | {
      readonly ok: true;
      readonly fingerprint: string;
      /** The signature creation time, seconds since the epoch (hashed subpacket 2). */
      readonly createdAt: number;
    }
  | { readonly ok: false; readonly reason: string };

class PgpError extends Error {}

// ---------------------------------------------------------------------------
// Armor (RFC 4880 §6)
// ---------------------------------------------------------------------------

/** CRC-24 (RFC 4880 §6.1). */
export function crc24(bytes: Uint8Array): number {
  let crc = 0xb704ce;
  for (const b of bytes) {
    crc ^= b << 16;
    for (let i = 0; i < 8; i++) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= 0x1864cfb;
    }
  }
  return crc & 0xffffff;
}

const B64_LINE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Strict base64: the canonical encoding of what it decodes to. */
function strictBase64(s: string, what: string): Buffer {
  const b = Buffer.from(s, "base64");
  if (b.toString("base64") !== s) throw new PgpError(`${what} is not canonical base64`);
  return b;
}

/**
 * Decode ONE armored block of `label` that is exactly `lines` (no text before
 * or after): the BEGIN line, optional `Key: value` armor headers, a blank
 * line, base64 lines, `=` + the CRC-24, the END line.
 */
function dearmorLines(lines: readonly string[], label: string): Buffer {
  if (lines[0] !== `-----BEGIN ${label}-----`) throw new PgpError(`not a ${label}`);
  if (lines[lines.length - 1] !== `-----END ${label}-----`) {
    throw new PgpError(`the ${label} is not terminated`);
  }
  let i = 1;
  while (i < lines.length - 1 && lines[i] !== "") {
    if (!/^[A-Za-z][A-Za-z0-9-]*: [^\r]*$/.test(lines[i]!)) {
      throw new PgpError(`the ${label} has a malformed armor header`);
    }
    i++;
  }
  if (lines[i] !== "") throw new PgpError(`the ${label} has no blank line before its body`);
  i++;
  const body: string[] = [];
  for (; i < lines.length - 2; i++) {
    const l = lines[i]!;
    if (l.length === 0 || l.length > 76 || !B64_LINE.test(l)) {
      throw new PgpError(`the ${label} body is not base64 lines`);
    }
    body.push(l);
  }
  const crcLine = lines[lines.length - 2] ?? "";
  if (!/^=[A-Za-z0-9+/]{4}$/.test(crcLine) || body.length === 0) {
    throw new PgpError(`the ${label} has no CRC-24 line`);
  }
  // Padding only on the last body line.
  for (const l of body.slice(0, -1)) {
    if (l.includes("=") || l.length % 4 !== 0) {
      throw new PgpError(`the ${label} body is not base64 lines`);
    }
  }
  const data = strictBase64(body.join(""), `the ${label} body`);
  const crc = strictBase64(crcLine.slice(1), `the ${label} CRC-24`);
  if (crc.length !== 3 || crc.readUIntBE(0, 3) !== crc24(data)) {
    throw new PgpError(`the ${label} CRC-24 does not match`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Packets (RFC 4880 §4.2)
// ---------------------------------------------------------------------------

interface Packet {
  readonly tag: number;
  readonly body: Buffer;
}

/** Split `data` into packets with definite lengths; anything else throws. */
function packets(data: Buffer): Packet[] {
  const out: Packet[] = [];
  let i = 0;
  while (i < data.length) {
    const h = data[i]!;
    if ((h & 0x80) === 0) throw new PgpError("a packet header lacks its high bit");
    let tag: number;
    let len: number;
    let at: number;
    if (h & 0x40) {
      tag = h & 0x3f;
      const o1 = data[i + 1];
      if (o1 === undefined) throw new PgpError("a packet length is cut short");
      if (o1 < 192) {
        len = o1;
        at = i + 2;
      } else if (o1 < 224) {
        const o2 = data[i + 2];
        if (o2 === undefined) throw new PgpError("a packet length is cut short");
        len = ((o1 - 192) << 8) + o2 + 192;
        at = i + 3;
      } else if (o1 === 255) {
        if (i + 6 > data.length) throw new PgpError("a packet length is cut short");
        len = data.readUInt32BE(i + 2);
        at = i + 6;
      } else {
        throw new PgpError("a partial-length packet");
      }
    } else {
      tag = (h >> 2) & 0x0f;
      const lt = h & 0x03;
      if (lt === 3) throw new PgpError("an indeterminate-length packet");
      const n = 1 << lt;
      if (i + 1 + n > data.length) throw new PgpError("a packet length is cut short");
      len = data.readUIntBE(i + 1, n);
      at = i + 1 + n;
    }
    if (at + len > data.length) throw new PgpError("a packet runs past the end of its block");
    out.push({ tag, body: data.subarray(at, at + len) });
    i = at + len;
  }
  return out;
}

/**
 * An MPI (RFC 4880 §3.2) at `at`: its value bytes and the next offset. A key's
 * MPIs must have an exact bit count (minimal, no leading zero). A signature's
 * may declare the modulus's full width with leading zero bits: GitHub writes
 * every RSA signature as 4096 bits, and git and gpg accept it. Its value is
 * left-padded to the modulus length before RSA verification either way.
 */
function mpi(
  body: Buffer,
  at: number,
  what: string,
  exact = true,
): { value: Buffer; next: number } {
  if (at + 2 > body.length) throw new PgpError(`${what} is cut short`);
  const bits = body.readUInt16BE(at);
  const n = (bits + 7) >> 3;
  if (bits === 0 || at + 2 + n > body.length) throw new PgpError(`${what} is malformed`);
  const value = body.subarray(at + 2, at + 2 + n);
  // Exact: the top byte's highest set bit is bit (bits-1) mod 8.
  const top = value[0]!;
  if (exact && (top === 0 || 32 - Math.clz32(top) !== ((bits - 1) % 8) + 1)) {
    throw new PgpError(`${what}'s bit count is not exact`);
  }
  return { value, next: at + 2 + n };
}

// ---------------------------------------------------------------------------
// Pinned keys
// ---------------------------------------------------------------------------

const PUBKEY_LABEL = "PGP PUBLIC KEY BLOCK";
const ALLOWED_KEYRING_TAGS = new Set([2, 6, 12, 13, 14]);

/** One v4 key packet body: its fingerprint and, for RSA, its key. */
function parseKeyPacket(body: Buffer): PinnedSigningKey {
  if (body[0] !== 4) throw new PgpError(`a key packet of version ${String(body[0])}, not 4`);
  if (body.length < 6) throw new PgpError("a key packet is cut short");
  const createdAt = body.readUInt32BE(1);
  if (body[5] !== 1)
    throw new PgpError(`a primary key of algorithm ${String(body[5])}, not RSA (1)`);
  const n = mpi(body, 6, "the RSA modulus");
  const e = mpi(body, n.next, "the RSA exponent");
  if (e.next !== body.length) throw new PgpError("a key packet has trailing bytes");
  const fp = createHash("sha1")
    .update(Buffer.from([0x99, body.length >> 8, body.length & 0xff]))
    .update(body)
    .digest("hex");
  const key = createPublicKey({
    key: { kty: "RSA", n: n.value.toString("base64url"), e: e.value.toString("base64url") },
    format: "jwk",
  });
  return { fingerprint: fp, keyId: fp.slice(-16), createdAt, key, modulusBytes: n.value.length };
}

/**
 * The pinned signing keys: one or more ASCII-armored `PGP PUBLIC KEY BLOCK`s,
 * with nothing but newlines between and around them. Every primary key is a
 * candidate; throws on anything unexpected (see the module comment).
 */
export function parsePinnedSigningKeys(text: string): PinnedSigningKey[] {
  try {
    const lines = text.replace(/\n+$/, "").replace(/^\n+/, "").split("\n");
    const keys: PinnedSigningKey[] = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i] === "") {
        i++;
        continue;
      }
      const end = lines.indexOf(`-----END ${PUBKEY_LABEL}-----`, i);
      if (end < 0) throw new PgpError(`not a ${PUBKEY_LABEL}`);
      const data = dearmorLines(lines.slice(i, end + 1), PUBKEY_LABEL);
      const ps = packets(data);
      if (ps.length === 0 || ps[0]!.tag !== 6) {
        throw new PgpError("a key block does not start with a primary key");
      }
      for (const p of ps) {
        if (!ALLOWED_KEYRING_TAGS.has(p.tag)) {
          throw new PgpError(`a key block holds a packet of tag ${p.tag}`);
        }
        if (p.tag === 6) keys.push(parseKeyPacket(p.body));
      }
      i = end + 1;
    }
    if (keys.length === 0) throw new PgpError("no key");
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k.fingerprint)) throw new PgpError(`the key ${k.fingerprint} is pinned twice`);
      seen.add(k.fingerprint);
    }
    return keys;
  } catch (err) {
    if (err instanceof PgpError) {
      throw new Error(`the pinned signing keys do not parse: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The commit's signature
// ---------------------------------------------------------------------------

/** The signature header and the payload with it removed (git's rule), or a reason. */
export function splitSignedCommit(
  raw: Buffer,
  objectFormat: "sha1" | "sha256",
): { payload: Buffer; signature: string } | { reason: string } {
  const header = objectFormat === "sha1" ? "gpgsig" : "gpgsig-sha256";
  const text = raw.toString("latin1");
  const end = text.indexOf("\n\n");
  if (end < 0) return { reason: "the commit has no message separator" };
  const lines = text.slice(0, end).split("\n");
  const kept: string[] = [];
  let sig: string[] | null = null;
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith(`${header} `)) {
      count++;
      const s = [l.slice(header.length + 1)];
      while (i + 1 < lines.length && lines[i + 1]!.startsWith(" ")) s.push(lines[++i]!.slice(1));
      // GitHub ends the header with one empty continuation line (` `) after the
      // END line; it is the armor's trailing newline, not part of the block.
      if (s.length > 1 && s[s.length - 1] === "") s.pop();
      sig = s;
      continue;
    }
    if (/^(?:gpgsig|gpgsig-sha256|mergetag|encoding) /.test(l)) {
      return { reason: `the commit carries a ${l.split(" ")[0]} header` };
    }
    kept.push(l);
  }
  if (count === 0 || sig === null) return { reason: `the commit has no ${header} signature` };
  if (count > 1) return { reason: `the commit has more than one ${header} signature` };
  return {
    payload: Buffer.from(`${kept.join("\n")}${text.slice(end)}`, "latin1"),
    signature: `${sig.join("\n")}\n`,
  };
}

interface ParsedSignature {
  readonly hashedPortion: Buffer;
  readonly left16: Buffer;
  readonly sig: Buffer;
  readonly createdAt: number;
  readonly fingerprint: string | null;
  readonly keyId: string | null;
}

function subpackets(
  area: Buffer,
  hashed: boolean,
  acc: {
    createdAt: number | null;
    fingerprint: string | null;
    keyId: string | null;
  },
): void {
  let i = 0;
  while (i < area.length) {
    const o1 = area[i]!;
    let len: number;
    let at: number;
    if (o1 < 192) {
      len = o1;
      at = i + 1;
    } else if (o1 < 255) {
      if (i + 2 > area.length) throw new PgpError("a subpacket length is cut short");
      len = ((o1 - 192) << 8) + area[i + 1]! + 192;
      at = i + 2;
    } else {
      if (i + 5 > area.length) throw new PgpError("a subpacket length is cut short");
      len = area.readUInt32BE(i + 1);
      at = i + 5;
    }
    if (len < 1 || at + len > area.length) throw new PgpError("a subpacket runs past its area");
    const t = area[at]!;
    const critical = (t & 0x80) !== 0;
    const type = t & 0x7f;
    const data = area.subarray(at + 1, at + len);
    i = at + len;
    if (type === 2) {
      if (!hashed) throw new PgpError("a creation time outside the hashed area");
      if (acc.createdAt !== null) throw new PgpError("more than one creation time");
      if (data.length !== 4) throw new PgpError("a malformed creation time");
      acc.createdAt = data.readUInt32BE(0);
    } else if (type === 3) {
      throw new PgpError("a signature-expiration subpacket");
    } else if (type === 16) {
      if (data.length !== 8) throw new PgpError("a malformed issuer key id");
      const id = data.toString("hex");
      if (acc.keyId !== null && acc.keyId !== id)
        throw new PgpError("two different issuer key ids");
      acc.keyId = id;
    } else if (type === 33) {
      if (data.length !== 21 || data[0] !== 4) throw new PgpError("a malformed issuer fingerprint");
      const fp = data.subarray(1).toString("hex");
      if (acc.fingerprint !== null && acc.fingerprint !== fp) {
        throw new PgpError("two different issuer fingerprints");
      }
      acc.fingerprint = fp;
    } else if (critical) {
      throw new PgpError(`a critical subpacket of type ${type}`);
    }
  }
}

const SIG_LABEL = "PGP SIGNATURE";

/** Parse the armored signature: one v4 binary RSA/SHA-256 signature packet, nothing else. */
function parseSignature(armored: string): ParsedSignature {
  if (!armored.endsWith("\n")) throw new PgpError("the signature is not newline-terminated");
  const data = dearmorLines(armored.slice(0, -1).split("\n"), SIG_LABEL);
  const ps = packets(data);
  if (ps.length !== 1) throw new PgpError(`the signature holds ${ps.length} packets, not one`);
  const p = ps[0]!;
  if (p.tag !== 2) throw new PgpError(`the packet is of tag ${p.tag}, not a signature (2)`);
  const b = p.body;
  if (b[0] !== 4) throw new PgpError(`a version ${String(b[0])} signature, not 4`);
  if (b.length < 6) throw new PgpError("the signature is cut short");
  if (b[1] !== 0x00)
    throw new PgpError(`signature type 0x${b[1]!.toString(16)}, not binary (0x00)`);
  if (b[2] !== 1) throw new PgpError(`public-key algorithm ${b[2]!}, not RSA (1)`);
  if (b[3] !== 8) throw new PgpError(`hash algorithm ${b[3]!}, not SHA-256 (8)`);
  const hashedLen = b.readUInt16BE(4);
  const hashedEnd = 6 + hashedLen;
  if (hashedEnd + 2 > b.length) throw new PgpError("the hashed area runs past the packet");
  const unhashedLen = b.readUInt16BE(hashedEnd);
  const unhashedEnd = hashedEnd + 2 + unhashedLen;
  if (unhashedEnd + 2 > b.length) throw new PgpError("the unhashed area runs past the packet");
  const acc = {
    createdAt: null as number | null,
    fingerprint: null as string | null,
    keyId: null as string | null,
  };
  subpackets(b.subarray(6, hashedEnd), true, acc);
  subpackets(b.subarray(hashedEnd + 2, unhashedEnd), false, acc);
  if (acc.createdAt === null) throw new PgpError("no signature creation time");
  if (acc.fingerprint === null && acc.keyId === null) throw new PgpError("no issuer");
  if (acc.fingerprint !== null && acc.keyId !== null && !acc.fingerprint.endsWith(acc.keyId)) {
    throw new PgpError("the issuer key id is not the issuer fingerprint's");
  }
  const left16 = b.subarray(unhashedEnd, unhashedEnd + 2);
  const s = mpi(b, unhashedEnd + 2, "the RSA signature", false);
  if (s.next !== b.length) throw new PgpError("the signature packet has trailing bytes");
  return {
    hashedPortion: b.subarray(0, hashedEnd),
    left16,
    sig: s.value,
    createdAt: acc.createdAt,
    fingerprint: acc.fingerprint,
    keyId: acc.keyId,
  };
}

/**
 * Check a commit object's OpenPGP signature against the pinned keys. Never
 * throws for what the commit holds: every refusal is a reason.
 */
export function verifyCommitSignature(
  raw: Buffer,
  objectFormat: "sha1" | "sha256",
  pinned: readonly PinnedSigningKey[],
): CommitSignatureCheck {
  const split = splitSignedCommit(raw, objectFormat);
  if ("reason" in split) return { ok: false, reason: split.reason };
  let sig: ParsedSignature;
  try {
    sig = parseSignature(split.signature);
  } catch (err) {
    if (err instanceof PgpError) return { ok: false, reason: `the signature: ${err.message}` };
    throw err;
  }
  const key = pinned.find((k) =>
    sig.fingerprint !== null ? k.fingerprint === sig.fingerprint : k.keyId === sig.keyId,
  );
  if (key === undefined) {
    return {
      ok: false,
      reason: `the signer ${sig.fingerprint ?? sig.keyId ?? "?"} is not a pinned key`,
    };
  }
  if (sig.keyId !== null && key.keyId !== sig.keyId) {
    return { ok: false, reason: "the issuer key id is not the pinned key's" };
  }
  if (sig.createdAt < key.createdAt) {
    return { ok: false, reason: "the signature was made before its key was created" };
  }
  const trailer = Buffer.alloc(6);
  trailer[0] = 0x04;
  trailer[1] = 0xff;
  trailer.writeUInt32BE(sig.hashedPortion.length, 2);
  const signed = Buffer.concat([split.payload, sig.hashedPortion, trailer]);
  const digest = createHash("sha256").update(signed).digest();
  if (!digest.subarray(0, 2).equals(sig.left16)) {
    return { ok: false, reason: "the signature's left 16 bits do not match the digest" };
  }
  if (sig.sig.length > key.modulusBytes) {
    return { ok: false, reason: "the signature is longer than the key's modulus" };
  }
  const padded = Buffer.concat([Buffer.alloc(key.modulusBytes - sig.sig.length), sig.sig]);
  const ok = cryptoVerify(
    "sha256",
    signed,
    { key: key.key, padding: constants.RSA_PKCS1_PADDING },
    padded,
  );
  if (!ok) return { ok: false, reason: "the RSA signature does not verify under the pinned key" };
  return { ok: true, fingerprint: key.fingerprint, createdAt: sig.createdAt };
}
