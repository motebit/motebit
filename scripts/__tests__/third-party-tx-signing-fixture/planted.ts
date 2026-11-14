/**
 * FIXTURE — planted code that signs a transaction someone else built.
 *
 * Scanned only via `check-third-party-tx-signing --fixture`; the real scan
 * skips `__tests__/`. Every function named `planted*` must be flagged.
 */
import * as web3 from "@solana/web3.js";
import {
  Transaction,
  VersionedMessage,
  VersionedTransaction as VT,
  type Connection,
  type Keypair,
} from "@solana/web3.js";
import { getTransactionDecoder, signTransaction as kitSign } from "@solana/kit";
import nacl from "tweetnacl";

declare const wallet: { signTransaction(tx: unknown): Promise<unknown> };

/** The exact Jupiter shape this gate was born from. */
export async function plantedJupiterShape(res: Response, keypair: Keypair): Promise<void> {
  const { swapTransaction } = (await res.json()) as { swapTransaction: string };
  const txBuffer = Buffer.from(swapTransaction, "base64");
  const tx = VT.deserialize(txBuffer);
  tx.sign([keypair]);
}

/** Legacy transaction decoded and partially signed in one chain. */
export function plantedLegacyChain(buf: Buffer, keypair: Keypair): Buffer {
  const tx = Transaction.from(buf);
  tx.partialSign(keypair);
  return tx.serialize();
}

/** Through a namespace import. */
export function plantedNamespace(bytes: Uint8Array, keypair: Keypair): void {
  const t = web3.VersionedTransaction.deserialize(bytes);
  t.sign([keypair]);
}

/** A decoded message's bytes signed by a raw signer. */
export function plantedMessageBytes(bytes: Uint8Array, secretKey: Uint8Array): Uint8Array {
  const m = VersionedMessage.deserialize(bytes);
  return nacl.sign.detached(m.serialize(), secretKey);
}

/** A helper decodes; the caller signs what it returns. */
function decodeSwap(bytes: Uint8Array): VT {
  return VT.deserialize(bytes);
}
export function plantedViaHelper(bytes: Uint8Array, keypair: Keypair): void {
  const tx = decodeSwap(bytes);
  tx.sign([keypair]);
}

/** A decoded transaction handed to a local function that signs its parameter. */
function signAndSend(tx: VT, keypair: Keypair): VT {
  tx.sign([keypair]);
  return tx;
}
export function plantedHandOff(bytes: Uint8Array, keypair: Keypair): void {
  const tx = VT.deserialize(bytes);
  signAndSend(tx, keypair);
}

/** Handed straight to a wallet adapter's signer. */
export async function plantedWalletAdapter(bytes: Uint8Array): Promise<void> {
  await wallet.signTransaction(VT.deserialize(bytes));
}

/** `@solana/kit`: decoder output handed to a (renamed) kit signer. */
export async function plantedKit(bytes: Uint8Array, keypair: CryptoKeyPair): Promise<void> {
  const decoded = getTransactionDecoder().decode(bytes);
  await kitSign([keypair], decoded as never);
}

/** Taint through a callback on a decoded collection. */
export function plantedCallback(blobs: Uint8Array[], keypair: Keypair): void {
  blobs.map((b) => VT.deserialize(b)).forEach((tx) => tx.sign([keypair]));
}

/** Taint through an object field. */
export function plantedObjectField(bytes: Uint8Array, keypair: Keypair): void {
  const r = { tx: VT.deserialize(bytes) };
  r.tx.sign([keypair]);
}

/** web3.js `sendTransaction` signs a legacy transaction with the signers it is given. */
export async function plantedSendTransaction(
  connection: Connection,
  buf: Buffer,
  keypair: Keypair,
): Promise<void> {
  await connection.sendTransaction(Transaction.from(buf), [keypair]);
}

/** A destructured alias of the decode class. */
export function plantedDestructuredAlias(bytes: Uint8Array, keypair: Keypair): void {
  const { VersionedTransaction: Decoder } = web3;
  const tx = Decoder.deserialize(bytes);
  tx.sign([keypair]);
}

/** Reassignment after a local build does not launder the decoded value. */
export function plantedReassigned(bytes: Uint8Array, keypair: Keypair): void {
  let tx = new Transaction();
  tx = Transaction.from(Buffer.from(bytes));
  tx.sign(keypair);
}
