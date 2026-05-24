/**
 * demo-migration — a runnable proof of the sovereignty thesis.
 *
 *   pnpm demo-migration
 *
 * Stands up two independent motebit relays in-process, registers an agent on
 * the first, and has the agent pick up its identity + reputation and walk to
 * the second — narrating each step. The destination relay verifies the source
 * relay's signed token against a pinned key (trusting neither the agent's
 * self-report nor a fetched key), then onboards the agent. The whole thing runs
 * with `@motebit/runtime`'s `performMigration` — the same code path a real
 * agent uses.
 *
 * This is the visceral demonstration that motebit's "you own your identity, you
 * can leave" is executable, not a slogan: a sovereign migration verified by a
 * party that trusts no one.
 */
import { createSyncRelay } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import { performMigration } from "@motebit/runtime";
import { generateKeypair, bytesToHex, deriveSovereignMotebitId } from "@motebit/crypto";

const API_TOKEN = "demo-token";
const SOURCE_URL = "http://relay-alpha.demo";
const DEST_URL = "http://relay-beta.demo";
const X402 = {
  payToAddress: "0x0000000000000000000000000000000000000000",
  network: "eip155:84532",
  testnet: true,
} as const;

function say(line = ""): void {
  process.stdout.write(line + "\n");
}
function step(n: number, title: string): void {
  say(`\n  [${n}] ${title}`);
}

async function main(): Promise<void> {
  say("════════════════════════════════════════════════════════════════");
  say("  motebit — sovereign relay migration");
  say("  An agent leaves one relay for another, identity + reputation intact.");
  say("════════════════════════════════════════════════════════════════");

  // Two independent relays, run by (imagine) two different operators.
  const alpha: SyncRelay = await createSyncRelay({
    apiToken: API_TOKEN,
    x402: X402,
    federation: { endpointUrl: SOURCE_URL },
  });
  const beta: SyncRelay = await createSyncRelay({ apiToken: API_TOKEN, x402: X402 });
  say(
    `\n  Relay ALPHA (${SOURCE_URL}) and Relay BETA (${DEST_URL}) are live — separate operators, separate databases.`,
  );

  try {
    // The agent: its own Ed25519 identity. The relay never holds this key. Its
    // motebit_id IS the sovereign commitment to that key — so any relay can bind
    // key↔id offline, trusting no one.
    const agent = await generateKeypair();
    const agentPubHex = bytesToHex(agent.publicKey);
    const motebitId = await deriveSovereignMotebitId(agentPubHex);
    const auth = { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" };

    step(1, "A sovereign agent 'nomad' lives on Relay ALPHA");
    await alpha.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        motebit_id: motebitId,
        endpoint_url: "https://nomad.example/mcp",
        capabilities: ["web_search", "summarize"],
        public_key: agentPubHex,
      }),
    });
    say(`      Registered on ALPHA. motebit_id ${motebitId} = sha256(public key).`);

    step(2, "Relay BETA learns ALPHA's identity (federation handshake → pinned key)");
    const wk = await alpha.app.request("/.well-known/motebit.json");
    const meta = (await wk.json()) as { relay_id: string; public_key: string };
    beta.moteDb.db
      .prepare(
        `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, nonce, missed_heartbeats, agent_count, trust_score, peer_protocol_version)
         VALUES (?, ?, ?, ?, 'active', ?, 0, 0, 0.5, ?)`,
      )
      .run(meta.relay_id, meta.public_key, SOURCE_URL, "Relay Alpha", null, "1.0");
    say(
      `      BETA pinned ALPHA's key ${meta.public_key.slice(0, 16)}… — it will trust ALPHA's signatures, nothing else.`,
    );

    step(3, "nomad migrates ALPHA → BETA (one call: performMigration)");
    // Route the agent's fetch into the two in-process relays.
    const routedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(SOURCE_URL))
        return alpha.app.request(url.slice(SOURCE_URL.length) || "/", init);
      if (url.startsWith(DEST_URL))
        return beta.app.request(url.slice(DEST_URL.length) || "/", init);
      return new Response("no route", { status: 404 });
    }) as typeof globalThis.fetch;

    say("      → ALPHA issues a signed MigrationToken (authorization to leave)");
    say("      → ALPHA signs a DepartureAttestation (nomad's history: trust + task counts)");
    say("      → ALPHA exports nomad's credential bundle; nomad SIGNS it itself");
    say("      → nomad presents token + attestation + bundle to BETA");

    const result = await performMigration({
      sourceRelayUrl: SOURCE_URL,
      destRelayUrl: DEST_URL,
      motebitId,
      publicKeyHex: agentPubHex,
      signingPrivateKey: agent.privateKey,
      sourceAuth: API_TOKEN,
      reason: "moving to a relay I trust more",
      fetch: routedFetch,
    });

    if (!result.ok) {
      say(`\n  ✗ Migration failed at the '${result.step}' step: ${result.reason}`);
      process.exitCode = 1;
      return;
    }

    step(4, "BETA verified ALPHA's token, bound nomad's key to its id, and onboarded it");
    const discover = await beta.app.request(`/api/v1/discover/${motebitId}`);
    const found = ((await discover.json()) as { found: boolean }).found;
    say(`      nomad is now discoverable on BETA: ${found ? "YES" : "NO"}`);

    say("\n────────────────────────────────────────────────────────────────");
    say("  What just happened");
    say("────────────────────────────────────────────────────────────────");
    say("  • nomad moved relays carrying its identity (same motebit_id + key)");
    say("    and its relay-attested reputation — no re-earning trust from zero.");
    say("  • BETA trusted NEITHER nomad's self-report NOR a key fetched over the");
    say("    wire — only ALPHA's signature against a key it had pinned, plus the");
    say("    math binding nomad's key to its id and nomad's own bundle signature.");
    say("    A stolen token under a different key would fail the binding check.");
    say("  • The agent owns the key; the relays are interchangeable. That is the");
    say("    moat no agent platform with a vendor-owned identity layer can copy.");
    say("════════════════════════════════════════════════════════════════\n");
  } finally {
    await alpha.close();
    await beta.close();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`demo-migration failed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
});
