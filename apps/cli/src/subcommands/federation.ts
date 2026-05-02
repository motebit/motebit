/**
 * `motebit federation ...` subcommands — status, peers, peering handshake,
 * un-peering, and N-relay mesh setup.
 *
 * `runPeerHandshake` is the protocol primitive: walks two relays through
 * propose → oracle signature extraction → bidirectional confirm so the two
 * end in mutually-active peering. Consumed by `handleFederationPeer` (we-as-A)
 * and `handleFederationMesh` (orchestrating arbitrary pairs from outside).
 * The helper is silent — each handler does its own logging.
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

function randomNonceHex(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface PeerHandshakeResult {
  ok: boolean;
  /** Step name when ok=false: "identity-a" | "identity-b" | "propose-a-to-b" | ... */
  step?: string;
  error?: string;
  aId?: string;
  bId?: string;
}

/**
 * Mutual peering handshake between two relays via their public APIs.
 *
 * No relay private keys cross the wire — each relay self-signs via its
 * /peer/propose self-mode. Mirrors federation-e2e's establishPeering:
 *   1. Fetch identity from a + b
 *   2. Propose a→b (b stores a as pending), propose b→a (a stores b as pending)
 *   3. Self-propose to extract each relay's signature over its own
 *      relay_id + the peer's nonce (the confirm endpoint binds the challenge
 *      to relay_id:nonce:SUITE; only the relay's own propose path produces it)
 *   4. Confirm on both sides
 *
 * Silent — caller logs. Returns step+error on failure for caller-side framing.
 */
async function runPeerHandshake(
  aUrl: string,
  bUrl: string,
  opts?: { aDisplayName?: string; bDisplayName?: string },
): Promise<PeerHandshakeResult> {
  const aIdRes = await fetchRelayJson(`${aUrl}/federation/v1/identity`, {});
  if (!aIdRes.ok) return { ok: false, step: "identity-a", error: aIdRes.error };
  const bIdRes = await fetchRelayJson(`${bUrl}/federation/v1/identity`, {});
  if (!bIdRes.ok) return { ok: false, step: "identity-b", error: bIdRes.error };

  const aId = aIdRes.data as { relay_motebit_id: string; public_key: string };
  const bId = bIdRes.data as { relay_motebit_id: string; public_key: string };
  const ret = (step: string, error: string): PeerHandshakeResult => ({
    ok: false,
    step,
    error,
    aId: aId.relay_motebit_id,
    bId: bId.relay_motebit_id,
  });

  // Cross-propose: each side stores the other as pending; each response
  // carries the target's stored nonce, which the proposer must later
  // self-sign to confirm.
  const proposeAtoB = await postProposal(bUrl, aId, aUrl, opts?.aDisplayName);
  if (!proposeAtoB.ok) return ret("propose-a-to-b", proposeAtoB.error);
  const proposeBtoA = await postProposal(aUrl, bId, bUrl, opts?.bDisplayName);
  if (!proposeBtoA.ok) return ret("propose-b-to-a", proposeBtoA.error);

  // Oracle: each relay self-signs (its own relay_id, the peer's nonce).
  // The confirm endpoint will verify `relay_id:nonce:SUITE` against the
  // relay's own public key — only the relay's own propose path produces it.
  const oracleA = await postProposal(aUrl, aId, aUrl, undefined, proposeAtoB.nonce);
  if (!oracleA.ok) return ret("oracle-a", oracleA.error);
  const oracleB = await postProposal(bUrl, bId, bUrl, undefined, proposeBtoA.nonce);
  if (!oracleB.ok) return ret("oracle-b", oracleB.error);

  const confirmAonB = await postConfirm(bUrl, aId.relay_motebit_id, oracleA.challenge);
  if (!confirmAonB.ok) return ret("confirm-a-on-b", confirmAonB.error);
  const confirmBonA = await postConfirm(aUrl, bId.relay_motebit_id, oracleB.challenge);
  if (!confirmBonA.ok) return ret("confirm-b-on-a", confirmBonA.error);

  return { ok: true, aId: aId.relay_motebit_id, bId: bId.relay_motebit_id };
}

type ProposalResult = { ok: true; nonce: string; challenge: string } | { ok: false; error: string };

async function postProposal(
  targetUrl: string,
  proposer: { relay_motebit_id: string; public_key: string },
  proposerEndpointUrl: string,
  displayName: string | undefined,
  nonce: string = randomNonceHex(),
): Promise<ProposalResult> {
  const res = await fetch(`${targetUrl}/federation/v1/peer/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      relay_id: proposer.relay_motebit_id,
      public_key: proposer.public_key,
      endpoint_url: proposerEndpointUrl,
      display_name: displayName,
      nonce,
    }),
  });
  if (!res.ok) return { ok: false, error: await res.text() };
  const body = (await res.json()) as { nonce: string; challenge: string };
  return { ok: true, nonce: body.nonce, challenge: body.challenge };
}

async function postConfirm(
  targetUrl: string,
  relayId: string,
  challengeResponse: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${targetUrl}/federation/v1/peer/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relay_id: relayId, challenge_response: challengeResponse }),
  });
  if (!res.ok) return { ok: false, error: await res.text() };
  return { ok: true };
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
  const result = await runPeerHandshake(relayUrl, peerEndpoint);
  if (!result.ok) {
    console.error(`Peering failed at step ${result.step ?? "unknown"}: ${result.error ?? ""}`);
    process.exit(1);
  }
  console.log(`  Our relay:  ${result.aId!.slice(0, 16)}...`);
  console.log(`  Peer relay: ${result.bId!.slice(0, 16)}...`);
  console.log(`\nPeered successfully. Both relays are now active peers.`);
}

/**
 * `motebit federation peer-remove <peer-url>` — un-peer this relay from
 * a remote peer. Sibling to `handleFederationPeer`.
 *
 * Two HTTP calls:
 *   1. Admin-authed GET to OUR relay's signing oracle, which returns
 *      this relay's signature over its own relay_motebit_id raw bytes.
 *   2. Unauth'd POST to the PEER's /federation/v1/peer/remove with that
 *      `{relay_id, signature}` — the signature itself is the auth.
 *
 * The split exists because the signing key lives on our relay (in its DB),
 * not on the operator's CLI host. The admin gate sits on (1) only —
 * (2)'s payload is what the protocol spec already defines.
 */
export async function handleFederationPeerRemove(config: CliConfig): Promise<void> {
  const peerUrl = config.positionals[2];
  if (!peerUrl) {
    console.error("Usage: motebit federation peer-remove <relay-url>");
    process.exit(1);
  }
  const relayUrl = getRelayUrl(config);
  const peerEndpoint = peerUrl.replace(/\/+$/, "");

  console.log(`Un-peering ${relayUrl} from ${peerEndpoint}\n`);

  const headers = await getRelayAuthHeaders(config);
  const sigRes = await fetchRelayJson(
    `${relayUrl}/api/v1/admin/federation/peer-removal-signature`,
    headers,
  );
  if (!sigRes.ok) {
    console.error(`Failed to mint removal signature: ${sigRes.error}`);
    process.exit(1);
  }
  const { relay_id, signature } = sigRes.data as { relay_id: string; signature: string };
  console.log(`  Our relay: ${relay_id.slice(0, 16)}...`);

  const removeRes = await fetch(`${peerEndpoint}/federation/v1/peer/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relay_id, signature }),
  });
  if (!removeRes.ok) {
    const err = await removeRes.text();
    console.error(`Peer rejected removal: ${err}`);
    process.exit(1);
  }
  console.log(`  ✓ Removed from peer's table`);
  console.log(`\nUn-peered. The peer no longer routes federation traffic to us.`);
}

/**
 * `motebit federation mesh <url1> <url2> ...` — pair-wise peer N relays.
 *
 * Generalizes the K4 staging mesh script (n-choose-2 = 6 handshakes for
 * n=4) to any N≥2. Each pair uses the same `/peer/propose` self-mode +
 * `/peer/confirm` flow as `handleFederationPeer`. Per-pair failure
 * isolation: a single failed handshake is reported in the summary, not
 * a fatal abort — operators bringing up federation meshes need to see
 * the full pair-grid status, not stop at the first transient hiccup.
 *
 * §6.2 + §6.5 (`spec/dispute-v1.md`) require ≥3-peer quorum for
 * adjudication, which means N=4 is the single-operator floor (each
 * leader sees 3 others). N=3 fails the floor: each leader would see
 * only 2 others, and §6.5 forbids self-adjudication when defendant.
 */
export async function handleFederationMesh(config: CliConfig): Promise<void> {
  const urls = config.positionals.slice(2).map((u) => u.replace(/\/+$/, ""));
  if (urls.length < 2) {
    console.error("Usage: motebit federation mesh <url1> <url2> [...urlN] (need ≥2)");
    process.exit(1);
  }

  // n choose 2 pairs — order-independent
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < urls.length; i++) {
    for (let j = i + 1; j < urls.length; j++) {
      pairs.push([urls[i]!, urls[j]!]);
    }
  }

  console.log(
    `Mesh-peering ${String(urls.length)} relay(s) — ${String(pairs.length)} pair handshake(s):\n`,
  );

  const results: Array<{ pair: string; ok: boolean; step?: string; error?: string }> = [];
  for (const [a, b] of pairs) {
    const label = `${shortUrl(a)} ↔ ${shortUrl(b)}`;
    const r = await runPeerHandshake(a, b);
    if (r.ok) {
      console.log(`  ✓ ${label}`);
      results.push({ pair: label, ok: true });
    } else {
      console.log(`  ✗ ${label} — ${r.step ?? "unknown"}: ${r.error ?? ""}`);
      results.push({ pair: label, ok: false, step: r.step, error: r.error });
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${String(results.length - failed.length)}/${String(results.length)} pair(s) active.`,
  );
  if (failed.length > 0) {
    console.error(`${String(failed.length)} pair(s) failed — see above.`);
    process.exit(1);
  }
  console.log("Mesh established. Verify with `motebit federation peers` on each relay.");
}

function shortUrl(url: string): string {
  // Drop scheme + .fly.dev / .com / etc tail for log readability
  return url.replace(/^https?:\/\//, "").replace(/\.(fly\.dev|com|org|net|io)$/, "");
}
