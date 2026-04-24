/**
 * `motebit federation ...` subcommands — status, peers, and the
 * peer-confirm dance (propose + challenge + confirm on both sides).
 *
 * `handleFederationPeer` is the most involved handler: it walks both
 * relays through propose → oracle signature extraction → bidirectional
 * confirm so the two relays end in mutually-active peering.
 */

import type { CliConfig } from "../args.js";
import { fetchRelayJson, getRelayAuthHeaders, getRelayUrl } from "./_helpers.js";

export async function handleFederationStatus(config: CliConfig): Promise<void> {
  const relayUrl = getRelayUrl(config);
  const result = await fetchRelayJson(`${relayUrl}/federation/v1/identity`, {});
  if (!result.ok) {
    console.error(`Failed to get relay identity: ${result.error}`);
    process.exit(1);
  }
  const id = result.data as {
    relay_motebit_id: string;
    public_key: string;
    did: string;
    spec: string;
  };
  console.log(`Relay Identity`);
  console.log(`  ID:   ${id.relay_motebit_id}`);
  console.log(`  DID:  ${id.did}`);
  console.log(`  Key:  ${id.public_key.slice(0, 16)}...`);
  console.log(`  Spec: ${id.spec}`);
}

export async function handleFederationPeers(config: CliConfig): Promise<void> {
  const relayUrl = getRelayUrl(config);
  const headers = await getRelayAuthHeaders(config);
  const result = await fetchRelayJson(`${relayUrl}/federation/v1/peers`, headers);
  if (!result.ok) {
    console.error(`Failed to list peers: ${result.error}`);
    process.exit(1);
  }
  const { peers } = result.data as {
    peers: Array<{
      peer_relay_id: string;
      state: string;
      endpoint_url: string;
      display_name: string | null;
      trust_score: number;
      agent_count: number;
    }>;
  };
  if (peers.length === 0) {
    console.log("No peers. Use `motebit federation peer <url>` to add one.");
    return;
  }
  console.log(`${String(peers.length)} peer(s):\n`);
  for (const p of peers) {
    const name = p.display_name ?? p.peer_relay_id.slice(0, 16);
    console.log(
      `  ${name}  ${p.state}  trust=${p.trust_score.toFixed(2)}  agents=${String(p.agent_count)}  ${p.endpoint_url}`,
    );
  }
}

export async function handleFederationPeer(config: CliConfig): Promise<void> {
  const peerUrl = config.positionals[2];
  if (!peerUrl) {
    console.error("Usage: motebit federation peer <relay-url>");
    process.exit(1);
  }
  const relayUrl = getRelayUrl(config);
  const peerEndpoint = peerUrl.replace(/\/+$/, "");

  console.log(`Peering ${relayUrl} ↔ ${peerEndpoint}\n`);

  // 1. Get both identities
  const [ourIdRes, peerIdRes] = await Promise.all([
    fetchRelayJson(`${relayUrl}/federation/v1/identity`, {}),
    fetchRelayJson(`${peerEndpoint}/federation/v1/identity`, {}),
  ]);
  if (!ourIdRes.ok) {
    console.error(`Cannot reach our relay: ${ourIdRes.error}`);
    process.exit(1);
  }
  if (!peerIdRes.ok) {
    console.error(`Cannot reach peer relay: ${peerIdRes.error}`);
    process.exit(1);
  }

  const ourId = ourIdRes.data as { relay_motebit_id: string; public_key: string };
  const peerId = peerIdRes.data as { relay_motebit_id: string; public_key: string };
  console.log(`  Our relay:  ${ourId.relay_motebit_id.slice(0, 16)}...`);
  console.log(`  Peer relay: ${peerId.relay_motebit_id.slice(0, 16)}...`);

  // 2. Propose: us → peer
  const nonce1 = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const propose1 = await fetch(`${peerEndpoint}/federation/v1/peer/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      relay_id: ourId.relay_motebit_id,
      public_key: ourId.public_key,
      endpoint_url: relayUrl,
      nonce: nonce1,
    }),
  });
  if (!propose1.ok) {
    const err = await propose1.text();
    console.error(`Propose to peer failed: ${err}`);
    process.exit(1);
  }
  const proposeBody1 = (await propose1.json()) as { nonce: string; challenge: string };
  console.log("  ✓ Proposed to peer");

  // 3. Propose: peer → us (so we have them as pending too)
  const nonce2 = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const propose2 = await fetch(`${relayUrl}/federation/v1/peer/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      relay_id: peerId.relay_motebit_id,
      public_key: peerId.public_key,
      endpoint_url: peerEndpoint,
      nonce: nonce2,
    }),
  });
  if (!propose2.ok) {
    const err = await propose2.text();
    console.error(`Propose to our relay failed: ${err}`);
    process.exit(1);
  }
  const proposeBody2 = (await propose2.json()) as { nonce: string; challenge: string };
  console.log("  ✓ Proposed to our relay");

  // 4. Self-propose to extract each relay's signature over its own
  //    relay_id + the peer's nonce. The relay's confirm endpoint
  //    binds the challenge to `relay_id:nonce:SUITE`, so a dummy
  //    proposer cannot stand in — the signature must be over the
  //    real relay_id, which only the relay's own propose path will
  //    produce. Mirrors the federation-e2e test's self-propose
  //    pattern (services/api/src/__tests__/federation-e2e.test.ts).
  const oracle1 = await fetch(`${relayUrl}/federation/v1/peer/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      relay_id: ourId.relay_motebit_id,
      public_key: ourId.public_key,
      endpoint_url: relayUrl,
      nonce: proposeBody1.nonce, // peer's nonce — our relay will sign it
    }),
  });
  if (!oracle1.ok) {
    console.error("Failed to get signature from our relay");
    process.exit(1);
  }
  const oracleBody1 = (await oracle1.json()) as { challenge: string };

  const oracle2 = await fetch(`${peerEndpoint}/federation/v1/peer/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      relay_id: peerId.relay_motebit_id,
      public_key: peerId.public_key,
      endpoint_url: peerEndpoint,
      nonce: proposeBody2.nonce, // our nonce — peer will sign it
    }),
  });
  if (!oracle2.ok) {
    console.error("Failed to get signature from peer relay");
    process.exit(1);
  }
  const oracleBody2 = (await oracle2.json()) as { challenge: string };

  // 5. Confirm on both sides
  const confirm1 = await fetch(`${peerEndpoint}/federation/v1/peer/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      relay_id: ourId.relay_motebit_id,
      challenge_response: oracleBody1.challenge,
    }),
  });
  if (!confirm1.ok) {
    const err = await confirm1.text();
    console.error(`Confirm on peer failed: ${err}`);
    process.exit(1);
  }
  console.log("  ✓ Confirmed on peer");

  const confirm2 = await fetch(`${relayUrl}/federation/v1/peer/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      relay_id: peerId.relay_motebit_id,
      challenge_response: oracleBody2.challenge,
    }),
  });
  if (!confirm2.ok) {
    const err = await confirm2.text();
    console.error(`Confirm on our relay failed: ${err}`);
    process.exit(1);
  }
  console.log("  ✓ Confirmed on our relay");

  console.log(`\nPeered successfully. Both relays are now active peers.`);
}
