/**
 * FIXTURE — code that must NOT be flagged.
 *
 * The wallet-solana shape: transactions built locally from the intent and
 * signed (legacy and v0), plus decode-only reads of foreign transactions
 * (inspect, verify, extract a signature) that never sign them. A variable
 * named `tx` that is decoded in one function does not taint a locally built
 * `tx` in another.
 */
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type Keypair,
} from "@solana/web3.js";

/** Local legacy transfer, signed — the wallet's own sendUsdc shape. */
export function cleanLocalLegacy(keypair: Keypair, to: PublicKey, blockhash: string): Buffer {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: to, lamports: 1 }),
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = keypair.publicKey;
  tx.sign(keypair);
  return tx.serialize();
}

/** Local v0 transaction compiled from a message the code built, signed. */
export function cleanLocalV0(keypair: Keypair, to: PublicKey, blockhash: string): Uint8Array {
  const message = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: to, lamports: 1 }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([keypair]);
  return tx.serialize();
}

/** A local helper that signs what it is handed — called only with local builds. */
async function signSendConfirm(
  connection: Connection,
  tx: Transaction,
  keypair: Keypair,
): Promise<string> {
  tx.sign(keypair);
  return connection.sendRawTransaction(tx.serialize());
}
export async function cleanHelperWithLocalBuild(
  connection: Connection,
  keypair: Keypair,
  to: PublicKey,
): Promise<string> {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: to, lamports: 1 }),
  );
  return signSendConfirm(connection, tx, keypair);
}

/** Decode-only: read the accounts of a foreign transaction. */
export function cleanInspect(bytes: Uint8Array): string[] {
  const tx = VersionedTransaction.deserialize(bytes);
  return tx.message.staticAccountKeys.map((k) => k.toBase58());
}

/** Decode-only: verify the signatures someone else made. */
export function cleanVerify(raw: Buffer): boolean {
  return Transaction.from(raw).verifySignatures();
}

/** Decode-only: extract the first signature. */
export function cleanExtractSignature(raw: Buffer): Buffer | null {
  return Transaction.from(raw).signature;
}

/** Not a signer at all. */
export function cleanMath(x: number): number {
  return Math.sign(x);
}
