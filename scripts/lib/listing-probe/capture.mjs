/**
 * The `runMolecule` a probed service entry receives (see ./child.mjs). It does
 * what the real runner does up to the listing — hands the service's builder an
 * identity (a fresh Ed25519 keypair and the sovereign motebit_id derived from
 * it, a random device id; no disk — so a builder cannot recognise the probe by
 * a fixed id) and, for a money molecule, a spend handle that refuses every use
 * — then calls the `getServiceListing` the builder returned as many times as
 * the real runner does before and while it serves (task admission, relay
 * registration, a `motebit_service_listing` tool call) and records every
 * result. No database, no server, no network.
 */
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";

export const calls = [];

/** Calls the real runner makes: resolveTaskAdmission, relay registration, the listing tool. */
export const LISTING_CALLS = 3;

/** `deriveSovereignMotebitId` (@motebit/crypto): UUIDv8 of sha256(genesis public key). */
function sovereignId(pub) {
  const b = createHash("sha256").update(pub).digest().subarray(0, 16);
  b[6] = 0x80 | (b[6] & 0x0f);
  b[8] = 0x80 | (b[8] & 0x3f);
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const priv = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  return {
    motebitId: sovereignId(pub),
    deviceId: randomUUID(),
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
    const id = identity();
    rec.identity = { motebitId: id.motebitId, deviceId: id.deviceId };
    const molecule = await build(id, config?.moneyExecution != null ? inertSpend : undefined);
    rec.hasGetServiceListing = typeof molecule?.getServiceListing === "function";
    if (rec.hasGetServiceListing) {
      rec.listings = [];
      for (let i = 0; i < LISTING_CALLS; i++) {
        const listing = await molecule.getServiceListing();
        rec.listings.push(listing === undefined ? null : JSON.parse(JSON.stringify(listing)));
      }
      rec.listing = rec.listings[0];
    }
  } catch (err) {
    rec.error = err != null && typeof err.message === "string" ? err.message : String(err);
  }
  // Let main() finish (and any second runMolecule call land), then stop.
  if (exitTimer != null) clearTimeout(exitTimer);
  exitTimer = setTimeout(() => process.exit(0), 300);
  return { shutdown: async () => {}, stop: async () => {} };
}
