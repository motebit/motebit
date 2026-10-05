/**
 * The `runMolecule` a probed service entry receives (see ./child.mjs). It does
 * what the real runner does up to the listing — hands the service's builder an
 * identity (a fresh Ed25519 keypair; no disk) and, for a money molecule, a
 * spend handle that refuses every use — then calls the `getServiceListing` the
 * builder returned, exactly as the runner would publish it, and records it.
 * No database, no server, no network.
 */
import { generateKeyPairSync } from "node:crypto";

export const calls = [];

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const priv = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  return {
    motebitId: "listing-probe",
    deviceId: "listing-probe",
    publicKeyHex: pub.toString("hex"),
    publicKey: new Uint8Array(pub),
    privateKey: new Uint8Array(priv),
    identityContent: "",
    identityPath: "",
    isFirstLaunch: true,
  };
}

const inertSpend = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === "then") return undefined;
      throw new Error(`listing probe: spend.${String(prop)} used while building the molecule`);
    },
  },
);

let exitTimer = null;

export async function runMolecule(config, build) {
  const rec = { serviceName: config?.serviceName ?? null };
  calls.push(rec);
  try {
    const molecule = await build(
      identity(),
      config?.moneyExecution != null ? inertSpend : undefined,
    );
    rec.hasGetServiceListing = typeof molecule?.getServiceListing === "function";
    if (rec.hasGetServiceListing) {
      const listing = await molecule.getServiceListing();
      rec.listing = listing === undefined ? null : JSON.parse(JSON.stringify(listing));
    }
  } catch (err) {
    rec.error = err != null && typeof err.message === "string" ? err.message : String(err);
  }
  // Let main() finish (and any second runMolecule call land), then stop.
  if (exitTimer != null) clearTimeout(exitTimer);
  exitTimer = setTimeout(() => process.exit(0), 300);
  return { shutdown: async () => {}, stop: async () => {} };
}
