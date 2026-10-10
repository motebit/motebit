/**
 * `motebit federation ...` subcommands — status, peers, peering handshake,
 * un-peering, and N-relay mesh setup.
 *
 * `runPeerHandshake` is the protocol primitive: walks two relays through
 * propose → operator-minted confirm (relay-federation@1.5 §3.1; self-propose
 * is refused) → confirm, each half on the token of the relay it confirms. Consumed by `handleFederationPeer` (we-as-A)
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
  /** True when only a's half ran (b now holds a active; b's operator runs the reverse). */
  half?: boolean;
  /** Step name when ok=false: "identity-a" | "identity-b" | "propose-a-to-b" | ... */
  step?: string;
  error?: string;
  aId?: string;
  bId?: string;
}

/**
 * Peering handshake between two relays via their APIs (relay-federation@1.5 §3.1).
 *
 * Self-propose is refused since 1.5, so a relay's step-3 confirm is minted
 * only on its OPERATOR's authority — the master-token
 * `POST /api/v1/admin/federation/peer-confirm-signature`. Each half of the
 * handshake therefore needs the token of the relay whose confirm it carries:
 *   1. Fetch identity from a + b
 *   2. Propose a→b (b stores a as pending, returns b's nonce for a)
 *   3. a's operator mints a's confirm over that nonce; confirm a on b
 *      — b now holds a as an active peer.
 *   4. With b's token too: propose b→a, b's operator mints b's confirm,
 *      confirm b on a — both hold each other active. Without it the result
 *      is `half: true` and b's operator runs the reverse.
 *
 * Silent — caller logs. Returns step+error on failure for caller-side framing.
 */
async function runPeerHandshake(
  a: { url: string; headers: Record<string, string> },
  b: { url: string; headers?: Record<string, string> },
  opts?: { aDisplayName?: string; bDisplayName?: string },
): Promise<PeerHandshakeResult> {
  const aIdRes = await fetchRelayJson(`${a.url}/federation/v1/identity`, {});
  if (!aIdRes.ok) return { ok: false, step: "identity-a", error: aIdRes.error };
  const bIdRes = await fetchRelayJson(`${b.url}/federation/v1/identity`, {});
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

  // a's half: b stores a as pending and answers with the nonce a must sign.
  const proposeAtoB = await postProposal(b.url, aId, a.url, opts?.aDisplayName);
  if (!proposeAtoB.ok) return ret("propose-a-to-b", proposeAtoB.error);
  const confirmA = await postOperatorConfirm(a.url, a.headers, proposeAtoB.nonce);
  if (!confirmA.ok) return ret("operator-confirm-a", confirmA.error);
  const confirmAonB = await postConfirm(b.url, aId.relay_motebit_id, confirmA.challenge);
  if (!confirmAonB.ok) return ret("confirm-a-on-b", confirmAonB.error);

  if (b.headers === undefined) {
    return { ok: true, half: true, aId: aId.relay_motebit_id, bId: bId.relay_motebit_id };
  }

  // b's half, on b's operator's authority.
  const proposeBtoA = await postProposal(a.url, bId, b.url, opts?.bDisplayName);
  if (!proposeBtoA.ok) return ret("propose-b-to-a", proposeBtoA.error);
  const confirmB = await postOperatorConfirm(b.url, b.headers, proposeBtoA.nonce);
  if (!confirmB.ok) return ret("operator-confirm-b", confirmB.error);
  const confirmBonA = await postConfirm(a.url, bId.relay_motebit_id, confirmB.challenge);
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

/** The relay's own step-3 confirm over `nonce`, minted on its operator's authority (§3.1). */
async function postOperatorConfirm(
  relayUrl: string,
  headers: Record<string, string>,
  nonce: string,
): Promise<{ ok: true; challenge: string } | { ok: false; error: string }> {
  const res = await fetch(`${relayUrl}/api/v1/admin/federation/peer-confirm-signature`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ nonce }),
  });
  if (!res.ok) return { ok: false, error: `${String(res.status)} ${await res.text()}` };
  const body = (await res.json()) as { challenge_response: string };
  return { ok: true, challenge: body.challenge_response };
}

/** `Authorization` headers from a bare master token, or undefined when none is set. */
function bearer(token: string | undefined): Record<string, string> | undefined {
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

export async function handleFederationPeer(config: CliConfig): Promise<void> {
  const peerUrl = config.positionals[2];
  if (!peerUrl) {
    console.error("Usage: motebit federation peer <relay-url>");
    process.exit(1);
  }
  const relayUrl = getRelayUrl(config);
  const peerEndpoint = peerUrl.replace(/\/+$/, "");

  // Our confirm is minted on our operator's authority (relay-federation@1.5
  // §3.1); the peer's needs the peer operator's token, when we hold it.
  const ownHeaders = await getRelayAuthHeaders(config);
  const peerHeaders = bearer(process.env["MOTEBIT_PEER_API_TOKEN"]);

  console.log(`Peering ${relayUrl} ↔ ${peerEndpoint}\n`);
  const result = await runPeerHandshake(
    { url: relayUrl, headers: ownHeaders },
    { url: peerEndpoint, headers: peerHeaders },
  );
  if (!result.ok) {
    console.error(`Peering failed at step ${result.step ?? "unknown"}: ${result.error ?? ""}`);
    process.exit(1);
  }
  console.log(`  Our relay:  ${result.aId!.slice(0, 16)}...`);
  console.log(`  Peer relay: ${result.bId!.slice(0, 16)}...`);
  if (result.half) {
    console.log(
      `\nThe peer now holds us as an active peer. Its operator completes the other half with:\n  motebit federation peer ${relayUrl}\n(or re-run this with MOTEBIT_PEER_API_TOKEN set to the peer's master token).`,
    );
    return;
  }
  console.log(`\nPeered successfully. Both relays are now active peers.`);
}

/**
 * `motebit federation peer-remove <peer-url>` — un-peer this relay from
 * a remote peer. Sibling to `handleFederationPeer`.
 *
 * Three HTTP calls:
 *   1. The PEER's public identity, for its relay id.
 *   2. Admin-authed GET to OUR relay, which mints a v2 `peer-remove` message
 *      (relay-federation@1.5 §3.3) for that ONE recipient — good at that peer
 *      only, once, within five minutes.
 *   3. Unauth'd POST to the PEER's /federation/v1/peer/remove with
 *      `{ message }` — the signed message itself is the auth.
 *
 * The split exists because the signing key lives on our relay (in its DB),
 * not on the operator's CLI host. The admin gate sits on (2) only.
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

  const peerId = await fetchRelayJson(`${peerEndpoint}/federation/v1/identity`, {});
  if (!peerId.ok) {
    console.error(`Failed to read the peer's identity: ${peerId.error}`);
    process.exit(1);
  }
  const recipient = (peerId.data as { relay_motebit_id: string }).relay_motebit_id;

  const headers = await getRelayAuthHeaders(config);
  const sigRes = await fetchRelayJson(
    `${relayUrl}/api/v1/admin/federation/peer-removal-signature?recipient=${encodeURIComponent(recipient)}`,
    headers,
  );
  if (!sigRes.ok) {
    console.error(`Failed to mint removal message: ${sigRes.error}`);
    process.exit(1);
  }
  const { relay_id, message } = sigRes.data as { relay_id: string; message: unknown };
  console.log(`  Our relay: ${relay_id.slice(0, 16)}...`);

  const removeRes = await fetch(`${peerEndpoint}/federation/v1/peer/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
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
 * n=4) to any N≥2. Each pair uses the same propose → operator-minted
 * confirm → `/peer/confirm` flow as `handleFederationPeer`, so every relay's
 * master token is needed: `MOTEBIT_MESH_TOKENS` (comma-separated, one per
 * URL, in order), else the configured relay token for all. Per-pair failure
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

  // Each relay's confirm is minted by its operator (relay-federation@1.5 §3.1).
  const meshTokens = (process.env["MOTEBIT_MESH_TOKENS"] ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  if (meshTokens.length > 0 && meshTokens.length !== urls.length) {
    console.error(
      `MOTEBIT_MESH_TOKENS has ${String(meshTokens.length)} token(s) for ${String(urls.length)} URL(s); give one per URL, in order.`,
    );
    process.exit(1);
  }
  const fallback = await getRelayAuthHeaders(config);
  const headersFor = (url: string): Record<string, string> =>
    bearer(meshTokens[urls.indexOf(url)]) ?? fallback;

  const results: Array<{ pair: string; ok: boolean; step?: string; error?: string }> = [];
  for (const [a, b] of pairs) {
    const label = `${shortUrl(a)} ↔ ${shortUrl(b)}`;
    const r = await runPeerHandshake(
      { url: a, headers: headersFor(a) },
      { url: b, headers: headersFor(b) },
    );
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
