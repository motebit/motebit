/**
 * `motebit federation ...` subcommands — status, peers, peering handshake,
 * un-peering, and N-relay mesh setup.
 *
 * `runPeerHandshake` is the protocol primitive: walks two relays through the
 * v2 handshake in both directions — propose at the verifier, the PROVER's
 * operator-authenticated confirm signature, confirm at the verifier — so the
 * two end in mutually-active peering. Consumed by `handleFederationPeer` (we-as-A)
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
  /** Step name when ok=false: "identity-a" | "propose-a-to-b" | "sign-a" | "confirm-a-on-b" | ... */
  step?: string;
  error?: string;
  /** HTTP status of the failed step, when it was an HTTP refusal. */
  status?: number;
  aId?: string;
  bId?: string;
}

type Identity = { relay_motebit_id: string; public_key: string };
type StepResult = { ok: true } | { ok: false; step: string; error: string; status?: number };

/**
 * Handshake v2, one direction: `prover` peers ONTO `verifier`
 * (spec/relay-federation-v1.md §3).
 *   1. Propose at the verifier (public) → the verifier's nonce.
 *   2. Ask the PROVER's own relay — operator-authenticated — for its confirm
 *      signature over that nonce, naming the verifier and the prover's
 *      endpoint. Only the prover's operator can mint it.
 *   3. Confirm at the verifier (public) with the body the prover returned.
 */
async function peerOnto(
  prover: { url: string; id: Identity; authHeaders: Record<string, string> },
  verifier: { url: string; id: Identity },
  label: string,
  displayName?: string,
): Promise<StepResult> {
  const proposeRes = await fetch(`${verifier.url}/federation/v1/peer/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      handshake_version: "v2",
      relay_id: prover.id.relay_motebit_id,
      public_key: prover.id.public_key,
      endpoint_url: prover.url,
      display_name: displayName,
      nonce: randomNonceHex(),
    }),
  });
  if (!proposeRes.ok) {
    return {
      ok: false,
      step: `propose-${label}`,
      error: await proposeRes.text(),
      status: proposeRes.status,
    };
  }
  const { nonce } = (await proposeRes.json()) as { nonce: string };

  const signRes = await fetch(`${prover.url}/api/v1/admin/federation/peer-confirm-signature`, {
    method: "POST",
    headers: { ...prover.authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      verifier_relay_id: verifier.id.relay_motebit_id,
      nonce,
      endpoint_url: prover.url,
    }),
  });
  if (!signRes.ok) {
    return {
      ok: false,
      step: `sign-${label}`,
      error: await signRes.text(),
      status: signRes.status,
    };
  }
  const confirmBody = (await signRes.json()) as Record<string, unknown>;
  if (displayName !== undefined) confirmBody["display_name"] = displayName;

  const confirmRes = await fetch(`${verifier.url}/federation/v1/peer/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(confirmBody),
  });
  if (!confirmRes.ok) {
    return {
      ok: false,
      step: `confirm-${label}`,
      error: await confirmRes.text(),
      status: confirmRes.status,
    };
  }
  return { ok: true };
}

/**
 * Mutual peering between two relays: a onto b, then b onto a. Each direction's
 * confirm is minted by the PROVING relay's admin endpoint, so the caller needs
 * an operator token each relay accepts (`authA` / `authB`). With only one
 * relay's token, run it from each side (`motebit federation peer` on each).
 *
 * Silent — caller logs. Returns step+error on failure for caller-side framing.
 */
async function runPeerHandshake(
  aUrl: string,
  bUrl: string,
  authA: Record<string, string>,
  authB: Record<string, string>,
  opts?: { aDisplayName?: string; bDisplayName?: string },
): Promise<PeerHandshakeResult> {
  const aIdRes = await fetchRelayJson(`${aUrl}/federation/v1/identity`, {});
  if (!aIdRes.ok) return { ok: false, step: "identity-a", error: aIdRes.error };
  const bIdRes = await fetchRelayJson(`${bUrl}/federation/v1/identity`, {});
  if (!bIdRes.ok) return { ok: false, step: "identity-b", error: bIdRes.error };

  const aId = aIdRes.data as Identity;
  const bId = bIdRes.data as Identity;
  const ids = { aId: aId.relay_motebit_id, bId: bId.relay_motebit_id };

  const aOntoB = await peerOnto(
    { url: aUrl, id: aId, authHeaders: authA },
    { url: bUrl, id: bId },
    "a-on-b",
    opts?.aDisplayName,
  );
  if (!aOntoB.ok) return { ...aOntoB, ...ids };

  const bOntoA = await peerOnto(
    { url: bUrl, id: bId, authHeaders: authB },
    { url: aUrl, id: aId },
    "b-on-a",
    opts?.bDisplayName,
  );
  if (!bOntoA.ok) return { ...bOntoA, ...ids };
  return { ok: true, ...ids };
}

export async function handleFederationPeer(config: CliConfig): Promise<void> {
  const peerUrl = config.positionals[2];
  if (!peerUrl) {
    console.error("Usage: motebit federation peer <relay-url>");
    process.exit(1);
  }
  const relayUrl = getRelayUrl(config);
  const peerEndpoint = peerUrl.replace(/\/+$/, "");
  const auth = await getRelayAuthHeaders(config);

  console.log(`Peering ${relayUrl} ↔ ${peerEndpoint}\n`);
  // Our relay onto the peer (our operator token mints our confirm), then the
  // peer onto ours — which only succeeds if the same token is the peer's
  // operator token too (one operator running both relays).
  const result = await runPeerHandshake(relayUrl, peerEndpoint, auth, auth);
  if (
    !result.ok &&
    result.step === "sign-b-on-a" &&
    (result.status === 401 || result.status === 403)
  ) {
    console.log(`  Our relay:  ${result.aId!.slice(0, 16)}...`);
    console.log(`  Peer relay: ${result.bId!.slice(0, 16)}...`);
    console.log(
      `\nOur relay is now an active peer of ${peerEndpoint}. The reverse direction needs the peer's operator:` +
        `\n  they run \`motebit federation peer ${relayUrl}\` against their relay.`,
    );
    return;
  }
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
 * n=4) to any N≥2. Each pair uses the same v2 propose → admin confirm
 * signature → confirm flow as `handleFederationPeer`, with one operator token
 * every relay accepts. Per-pair failure
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

  // Each direction's confirm is minted by the proving relay's admin endpoint,
  // so a mesh is one operator's act: the operator token must be accepted by
  // every relay in the list.
  const auth = await getRelayAuthHeaders(config);

  console.log(
    `Mesh-peering ${String(urls.length)} relay(s) — ${String(pairs.length)} pair handshake(s):\n`,
  );

  const results: Array<{ pair: string; ok: boolean; step?: string; error?: string }> = [];
  for (const [a, b] of pairs) {
    const label = `${shortUrl(a)} ↔ ${shortUrl(b)}`;
    const r = await runPeerHandshake(a, b, auth, auth);
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
