/**
 * FIXTURE — network-touching code that must NOT be flagged, plus ONE shape
 * that is dangerous but that the gate CANNOT see (the documented blind spot).
 *
 * The carve-out is explicit: a transaction the code builds itself is out of
 * the gate's reach, whatever fed its fields.
 */
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Keypair,
} from "@solana/web3.js";
import nacl from "tweetnacl";

/** A destination read from a network response; the transaction is built and signed locally. */
export async function cleanNetworkAddressLocalBuild(
  url: string,
  keypair: Keypair,
): Promise<Buffer> {
  const { to } = (await (await fetch(url)).json()) as { to: string };
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: new PublicKey(to),
      lamports: 1,
    }),
  );
  tx.sign(keypair);
  return tx.serialize();
}

/** Network bytes decoded and only VERIFIED, never signed. */
export async function cleanVerifyNetworkSignature(
  res: Response,
  publicKey: Uint8Array,
): Promise<boolean> {
  const { message, signature } = (await res.json()) as { message: string; signature: string };
  return nacl.sign.detached.verify(
    Buffer.from(message, "base64"),
    Buffer.from(signature, "base64"),
    publicKey,
  );
}

/** Base64 of a LOCAL constant, signed — not a network value. */
const LOCAL_CHALLENGE = "bW90ZWJpdA==";
export function cleanLocalBase64Sign(sk: Uint8Array): Uint8Array {
  return nacl.sign.detached(Buffer.from(LOCAL_CHALLENGE, "base64"), sk);
}

/**
 * BLIND SPOT — NOT CAUGHT, by design of what the gate can see. Third-party
 * instructions (Jupiter `/swap-instructions` JSON) assembled into a
 * transaction this code builds and signs. To the gate this is a local build.
 * The self-test asserts it passes AND that the printed blind spots name it,
 * so the gap stays disclosed rather than silently assumed covered.
 */
export async function blindSpotThirdPartyInstructions(
  url: string,
  keypair: Keypair,
): Promise<Buffer> {
  const { programId, keys, data } = (await (await fetch(url)).json()) as {
    programId: string;
    keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
    data: string;
  };
  const ix = new TransactionInstruction({
    programId: new PublicKey(programId),
    keys: keys.map((k) => ({ ...k, pubkey: new PublicKey(k.pubkey) })),
    data: Buffer.from(data, "base64"),
  });
  const tx = new Transaction().add(ix);
  tx.sign(keypair);
  return tx.serialize();
}
