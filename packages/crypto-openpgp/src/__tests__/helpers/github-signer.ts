/**
 * A stand-in for GitHub's commit signer, for tests only: an ephemeral RSA key
 * from `node:crypto`, its OpenPGP v4 public key block (what a pinned-keys
 * file holds), and v4 signature packets built byte by byte (RFC 4880 §4–5,
 * §6), armored and inserted as a commit's `gpgsig` header the way git writes
 * it. Every knob breaks one rule the offline verifier checks. No network,
 * no real GitHub key.
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { crc24 } from "../../openpgp.js";

export interface TestSigningKey {
  readonly privateKey: KeyObject;
  readonly fingerprint: string;
  readonly keyId: string;
  /** The armored public key block (a pinned-keys file). */
  readonly armored: string;
  /** The v4 key packet body. */
  readonly keyBody: Buffer;
}

/** An MPI of a big-endian unsigned integer (leading zeros stripped). */
export function mpi(value: Buffer): Buffer {
  let i = 0;
  while (i < value.length - 1 && value[i] === 0) i++;
  const v = value.subarray(i);
  const bits = (v.length - 1) * 8 + (32 - Math.clz32(v[0]!));
  const head = Buffer.alloc(2);
  head.writeUInt16BE(bits);
  return Buffer.concat([head, v]);
}

/** A new-format packet (RFC 4880 §4.2.2). */
export function packet(tag: number, body: Buffer): Buffer {
  let len: Buffer;
  if (body.length < 192) len = Buffer.from([body.length]);
  else if (body.length < 8384) {
    const n = body.length - 192;
    len = Buffer.from([(n >> 8) + 192, n & 0xff]);
  } else {
    len = Buffer.alloc(5);
    len[0] = 255;
    len.writeUInt32BE(body.length, 1);
  }
  return Buffer.concat([Buffer.from([0xc0 | tag]), len, body]);
}

/** ASCII armor with a CRC-24 (RFC 4880 §6.2). */
export function armor(label: string, data: Buffer, headers: readonly string[] = []): string {
  const b64 = data.toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  const crc = Buffer.alloc(3);
  crc.writeUIntBE(crc24(data), 0, 3);
  return [
    `-----BEGIN ${label}-----`,
    ...headers,
    "",
    ...lines,
    `=${crc.toString("base64")}`,
    `-----END ${label}-----`,
    "",
  ].join("\n");
}

const CREATED = 1_700_000_000;

/** A fresh RSA signing key and its OpenPGP v4 public key block. */
export function testSigningKey(bits = 2048): TestSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  const jwk = publicKey.export({ format: "jwk" });
  const n = Buffer.from(jwk.n!, "base64url");
  const e = Buffer.from(jwk.e!, "base64url");
  const created = Buffer.alloc(4);
  created.writeUInt32BE(CREATED);
  const keyBody = Buffer.concat([Buffer.from([4]), created, Buffer.from([1]), mpi(n), mpi(e)]);
  const fingerprint = createHash("sha1")
    .update(Buffer.from([0x99, keyBody.length >> 8, keyBody.length & 0xff]))
    .update(keyBody)
    .digest("hex");
  const uid = packet(13, Buffer.from("GitHub (web-flow commit signing) <noreply@github.com>"));
  const armored = armor("PGP PUBLIC KEY BLOCK", Buffer.concat([packet(6, keyBody), uid]));
  return { privateKey, fingerprint, keyId: fingerprint.slice(-16), armored, keyBody };
}

/** An MPI declaring all of `value`'s bytes as bits, leading zero bits kept (GitHub's form). */
export function fullWidthMpi(value: Buffer): Buffer {
  const head = Buffer.alloc(2);
  head.writeUInt16BE(value.length * 8);
  return Buffer.concat([head, value]);
}

/** One subpacket: `[len][type][data]`. */
export function subpacket(type: number, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([data.length + 1, type]), data]);
}

export interface SignOptions {
  version?: number;
  sigType?: number;
  pkAlgo?: number;
  hashAlgo?: number;
  /** The creation time in seconds; `null` omits it. */
  created?: number | null;
  /** Hashed subpackets after the creation time and issuer fingerprint. */
  extraHashed?: Buffer[];
  /** Unhashed subpackets; default the issuer key id. */
  unhashed?: Buffer[];
  /** Omit the issuer fingerprint from the hashed area. */
  noFingerprint?: boolean;
  /** Rewrite the finished packet body before it is armored. */
  body?: (b: Buffer) => Buffer;
  /** Rewrite the armored text. */
  armored?: (a: string) => string;
  /** Bytes after the signature packet, inside the armor. */
  trailing?: Buffer;
  /** Write the signature MPI minimally (default: at the modulus's full width, as GitHub does). */
  minimalMpi?: boolean;
}

/** An armored v4 binary signature over `payload` by `key`. */
export function signPayload(
  payload: Buffer,
  key: TestSigningKey,
  created: number,
  o: SignOptions = {},
): string {
  const time = Buffer.alloc(4);
  const at = o.created === undefined ? created : o.created;
  const hashedSubs: Buffer[] = [];
  if (at !== null) {
    time.writeUInt32BE(at);
    hashedSubs.push(subpacket(2, time));
  }
  if (!o.noFingerprint) {
    hashedSubs.push(
      subpacket(33, Buffer.concat([Buffer.from([4]), Buffer.from(key.fingerprint, "hex")])),
    );
  }
  hashedSubs.push(...(o.extraHashed ?? []));
  const hashedArea = Buffer.concat(hashedSubs);
  const head = Buffer.from([
    o.version ?? 4,
    o.sigType ?? 0x00,
    o.pkAlgo ?? 1,
    o.hashAlgo ?? 8,
    hashedArea.length >> 8,
    hashedArea.length & 0xff,
  ]);
  const hashedPortion = Buffer.concat([head, hashedArea]);
  const trailer = Buffer.alloc(6);
  trailer[0] = 0x04;
  trailer[1] = 0xff;
  trailer.writeUInt32BE(hashedPortion.length, 2);
  const signed = Buffer.concat([payload, hashedPortion, trailer]);
  const digest = createHash("sha256").update(signed).digest();
  const sig = sign("sha256", signed, key.privateKey);
  const unhashedArea = Buffer.concat(o.unhashed ?? [subpacket(16, Buffer.from(key.keyId, "hex"))]);
  const unhashedLen = Buffer.from([unhashedArea.length >> 8, unhashedArea.length & 0xff]);
  let body = Buffer.concat([
    hashedPortion,
    unhashedLen,
    unhashedArea,
    digest.subarray(0, 2),
    o.minimalMpi ? mpi(sig) : fullWidthMpi(sig),
  ]);
  if (o.body) body = o.body(body);
  const data = Buffer.concat([packet(2, body), o.trailing ?? Buffer.alloc(0)]);
  const armored = armor("PGP SIGNATURE", data);
  return o.armored ? o.armored(armored) : armored;
}

/**
 * Insert `armored` as the commit's `gpgsig` header (at the end of the header,
 * as git does). By default the header ends with one empty continuation line
 * (` `) after the END line, as GitHub writes it.
 */
export function withSignature(
  payload: Buffer,
  armored: string,
  header = "gpgsig",
  githubTail = true,
): Buffer {
  const text = payload.toString("latin1");
  const end = text.indexOf("\n\n");
  const lines = armored.replace(/\n$/, "").split("\n");
  if (githubTail) lines.push("");
  const value = [`${header} ${lines[0]!}`, ...lines.slice(1).map((l) => ` ${l}`)].join("\n");
  return Buffer.from(`${text.slice(0, end)}\n${value}${text.slice(end)}`, "latin1");
}

/** A commit object's bytes (unsigned). */
export function commitPayload(c: {
  tree: string;
  parents: readonly string[];
  committer?: string;
  seconds: number;
  message?: string;
}): Buffer {
  return Buffer.from(
    [
      `tree ${c.tree}`,
      ...c.parents.map((p) => `parent ${p}`),
      `author motebit-agent <agent@example.com> ${c.seconds} +0000`,
      `committer ${c.committer ?? "GitHub <noreply@github.com>"} ${c.seconds} +0000`,
      "",
      c.message ?? "Fix the typo (#1)\n",
    ].join("\n"),
    "latin1",
  );
}
