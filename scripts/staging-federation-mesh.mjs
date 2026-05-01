#!/usr/bin/env node
/**
 * Staging federation K4 mesh-peer script.
 *
 * Runs six pair handshakes (n choose 2 with n=4) across the four staging
 * relays so each leader sees 3 active OTHER peers — the §6.2 + §6.5 floor
 * (`spec/dispute-v1.md`). Triangle (3 relays) fails this floor: each leader
 * would see only 2 others, and §6.5 forbids self-adjudication when
 * defendant. K4 is the minimum that satisfies the floor for a
 * single-operator fleet (see `dispute-v1.md` §6.6 operator note).
 *
 * Each pair handshake mirrors `apps/cli/src/subcommands/federation.ts`
 * `handleFederationPeer` — the existing `motebit federation peer <url>`
 * primitive — using `/peer/propose` self-mode + `/peer/confirm`. No relay
 * private keys leave any container.
 *
 * STOPGAP — pending packaged `motebit federation mesh <url1> <url2> …`
 * CLI primitive that generalizes this for N>2 relays. Sibling to the
 * `motebit federation peer-remove <url>` follow-up. See
 * `memory/cli_peer_remove_followup.md` for the full federation-CLI arc.
 *
 * Single-operator caveat: all four staging relays run in one fly account,
 * so this validates orchestration code paths but NOT vote independence.
 * Vote independence is a multi-operator property (see
 * `operator_transparency_stage_2_deferred`).
 *
 * Run: node scripts/staging-federation-mesh.mjs
 */

const RELAYS = {
  stg: "https://motebit-sync-stg.fly.dev",
  "stg-b": "https://motebit-sync-stg-b.fly.dev",
  "stg-c": "https://motebit-sync-stg-c.fly.dev",
  "stg-d": "https://motebit-sync-stg-d.fly.dev",
};

const PAIRS = [
  ["stg", "stg-b"],
  ["stg", "stg-c"],
  ["stg", "stg-d"],
  ["stg-b", "stg-c"],
  ["stg-b", "stg-d"],
  ["stg-c", "stg-d"],
];

function randomNonceHex() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`POST ${url} → ${res.status}: ${err}`);
  }
  return res.json();
}

async function peerPair(aName, bName) {
  const aUrl = RELAYS[aName];
  const bUrl = RELAYS[bName];
  console.log(`\n→ ${aName} ↔ ${bName}`);

  const [aId, bId] = await Promise.all([
    getJson(`${aUrl}/federation/v1/identity`),
    getJson(`${bUrl}/federation/v1/identity`),
  ]);

  const nonceFromA = randomNonceHex();
  const proposeAtoB = await postJson(`${bUrl}/federation/v1/peer/propose`, {
    relay_id: aId.relay_motebit_id,
    public_key: aId.public_key,
    endpoint_url: aUrl,
    display_name: `${aName} (mesh)`,
    nonce: nonceFromA,
  });

  const nonceFromB = randomNonceHex();
  const proposeBtoA = await postJson(`${aUrl}/federation/v1/peer/propose`, {
    relay_id: bId.relay_motebit_id,
    public_key: bId.public_key,
    endpoint_url: bUrl,
    display_name: `${bName} (mesh)`,
    nonce: nonceFromB,
  });

  // Self-propose oracle: A signs B's nonce; B signs A's nonce.
  const oracleA = await postJson(`${aUrl}/federation/v1/peer/propose`, {
    relay_id: aId.relay_motebit_id,
    public_key: aId.public_key,
    endpoint_url: aUrl,
    nonce: proposeAtoB.nonce,
  });

  const oracleB = await postJson(`${bUrl}/federation/v1/peer/propose`, {
    relay_id: bId.relay_motebit_id,
    public_key: bId.public_key,
    endpoint_url: bUrl,
    nonce: proposeBtoA.nonce,
  });

  await postJson(`${bUrl}/federation/v1/peer/confirm`, {
    relay_id: aId.relay_motebit_id,
    challenge_response: oracleA.challenge,
  });

  await postJson(`${aUrl}/federation/v1/peer/confirm`, {
    relay_id: bId.relay_motebit_id,
    challenge_response: oracleB.challenge,
  });

  console.log(`  ✓ ${aName} ↔ ${bName} active`);
}

async function main() {
  console.log("K4 mesh-peering four staging relays for §6.2 ≥3-peer quorum.");
  console.log("Single-operator caveat: validates orchestration code, NOT vote independence.\n");

  const results = [];
  for (const [a, b] of PAIRS) {
    try {
      await peerPair(a, b);
      results.push({ pair: `${a}↔${b}`, status: "active" });
    } catch (e) {
      console.error(`  ✗ ${a} ↔ ${b}: ${e.message}`);
      results.push({ pair: `${a}↔${b}`, status: "failed", error: e.message });
    }
  }

  console.log("\n— Summary —");
  for (const r of results) {
    console.log(`  ${r.status === "active" ? "✓" : "✗"} ${r.pair} : ${r.status}`);
  }
  const failed = results.filter((r) => r.status !== "active");
  if (failed.length > 0) {
    console.error(`\n${failed.length}/${results.length} pairs failed`);
    process.exit(1);
  }
  console.log(
    "\n✓ K4 mesh active. Verify with /federation/v1/peers on each relay (each should show 3 active others).",
  );
}

main().catch((e) => {
  console.error(`\n✗ FATAL: ${e.message}`);
  process.exit(1);
});
