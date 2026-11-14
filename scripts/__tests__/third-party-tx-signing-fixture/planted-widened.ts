/**
 * FIXTURE — the shapes a cold review planted past the first version of the
 * gate. Scanned only via `check-third-party-tx-signing --fixture`. Every
 * function named `planted*` must be flagged.
 */
import { VersionedTransaction, type Connection, type Keypair } from "@solana/web3.js";
import * as web3 from "@solana/web3.js";
import { modifyAndSignTransactions, signAndSendTransactions } from "@solana/kit";
import nacl from "tweetnacl";
import signDefault from "./default-signer";

declare const require: (m: string) => typeof web3;
declare const sodium: {
  crypto_sign_detached(m: Uint8Array, sk: Uint8Array): Uint8Array;
};
declare const base64: { decode(s: string): Uint8Array };

/** A plain `const` alias of the decode class. */
export function plantedConstAlias(bytes: Uint8Array, keypair: Keypair): void {
  const Decoder = VersionedTransaction;
  const tx = Decoder.deserialize(bytes);
  tx.sign([keypair]);
}

/** A member alias off a `require`d module. */
export function plantedRequireAlias(buf: Buffer, keypair: Keypair): void {
  const T = require("@solana/web3.js").Transaction;
  const tx = T.from(buf);
  tx.partialSign(keypair);
}

/** A member alias off a namespace import. */
export function plantedMemberAlias(buf: Buffer, keypair: Keypair): void {
  const T = web3.Transaction;
  T.from(buf).sign(keypair);
}

/** A local helper whose DESTRUCTURED parameter is signed. */
function signFromBag({ tx, keypair }: { tx: VersionedTransaction; keypair: Keypair }): void {
  tx.sign([keypair]);
}
export function plantedPatternParam(bytes: Uint8Array, keypair: Keypair): void {
  signFromBag({ tx: VersionedTransaction.deserialize(bytes), keypair });
}

/** Handed, through a default import, to an anonymous default-exported signer. */
export function plantedDefaultExportSigner(bytes: Uint8Array, keypair: Keypair): void {
  signDefault(VersionedTransaction.deserialize(bytes), keypair);
}

/** Kit multi-transaction signers. */
export async function plantedKitModifyAndSign(bytes: Uint8Array): Promise<void> {
  await modifyAndSignTransactions([VersionedTransaction.deserialize(bytes) as never]);
}
export async function plantedKitSignAndSendMany(bytes: Uint8Array): Promise<void> {
  await signAndSendTransactions([VersionedTransaction.deserialize(bytes) as never]);
}

/** libsodium detached signature over a decoded message. */
export function plantedSodium(bytes: Uint8Array, sk: Uint8Array): Uint8Array {
  const tx = VersionedTransaction.deserialize(bytes);
  return sodium.crypto_sign_detached(tx.message.serialize(), sk);
}

/** Raw bytes from a fetch response field, base64-decoded, signed raw. */
export async function plantedRawNetworkBytes(url: string, sk: Uint8Array): Promise<Uint8Array> {
  const res = await fetch(url);
  const { message } = (await res.json()) as { message: string };
  const bytes = Buffer.from(message, "base64");
  return nacl.sign.detached(bytes, sk);
}

/** A foreign, already-built transaction broadcast as-is. */
export async function plantedRawBroadcast(url: string, connection: Connection): Promise<string> {
  const body = (await (await fetch(url)).json()) as { tx: string };
  return connection.sendRawTransaction(Buffer.from(body.tx, "base64"));
}

/** `base64.decode` of a network value, signed by a byte signer. */
export async function plantedBase64Decode(
  res: Response,
  signBytes: (b: Uint8Array) => Uint8Array,
): Promise<Uint8Array> {
  const json = (await res.json()) as { payload: string };
  return signBytes(base64.decode(json.payload));
}

/** A binary response body signed raw. */
export async function plantedBinaryBody(url: string, sk: Uint8Array): Promise<Uint8Array> {
  const body = new Uint8Array(await (await fetch(url)).arrayBuffer());
  return nacl.sign.detached(body, sk);
}
