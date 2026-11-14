/**
 * FIXTURE — an anonymous default-exported function that signs the
 * transaction it is handed. Not a violation by itself (its parameter is not
 * decoded here); `plantedDefaultExportSigner` in planted-widened.ts hands it
 * a decoded transaction through a default import.
 */
import type { Keypair, VersionedTransaction } from "@solana/web3.js";

export default function (tx: VersionedTransaction, keypair: Keypair): VersionedTransaction {
  tx.sign([keypair]);
  return tx;
}
